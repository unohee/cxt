// ============================================
// ctx - Ignore Rules
// Created: 2026-04-11
// Purpose: Scan exclusion rules from .gitignore, .cxtignore, and dependency files
// ============================================

import { readFileSync, existsSync } from 'node:fs';
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

  // 1. .cxtignore — project-specific exclusions (same syntax as .gitignore)
  loadIgnoreFile(join(projectRoot, '.cxtignore'), skipDirs, skipPrefixes, skipPathPatterns);

  // 2. .gitignore — parse for directory patterns
  loadIgnoreFile(join(projectRoot, '.gitignore'), skipDirs, skipPrefixes, skipPathPatterns);

  // 3. Dependency manifests — auto-detect vendored/subproject dirs
  detectSubprojectDirs(projectRoot, skipDirs);

  return { skipDirs, skipPrefixes, skipPathPatterns };
}

/**
 * Check if a directory entry should be skipped.
 */
export function shouldSkipDir(
  dirName: string,
  relPath: string,
  config: IgnoreConfig,
): boolean {
  // exact match
  if (config.skipDirs.has(dirName)) return true;

  // dot directories (hidden)
  if (dirName.startsWith('.') && dirName !== '.') return true;

  // prefix match
  if (config.skipPrefixes.some(p => dirName.startsWith(p))) return true;

  // path pattern match
  const fullRel = relPath ? `${relPath}/${dirName}` : dirName;
  if (config.skipPathPatterns.some(p => p.test(fullRel))) return true;

  return false;
}

// ============ .gitignore / .cxtignore parser ============

function loadIgnoreFile(
  filePath: string,
  skipDirs: Set<string>,
  skipPrefixes: string[],
  skipPathPatterns: RegExp[],
): void {
  if (!existsSync(filePath)) return;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch { // cxt-ignore: exception_hiding — ignore 파일 읽기 실패 시 무시하고 진행
    return;
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // negation patterns — skip (too complex for simple matching)
    if (line.startsWith('!')) continue;

    // directory pattern: ends with /
    // e.g. "docker/", "build-*/", "legacy/"
    const isDir = line.endsWith('/');
    const cleaned = line.replace(/\/$/, '');

    if (isDir && !cleaned.includes('/') && !cleaned.includes('*')) {
      // simple dir name: "docker/"
      skipDirs.add(cleaned);
    } else if (isDir && cleaned.endsWith('*')) {
      // prefix pattern: "build-*/"
      const prefix = cleaned.replace(/\*$/, '');
      if (!prefix.includes('/')) {
        skipPrefixes.push(prefix);
      }
    } else if (cleaned.includes('/') || cleaned.includes('*')) {
      // path pattern: "subprojects/pykis/**"
      // convert glob-ish to regex
      try {
        const regexStr = cleaned
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*');
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

// ============ Subproject/vendored dir detection ============

function detectSubprojectDirs(projectRoot: string, skipDirs: Set<string>): void {
  // Scan top-level directories for vendored subprojects
  // A dir is likely vendored/third-party if it has its own package manifest
  // AND it's not the project root itself

  const rootManifests = ['package.json', 'Cargo.toml', 'go.mod', 'setup.py', 'pyproject.toml', 'pom.xml', '*.csproj'];

  let entries: string[];
  try {
    const fs = require('node:fs');
    entries = fs.readdirSync(projectRoot, { withFileTypes: true })
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
          const fs = require('node:fs');
          const files = fs.readdirSync(dirPath) as string[];
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
        skipDirs.add(dirName);
      }
    }
  }
}
