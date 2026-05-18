// ============================================
// ctx - LOC Handler
// Created: 2026-05-18
// Purpose: `cxt loc` 커맨드 — 파일별 LOC 리포트
// ============================================

import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { buildIgnoreConfig, shouldSkipDir } from '../registry/ignoreRules.js';
import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { resolveProjectId } from './checkHandler.js';

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

function countLines(content: string, ext: string): { total: number; blank: number; comment: number } {
  const lines = content.split('\n');
  const prefixes = COMMENT_PREFIXES_BY_EXT[ext] ?? [];
  let blank = 0;
  let comment = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      blank++;
    } else if (prefixes.some(p => line.startsWith(p))) {
      comment++;
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
  if (depth > 15) return [];

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }

  const files: string[] = [];

  for (const entry of entries) {
    const name = entry.name as string;
    const fullPath = join(dir, name);
    const relPath = relative(projectRoot, fullPath);

    if (entry.isDirectory()) {
      const parentRel = relative(projectRoot, dir);
      if (shouldSkipDir(name, parentRel, ignoreConfig)) continue;
      if (dirFilter && !relPath.startsWith(dirFilter) && !dirFilter.startsWith(relPath)) continue;
      files.push(...await collectFiles(fullPath, projectRoot, ignoreConfig, extFilter, dirFilter, depth + 1));
    } else if (entry.isFile()) {
      const ext = extname(name).toLowerCase();
      if (extFilter ? !extFilter.has(ext) : !SOURCE_EXTS.has(ext)) continue;
      if (dirFilter && !relPath.startsWith(dirFilter)) continue;

      try {
        const s = await stat(fullPath);
        if (s.size > 512 * 1024) continue; // skip oversized files
      } catch {
        continue;
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
  const ignoreConfig = buildIgnoreConfig(projectRoot);

  // 확장자 필터
  const extFilter: Set<string> | null = opts.ext
    ? new Set(opts.ext.split(',').map(e => e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`))
    : null;

  // 파일 수집
  const filePaths = await collectFiles(
    opts.dir ? join(projectRoot, opts.dir) : projectRoot,
    projectRoot,
    ignoreConfig,
    extFilter,
    opts.dir,
  );

  if (filePaths.length === 0) {
    console.log(`\n${c.dim}No source files found${opts.dir ? ` under ${opts.dir}` : ''}.${c.reset}\n`);
    return;
  }

  // LOC 계산
  const results: FileLocResult[] = [];

  for (const relPath of filePaths) {
    const ext = extname(relPath).toLowerCase();
    let content: string;
    try {
      content = await readFile(join(projectRoot, relPath), 'utf-8');
    } catch {
      continue;
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
      const { entities } = store.listEntities({ projectId, limit: 100000, offset: 0 });

      // 파일별 엔티티 수 집계
      const entityCountByFile = new Map<string, number>();
      for (const e of entities) {
        entityCountByFile.set(e.filePath, (entityCountByFile.get(e.filePath) ?? 0) + 1);
      }

      for (const r of results) {
        r.entityCount = entityCountByFile.get(r.filePath) ?? 0;
      }
    } catch {
      // scan 안 됐어도 그냥 진행
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
    opts.dir ? `dir: ${opts.dir}` : '',
    opts.ext ? `ext: ${opts.ext}` : '',
    opts.noBlank ? 'no-blank' : '',
    opts.noComments ? 'no-comments' : '',
  ].filter(Boolean).join(', ');

  const locLabel = opts.noBlank && opts.noComments ? 'code LOC'
    : opts.noBlank ? 'LOC (no blank)'
    : opts.noComments ? 'LOC (no comments)'
    : 'LOC';

  console.log(`\n${c.bold}File LOC Report${c.reset}${filterNote ? ` ${c.dim}(${filterNote})${c.reset}` : ''} — ${results.length} files, ${c.bold}${formatNum(grandTotal)}${c.reset} total ${locLabel}`);
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
    const pathStr = path.padEnd(maxPathLen);

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

    console.log();
    console.log(`  ${c.dim}Raw LOC:      ${formatNum(rawTotal).padStart(7)}${c.reset}`);
    console.log(`  ${c.dim}Blank lines:  ${formatNum(blankTotal).padStart(7)}  (${(blankTotal / rawTotal * 100).toFixed(1)}%)${c.reset}`);
    console.log(`  ${c.dim}Comment lines:${formatNum(commentTotal).padStart(7)}  (${(commentTotal / rawTotal * 100).toFixed(1)}%)${c.reset}`);
    console.log(`  ${c.dim}Code lines:   ${formatNum(codeTotal).padStart(7)}  (${(codeTotal / rawTotal * 100).toFixed(1)}%)${c.reset}`);
  }

  console.log();
}
