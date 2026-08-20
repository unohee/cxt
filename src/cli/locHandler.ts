// ============================================
// ctx - LOC Handler
// Created: 2026-05-18
// Purpose: `cxt loc` 커맨드 — 파일별 LOC 리포트
// ============================================

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, extname, relative, resolve } from 'node:path';
import { buildIgnoreConfig, shouldSkipDir } from '../registry/ignoreRules.js';
import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { resolveProjectId } from './checkHandler.js';
import { escapeTerminal, isPathWithin, pathMatchesDir, resolveProjectDirFilter } from './outputSafety.js';

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

// 지원 확장자 (entityScanner와 동일 범위)
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go',
  '.rs',
  '.java',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp',
  '.cs',
]);

interface LocOpts {
  dir?: string;
  ext?: string;
  noBlank?: boolean;
  noComments?: boolean;
  entities?: boolean;
  project?: string;
}

interface FileLocResult {
  filePath: string;    // relative to project root
  total: number;       // raw LOC
  code: number;        // after blank/comment removal (= total if no flags)
  blank: number;
  comment: number;
  entityCount: number; // -1 = not scanned
}

// ============ LOC 계산 ============

const COMMENT_PREFIXES_BY_EXT: Record<string, string[]> = {
  '.ts': ['//', '/*', '*', '*/'],
  '.tsx': ['//', '/*', '*', '*/'],
  '.js': ['//', '/*', '*', '*/'],
  '.jsx': ['//', '/*', '*', '*/'],
  '.mjs': ['//', '/*', '*', '*/'],
  '.cjs': ['//', '/*', '*', '*/'],
  '.go': ['//', '/*', '*', '*/'],
  '.rs': ['//', '/*', '*', '*/'],
  '.java': ['//', '/*', '*', '*/'],
  '.c': ['//', '/*', '*', '*/'],
  '.cpp': ['//', '/*', '*', '*/'],
  '.cc': ['//', '/*', '*', '*/'],
  '.cxx': ['//', '/*', '*', '*/'],
  '.h': ['//', '/*', '*', '*/'],
  '.hpp': ['//', '/*', '*', '*/'],
  '.cs': ['//', '/*', '*', '*/'],
  '.py': ['#'],
  '.pyw': ['#'],
};

