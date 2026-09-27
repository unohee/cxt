import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FrontendResult } from '../frontend/types.js';

export type CacheKind = 'frontend' | 'summary';
export interface AnalysisCacheEntry { kind: CacheKind; key: string; inputHash: string; payload: string; payloadHash: string }
export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');

/** 개발 checkout과 설치 package 모두 실제 engine/query bytes 변경 시 무효화한다. */
export function engineFingerprint(): string {
  const root = fileURLToPath(new URL('../', import.meta.url)), files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:[cm]?js|ts|scm)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  visit(root);
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ format: 1, node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch }));
  for (const path of files.sort()) hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0');
  const require = createRequire(import.meta.url);
  for (const name of ['tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript', 'tree-sitter-python', 'tree-sitter-rust']) {
    try { hash.update(name).update(readFileSync(require.resolve(`${name}/package.json`))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
      hash.update(`${name}:missing`);
    }
  }
  return hash.digest('hex');
}

type SerializedFrontend = Omit<FrontendResult, 'references'> & {
  references: Array<[string, { callNames: string[]; baseNames: string[]; importPaths: string[] }]>;
};
export function serializeFrontend(result: FrontendResult): SerializedFrontend {
  return { ...result, references: [...result.references].map(([key, refs]) => [key, {
    callNames: [...refs.callNames], baseNames: [...refs.baseNames], importPaths: [...refs.importPaths],
  }]) };
}
export function deserializeFrontend(result: SerializedFrontend): FrontendResult {
  return { ...result, references: new Map(result.references.map(([key, refs]) => [key, {
    callNames: new Set(refs.callNames), baseNames: new Set(refs.baseNames), importPaths: new Set(refs.importPaths),
  }])) };
}
export function cacheEntry(kind: CacheKind, key: string, inputHash: string, value: unknown): AnalysisCacheEntry {
  const payload = JSON.stringify(value);
  return { kind, key, inputHash, payload, payloadHash: hashText(payload) };
}
export interface AnalysisCache {
  get(kind: CacheKind, key: string, inputHash: string): unknown | undefined;
  set(kind: CacheKind, key: string, inputHash: string, value: unknown): void;
}
