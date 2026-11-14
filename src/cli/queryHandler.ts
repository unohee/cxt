import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { factQuerySchema } from '../analysis/factQuery.js';
import { resolveProjectId } from './checkHandler.js';
import { escapeTerminal } from './outputSafety.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { engineFingerprint, hashText } from '../analysis/cache.js';

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.json', '.toml', '.yaml', '.yml']);
const sourceLanguages: Record<string, string> = { '.ts': 'typescript', '.tsx': 'typescript', '.js': 'typescript', '.jsx': 'typescript', '.mjs': 'typescript', '.cjs': 'typescript', '.py': 'python', '.rs': 'rust' };
function discoverSourceFiles(root: string): string[] | undefined {
  const files: string[] = [];
  const visit = (directory: string): boolean => {
    if (files.length > 20_000) return false;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.cxt' || entry.name === 'dist' || entry.name === 'target' || entry.name.startsWith('.cxt-')) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) { if (!visit(absolute)) return false; }
      else if (entry.isFile() && sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) files.push(absolute);
    }
    return true;
  };
  return visit(root) ? files : undefined;
}

export function verifySnapshotFreshness(projectPath: string, inputs: { updatedAt?: string; filePaths: string[]; cachedFiles?: Array<{ filePath: string; inputHash: string }> }): 'current' | 'stale' | 'not-verified' {
  if (!inputs.updatedAt || !inputs.filePaths.length) return 'not-verified';
  const normalized = inputs.updatedAt.includes('T') ? inputs.updatedAt : inputs.updatedAt.replace(' ', 'T') + 'Z';
  const snapshotMs = Date.parse(normalized);
  if (!Number.isFinite(snapshotMs)) return 'not-verified';
  for (const filePath of inputs.filePaths) {
    try {
      if (statSync(resolve(projectPath, filePath)).mtimeMs > snapshotMs + 1000) return 'stale';
    } catch { return 'stale'; }
  }
  const discovered = discoverSourceFiles(projectPath);
  if (!discovered) return 'not-verified';
  const indexed = new Set(inputs.filePaths.map(filePath => resolve(projectPath, filePath)));
  const cached = inputs.cachedFiles === undefined
    ? undefined
    : new Map(inputs.cachedFiles.map(file => [resolve(projectPath, file.filePath), file.inputHash]));
  for (const filePath of discovered) {
    if (!indexed.has(filePath)) {
      // A cached file omitted from the entity snapshot means the frontend was
      // unavailable (for example, the packed lexical fallback); freshness is
      // unverifiable rather than evidence of a changed source tree.
      if (cached?.has(filePath)) return 'not-verified';
      return 'stale';
    }
    if (statSync(filePath).mtimeMs > snapshotMs + 1000) return 'stale';
  }
  // Callers without persisted cache metadata retain the legacy mtime-only
  // result; registry-backed queries always provide cachedFiles.
  if (inputs.cachedFiles === undefined) return 'current';
  const verifiedCache = new Map(inputs.cachedFiles.map(file => [resolve(projectPath, file.filePath), file.inputHash]));
  if (!verifiedCache.size) return 'not-verified';
  const engine = engineFingerprint();
  let hashVerified = false;
  let hashUnavailable = false;
  for (const filePath of inputs.filePaths.map(filePath => resolve(projectPath, filePath))) {
    const expected = verifiedCache.get(filePath);
    const extension = filePath.slice(filePath.lastIndexOf('.'));
    const language = sourceLanguages[extension];
    if (!language) continue;
    if (!expected) { hashUnavailable = true; continue; }
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { return 'stale'; }
    const currentHashes = ['auto', 'ast', 'lexical'].map(mode => hashText(JSON.stringify([engine, mode, language, content])));
    if (!currentHashes.includes(expected)) return 'stale';
    hashVerified = true;
  }
  if (!hashVerified || hashUnavailable) return 'not-verified';
  return 'current';
}

export function handleQuery(view: string, opts: { project?: string; where?: string; orderBy?: string; descending?: boolean; limit?: string; offset?: string; json?: boolean }): void {
  const projectId = opts.project ?? resolveProjectId(process.cwd());
  const query = factQuerySchema.parse({ view, where: opts.where ? JSON.parse(opts.where) as unknown : [], orderBy: opts.orderBy,
    direction: opts.descending ? 'desc' : 'asc', limit: opts.limit === undefined ? undefined : Number(opts.limit), offset: opts.offset === undefined ? undefined : Number(opts.offset) });
  try {
    const store = getRegistryStore();
    const rows = store.queryFacts(projectId, query);
    const freshness = verifySnapshotFreshness(process.cwd(), store.getSnapshotFreshnessInputs(projectId));
    const result = { project: projectId, view, source: 'persisted-snapshot', freshness, rows, limit: query.limit, offset: query.offset };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${escapeTerminal(projectId)} / ${view}: ${rows.length} stored rows (source freshness ${freshness})`);
      for (const row of rows) console.log(Object.entries(row).map(([key, value]) => `${key}=${escapeTerminal(value)}`).join('  '));
    }
  } finally { closeRegistryStore(); }
}