function canStartRegexLiteral(beforeSlash: string, lastSignificant: string | undefined): boolean {
  if (lastSignificant === undefined || /[=(:,!&|?{};\[+*%~<>/]/.test(lastSignificant)) return true;
  const prefix = beforeSlash.trimEnd();
  if (prefix.endsWith('=>')) return true;
  if (/(?:^|\s)(?:return|throw|case|await|typeof|delete|void|new|in|of|else|do)\s*$/.test(prefix)) return true;
  if (/(?:^|\s)yield\s*\*?\s*$/.test(prefix)) return true;
  if (!prefix.endsWith(')')) return false;
  let depth = 0;
  for (let i = prefix.length - 1; i >= 0; i--) {
    if (prefix[i] === ')') depth++;
    else if (prefix[i] === '(' && --depth === 0) {
      return /(?:^|[;{}])\s*(?:if|while|for|with)\s*$/.test(prefix.slice(0, i));
    }
  }
  return false;
}

export function countLines(content: string, ext: string): { total: number; blank: number; comment: number } {
  const lines = content === '' ? [] : content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const prefixes = COMMENT_PREFIXES_BY_EXT[ext] ?? [];
  let blank = 0;
  let comment = 0;

  let inBlockComment = false;
  let lastSignificant: string | undefined;
  let controlParenDepth: number | undefined;
  let afterControlHead = false;
  let recentWord = '';
  type LexMode = { kind: 'string'; quote: "'" | '"' } | { kind: 'template' } | { kind: 'expression'; braces: number };
  const modes: LexMode[] = [];
  let escaped = false;
  const hasBlockComments = prefixes.includes('/*');
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      blank++;
    } else if (!hasBlockComments) {
      if (prefixes.some(p => line.startsWith(p))) comment++;
    } else {
      let hasCode = false;
      let hasComment = false;
      let inRegex = false;
      let regexCharClass = false;
      let regexEscaped = false;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        const next = raw[i + 1];
        if (inBlockComment) {
          hasComment = true;
          if (ch === '*' && next === '/') { inBlockComment = false; i++; }
          continue;
        }
        if (inRegex) {
          hasCode = true;
          if (regexEscaped) regexEscaped = false;
          else if (ch === '\\') regexEscaped = true;
          else if (ch === '[') regexCharClass = true;
          else if (ch === ']') regexCharClass = false;
          else if (ch === '/' && !regexCharClass) { inRegex = false; lastSignificant = 'r'; }
          continue;
        }
        const mode = modes.at(-1);
        if (mode?.kind === 'string') {
          hasCode = true;
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === mode.quote) { modes.pop(); lastSignificant = 's'; }
          continue;
        }
        if (mode?.kind === 'template') {
          hasCode = true;
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '`') { modes.pop(); lastSignificant = 's'; }
          else if (ch === '$' && next === '{') { modes.push({ kind: 'expression', braces: 1 }); i++; }
          continue;
        }
        if (ch === '"' || ch === "'") { modes.push({ kind: 'string', quote: ch }); recentWord = ''; afterControlHead = false; hasCode = true; continue; }
        if (ch === '`') { modes.push({ kind: 'template' }); recentWord = ''; afterControlHead = false; hasCode = true; continue; }
        if (ch === '/' && next === '/') { hasComment = true; break; }
        if (ch === '/' && next === '*') { hasComment = true; inBlockComment = true; i++; continue; }
        const beforeSlash = raw.slice(0, i).trimEnd();
        const followsCrossLineKeyword = /^(?:return|throw|case|yield|await|typeof|delete|void|new|in|of|else|do)$/.test(recentWord);
        if (ch === '/' && (afterControlHead || followsCrossLineKeyword || canStartRegexLiteral(beforeSlash, lastSignificant))) {
          inRegex = true;
          afterControlHead = false;
          recentWord = '';
          hasCode = true;
          continue;
        }
        if (mode?.kind === 'expression') {
          if (ch === '{') mode.braces++;
          else if (ch === '}' && --mode.braces === 0) { modes.pop(); hasCode = true; continue; }
        }
        if (ch === '(') {
          if (controlParenDepth !== undefined) controlParenDepth++;
          else if (/^(?:if|while|for|with)$/.test(recentWord) || /(?:^|\s)(?:if|while|for|with)\s*$/.test(beforeSlash)) controlParenDepth = 1;
        } else if (ch === ')' && controlParenDepth !== undefined && --controlParenDepth === 0) {
          controlParenDepth = undefined;
          afterControlHead = true;
        }
        if (!/\s/.test(ch)) {
          hasCode = true;
          lastSignificant = ch;
          if (afterControlHead && ch !== ')') afterControlHead = false;
          if (/[A-Za-z_]/.test(ch)) recentWord += ch;
          else recentWord = '';
        }
      }
      if (hasComment && !hasCode) comment++;
    }
  }

  return { total: lines.length, blank, comment };
}

// ============ 파일 수집 ============

