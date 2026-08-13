// ============================================
// ctx - Ignore Rules
// Created: 2026-04-11
// Purpose: Scan exclusion rules from .gitignore, .cxtignore, and dependency files
// ============================================

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

// ============ Built-in skip dirs ============

export const BUILTIN_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.next', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  'coverage', '.turbo', '.cache', '.parcel-cache',
  'site-packages',
  'vendor', 'third_party',
  'target',    // Rust/Java
  'bin', 'obj', // C#
  'cmake-build-debug', 'cmake-build-release', // C/C++
  // build outputs
  'htmlcov', 'coverage_html',
  // containers
  'docker',
]);

export const BUILTIN_SKIP_PREFIXES = [
  '.venv',
  'build-',    // build-demo, build-prod, etc.
];

// ============ Dynamic ignore resolution ============

export interface IgnoreConfig {
  skipDirs: Set<string>;
  skipPrefixes: string[];
  skipPathPatterns: RegExp[];
  rules?: Array<{ regex: RegExp; negated: boolean; literalPrefix: string; directoryOnly: boolean; hasWildcard: boolean }>;
}

/**
 * Build ignore config for a project root.
 * Reads .gitignore, .cxtignore, and dependency manifests to auto-exclude
 * third-party, build, and legacy directories.
 */
export function buildIgnoreConfig(projectRoot: string): IgnoreConfig {
  const skipDirs = new Set(BUILTIN_SKIP_DIRS);
  const skipPrefixes = [...BUILTIN_SKIP_PREFIXES];
  const skipPathPatterns: RegExp[] = [];
  const rules: Array<{ regex: RegExp; negated: boolean; literalPrefix: string; directoryOnly: boolean; hasWildcard: boolean }> = [];

  // 1. .cxtignore — project-specific exclusions (same syntax as .gitignore)
  loadIgnoreFile(join(projectRoot, '.cxtignore'), skipDirs, skipPrefixes, skipPathPatterns, rules);

  // 2. .gitignore — parse for directory patterns
  loadIgnoreFile(join(projectRoot, '.gitignore'), skipDirs, skipPrefixes, skipPathPatterns, rules);

  // 3. Dependency manifests — auto-detect vendored/subproject dirs
  detectVendoredSubprojectDirs(projectRoot, skipDirs, skipPathPatterns);
  return { skipDirs, skipPrefixes, skipPathPatterns, rules };
}

/**
 * Check if a directory entry should be skipped.
 */
export function shouldSkipDir(
  dirName: string,
  relPath: string,
  config: IgnoreConfig,
): boolean {
  let skipped = config.skipDirs.has(dirName);

  // dot directories (hidden)
  if (dirName.startsWith('.') && dirName !== '.') skipped = true;

  // prefix match
  if (config.skipPrefixes.some(p => dirName.startsWith(p))) skipped = true;

  // path pattern match
  const fullRel = relPath ? `${relPath}/${dirName}` : dirName;
  if (config.skipPathPatterns.some(p => p.test(fullRel))) skipped = true;

  for (const rule of config.rules ?? []) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(fullRel)) skipped = !rule.negated;
  }

  // negated descendant가 있다면 부모를 순회해야 재포함 규칙을 평가할 수 있다.
  if (skipped && (config.rules ?? []).some((r) => {
    if (!r.negated) return false;
    if (r.literalPrefix.startsWith(`${fullRel}/`)) return true;
    return r.hasWildcard && (fullRel === r.literalPrefix || fullRel.startsWith(`${r.literalPrefix}/`));
  })) {
    return false;
  }

  return skipped;
}

/** ordered .cxtignore/.gitignore 규칙을 파일 상대 경로에 적용한다. */
export function shouldSkipFile(relPath: string, config: IgnoreConfig): boolean {
  let skipped = false;
  for (const rule of config.rules ?? []) {
    rule.regex.lastIndex = 0;
    const match = rule.regex.exec(relPath);
    if (!match) continue;
    // 디렉터리 규칙은 같은 이름의 파일 자체가 아니라 그 하위 파일에만 적용한다.
    const matchEnd = match.index + match[0].length;
    const matchesDescendant = match[0].endsWith('/') || relPath[matchEnd] === '/';
    if (rule.directoryOnly && !matchesDescendant) continue;
    skipped = !rule.negated;
  }
  return skipped;
}

// ============ .gitignore / .cxtignore parser ============