async function collectFiles(
  dir: string,
  projectRoot: string,
  ignoreConfig: ReturnType<typeof buildIgnoreConfig>,
  extFilter: Set<string> | null,
  dirFilter: string | undefined,
  depth = 0,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true }) as Dirent[];
  } catch (error) {
    const rel = relative(projectRoot, dir) || '.';
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read source directory ${escapeTerminal(rel)}: ${escapeTerminal(detail)}`);
  }

  const files: string[] = [];

  for (const entry of entries) {
    const name = entry.name as string;
    const fullPath = join(dir, name);
    const relPath = relative(projectRoot, fullPath);

    if (entry.isDirectory()) {
      const parentRel = relative(projectRoot, dir);
      if (shouldSkipDir(name, parentRel, ignoreConfig)) continue;
      if (dirFilter && !pathMatchesDir(relPath, dirFilter) && !pathMatchesDir(dirFilter, relPath)) continue;
      files.push(...await collectFiles(fullPath, projectRoot, ignoreConfig, extFilter, dirFilter, depth + 1));
    } else if (entry.isFile()) {
      const ext = extname(name).toLowerCase();
      if (extFilter ? !extFilter.has(ext) : !SOURCE_EXTS.has(ext)) continue;
      if (dirFilter && !pathMatchesDir(relPath, dirFilter)) continue;

      try {
        const s = await stat(fullPath);
        if (s.size > 512 * 1024) throw new Error(`Source file exceeds LOC size limit: ${escapeTerminal(relPath)}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to stat source file ${escapeTerminal(relPath)}: ${escapeTerminal(detail)}`);
      }

      files.push(relPath);
    }
  }

  return files.sort();
}

// ============ 출력 ============

const BAR_WIDTH = 20;

function renderBar(fraction: number): string {
  const filled = Math.round(fraction * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function formatNum(n: number): string {
  return n.toLocaleString('en-US');
}

export async function handleLoc(opts: LocOpts): Promise<void> {
  const projectRoot = process.cwd();
  const scanRoot = resolve(projectRoot, opts.dir ?? '.');
  if (!isPathWithin(projectRoot, scanRoot)) {
    throw new Error(`Directory must be inside the project root: ${escapeTerminal(opts.dir)}`);
  }
  const [realProjectRoot, realScanRoot] = await Promise.all([realpath(projectRoot), realpath(scanRoot)]);
  if (!isPathWithin(realProjectRoot, realScanRoot)) {
    throw new Error(`Directory symlink must stay inside the project root: ${escapeTerminal(opts.dir)}`);
  }
  const ignoreConfig = buildIgnoreConfig(projectRoot);
  const dirFilter = resolveProjectDirFilter(projectRoot, opts.dir);

  // 확장자 필터
  const extFilter: Set<string> | null = opts.ext
    ? new Set(opts.ext.split(',').map(e => e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`))
    : null;

  // 파일 수집
  const filePaths = await collectFiles(
    scanRoot,
    projectRoot,
    ignoreConfig,
    extFilter,
    dirFilter,
  );

  if (filePaths.length === 0) {
    console.log(`\n${c.dim}No source files found${opts.dir ? ` under ${escapeTerminal(opts.dir)}` : ''}.${c.reset}\n`);
    return;
  }

  // LOC 계산
  const results: FileLocResult[] = [];

  for (const relPath of filePaths) {
    const ext = extname(relPath).toLowerCase();
    let content: string;
    try {
      content = await readFile(join(projectRoot, relPath), 'utf-8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read source file ${escapeTerminal(relPath)}: ${escapeTerminal(detail)}`);
    }

    const { total, blank, comment } = countLines(content, ext);
    results.push({
      filePath: relPath,
      total,
      blank,
      comment,
      code: total - blank - comment,
      entityCount: -1,
    });
  }

  if (results.length === 0) {
    console.log(`\n${c.dim}No source files could be read.${c.reset}\n`);
    return;
  }

  // 엔티티 수 병기 옵션
  if (opts.entities) {
    try {
      const store = getRegistryStore();
      const projectId = opts.project ?? resolveProjectId(projectRoot);
      // 파일별 엔티티 수 집계
      const entityCountByFile = new Map<string, number>();
      const pageSize = 5_000;
      for (let offset = 0; ; offset += pageSize) {
        const page = store.listEntities({ projectId, limit: pageSize, offset }).entities;
        for (const e of page) entityCountByFile.set(e.filePath, (entityCountByFile.get(e.filePath) ?? 0) + 1);
        if (page.length < pageSize) break;
      }

      for (const r of results) {
        r.entityCount = entityCountByFile.get(r.filePath) ?? 0;
      }
    } finally {
      closeRegistryStore();
    }
  }

  // 정렬: displayLoc(code) 내림차순
  const displayLoc = (r: FileLocResult) => opts.noBlank || opts.noComments
    ? (opts.noBlank && opts.noComments ? r.code : opts.noBlank ? r.total - r.blank : r.total - r.comment)
    : r.total;

  results.sort((a, b) => displayLoc(b) - displayLoc(a));

  const grandTotal = results.reduce((s, r) => s + displayLoc(r), 0);
  const maxLoc = displayLoc(results[0]);

  // 경로 최대 길이 (정렬용)
  const maxPathLen = Math.min(Math.max(...results.map(r => r.filePath.length)), 55);

  // ── 헤더 ──
  const filterNote = [
    opts.dir ? `dir: ${escapeTerminal(opts.dir)}` : '',
    opts.ext ? `ext: ${escapeTerminal(opts.ext)}` : '',
    opts.noBlank ? 'no-blank' : '',
    opts.noComments ? 'no-comments' : '',
  ].filter(Boolean).join(', ');

  const locLabel = opts.noBlank && opts.noComments ? 'code LOC'
    : opts.noBlank ? 'LOC (no blank)'
    : opts.noComments ? 'LOC (no comments)'
    : 'LOC';

  console.log(`\n${c.bold}File LOC Report${c.reset}${filterNote ? ` ${c.dim}(${escapeTerminal(filterNote)})${c.reset}` : ''} — ${results.length} files, ${c.bold}${formatNum(grandTotal)}${c.reset} total ${locLabel}`);
  console.log('─'.repeat(maxPathLen + BAR_WIDTH + 20));

  for (const r of results) {
    const loc = displayLoc(r);
    const pct = grandTotal > 0 ? (loc / grandTotal * 100).toFixed(1) : '0.0';
    const bar = renderBar(maxLoc > 0 ? loc / maxLoc : 0);
    const path = r.filePath.length > maxPathLen
      ? '…' + r.filePath.slice(-(maxPathLen - 1))
      : r.filePath;

    const entityPart = opts.entities && r.entityCount >= 0
      ? `  ${c.dim}[${r.entityCount}e]${c.reset}`
      : '';

    const locStr = formatNum(loc).padStart(6);
    const pctStr = `${pct}%`.padStart(6);
    const pathStr = escapeTerminal(path).padEnd(maxPathLen);

    console.log(`  ${c.cyan}${pathStr}${c.reset}  ${locStr}  ${c.dim}${bar}${c.reset}  ${pctStr}${entityPart}`);
  }

  console.log('─'.repeat(maxPathLen + BAR_WIDTH + 20));

  // 합계 행
  const totalStr = formatNum(grandTotal).padStart(6);
  console.log(`  ${'Total'.padEnd(maxPathLen)}  ${c.bold}${totalStr}${c.reset}`);

  // 상세 분석 (--no-blank 또는 --no-comments 활성 시)
  if (opts.noBlank || opts.noComments) {
    const rawTotal = results.reduce((s, r) => s + r.total, 0);
    const blankTotal = results.reduce((s, r) => s + r.blank, 0);
    const commentTotal = results.reduce((s, r) => s + r.comment, 0);
    const codeTotal = rawTotal - blankTotal - commentTotal;
    const percentage = (value: number): string => rawTotal === 0 ? '0.0' : (value / rawTotal * 100).toFixed(1);

    console.log();
    console.log(`  ${c.dim}Raw LOC:      ${formatNum(rawTotal).padStart(7)}${c.reset}`);
    console.log(`  ${c.dim}Blank lines:  ${formatNum(blankTotal).padStart(7)}  (${percentage(blankTotal)}%)${c.reset}`);
    console.log(`  ${c.dim}Comment lines:${formatNum(commentTotal).padStart(7)}  (${percentage(commentTotal)}%)${c.reset}`);
    console.log(`  ${c.dim}Code lines:   ${formatNum(codeTotal).padStart(7)}  (${percentage(codeTotal)}%)${c.reset}`);
  }

  console.log();
}