function loadIgnoreFile(
  filePath: string,
  skipDirs: Set<string>,
  skipPrefixes: string[],
  skipPathPatterns: RegExp[],
  rules: Array<{ regex: RegExp; negated: boolean; literalPrefix: string; directoryOnly: boolean; hasWildcard: boolean }>,
): void {
  if (!existsSync(filePath)) return;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch { // cxt-ignore: exception_hiding — ignore 파일 읽기 실패 시 무시하고 진행
    return;
  }

  for (const rawLine of content.split('\n')) {
    let line = rawLine.replace(/\r$/, '');
    while (/[ \t]$/.test(line)) {
      let slashes = 0;
      for (let i = line.length - 2; i >= 0 && line[i] === '\\'; i--) slashes++;
      if (slashes % 2 === 1) break;
      line = line.slice(0, -1);
    }
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('\\#')) line = line.slice(1);
    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);
    else if (line.startsWith('\\!')) line = line.slice(1);
    if (!line) continue;

    // directory pattern: ends with /
    // e.g. "docker/", "build-*/", "legacy/"
    const isDir = line.endsWith('/');
    const cleaned = line.replace(/\/$/, '');
    const anchored = cleaned.startsWith('/');
    const pattern = anchored ? cleaned.slice(1) : cleaned;
    const regexBody = globToRegexBody(pattern);
    let regex: RegExp;
    try {
      regex = new RegExp(anchored ? `^${regexBody}(?:/|$)` : `(?:^|/)${regexBody}(?:/|$)`);
    } catch {
      // 저장소가 제공한 잘못된 bracket/range 규칙 하나 때문에 전체 스캔을 중단하지 않는다.
      continue;
    }
    const literalPrefix = pattern.split(/[?*[\]]/, 1)[0].replace(/\/$/, '');
    rules.push({ regex, negated, literalPrefix, directoryOnly: isDir, hasWildcard: /[?*[\]]/.test(pattern) });

    if (negated) continue;

    if (isDir && !cleaned.includes('/') && !cleaned.includes('*')) {
      // simple dir name: "docker/"
      skipDirs.add(cleaned);
    } else if (isDir && cleaned.endsWith('*')) {
      // prefix pattern: "build-*/"
      const prefix = cleaned.replace(/\*$/, '');
      if (!prefix.includes('/')) {
        skipPrefixes.push(prefix);
      }
    } else if (cleaned.includes('/') || /[*?[\]]/.test(cleaned)) {
      // path pattern: "subprojects/pykis/**"
      // convert glob-ish to regex
      try {
        const regexStr = globToRegexBody(cleaned);
        skipPathPatterns.push(new RegExp(`^${regexStr}`));
      } catch { // cxt-ignore: exception_hiding — invalid glob 패턴은 스킵
        // invalid pattern — skip
      }
    } else if (!cleaned.includes('.')) {
      // no extension, no slash — likely a directory name
      skipDirs.add(cleaned);
    }
  }
}

function globToRegexBody(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
      else { out += '.*'; i++; }
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) out += '\\[';
      else {
        let body = pattern.slice(i + 1, end);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    }
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

// ============ Subproject/vendored dir detection ============
function detectVendoredSubprojectDirs(projectRoot: string, skipDirs: Set<string>, skipPathPatterns: RegExp[]): void {
  // Scan top-level directories for vendored subprojects
  // A dir is likely vendored/third-party if it has its own package manifest
  // AND it's not the project root itself

  const rootManifests = ['package.json', 'Cargo.toml', 'go.mod', 'setup.py', 'pyproject.toml', 'pom.xml', '*.csproj'];

  let entries: string[];
  try {
    entries = readdirSync(projectRoot, { withFileTypes: true })
      .filter((e: { isDirectory: () => boolean }) => e.isDirectory())
      .map((e: { name: string }) => e.name);
  } catch { // cxt-ignore: exception_hiding — readdir 실패 시 subproject 탐지 건너뜀
    return;
  }

  for (const dirName of entries) {
    if (skipDirs.has(dirName)) continue;
    if (dirName.startsWith('.')) continue;

    const dirPath = join(projectRoot, dirName);

    // Check if this subdirectory has its own manifest (= separate project)
    const hasOwnManifest = rootManifests.some(manifest => {
      if (manifest.includes('*')) {
        // glob pattern like *.csproj
        try {
          const files = readdirSync(dirPath) as string[];
          const ext = manifest.replace('*', '');
          return files.some((f: string) => f.endsWith(ext));
        } catch { // cxt-ignore: exception_hiding — readdir 실패 시 manifest 없음으로 간주
          return false;
        }
      }
      return existsSync(join(dirPath, manifest));
    });

    // If the subdir has its own manifest AND a .venv or node_modules, it's vendored
    if (hasOwnManifest) {
      const hasVendoredDeps =
        existsSync(join(dirPath, 'node_modules')) ||
        existsSync(join(dirPath, '.venv')) ||
        existsSync(join(dirPath, 'venv')) ||
        existsSync(join(dirPath, 'vendor'));

      if (hasVendoredDeps) {
        const escaped = dirName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        skipPathPatterns.push(new RegExp(`^${escaped}(?:/|$)`));
      }
    }
  }
}
