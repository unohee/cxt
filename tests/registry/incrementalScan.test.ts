import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanRepository } from '../../src/registry/entityScanner.js';
import { getRegistryStore, closeRegistryStore, SqliteRegistryStore } from '../../src/registry/sqliteStore.js';
import * as native from '../../src/frontend/treeSitter.js';
import { FrontendError } from '../../src/frontend/types.js';
import { hashText } from '../../src/analysis/cache.js';
import * as cacheModule from '../../src/analysis/cache.js';

let root: string, database: string;
const write = (path: string, source: string) => writeFileSync(join(root, path), source);
const store = () => getRegistryStore(database);
function snapshot() {
  return { calls: store().getCallSites('p'), cfgs: store().getControlFlow('p').sort((a, b) => a.owner.localeCompare(b.owner)),
    flows: store().getDataflow('p').sort((a, b) => a.owner.localeCompare(b.owner)), summaries: store().getSummaries('p').sort((a, b) => a.owner.localeCompare(b.owner)) };
}
beforeEach(() => {
  closeRegistryStore(); root = mkdtempSync(join(tmpdir(), 'cxt-incremental-')); database = join(root, 'facts.db'); store();
  write('a.ts', 'export function f(){return 1;}');
  write('b.ts', "import {f} from './a';export function g(){return f();}");
  write('c.ts', "import {g} from './b';export function h(){return g();}");
  write('independent.ts', 'export function alone(){return 9;}');
});
afterEach(() => { vi.restoreAllMocks(); closeRegistryStore(); rmSync(root, { recursive: true, force: true }); });

describe('incremental fact snapshots', () => {
  it('invalidates every cached stage when engine bytes or runtime identity changes', async () => {
    await scanRepository(root, 'p'); const before = snapshot();
    const engine = vi.spyOn(cacheModule, 'engineFingerprint').mockReturnValue(hashText('changed-engine'));
    const changed = await scanRepository(root, 'p');
    expect(changed.errors).toEqual([]);
    expect(changed.cache).toMatchObject({ frontendHits: 0, frontendMisses: 4, summaryHits: 0, summaryMisses: 4 });
    expect(snapshot()).toEqual(before); engine.mockRestore();
  });

  it('reuses unchanged frontends and components, invalidates transitive changed summaries, and equals a full scan', async () => {
    const cold = await scanRepository(root, 'p'); expect(cold.errors).toEqual([]);
    expect(cold.cache).toMatchObject({ frontendHits: 0, frontendMisses: 4, summaryHits: 0, summaryMisses: 4, committed: true });
    expect(store().queryFacts('p', { view: 'cfg', where: [{ column: 'owner', op: 'eq', value: 'a.ts::f' }] })).toEqual([
      expect.objectContaining({ completeness: 'complete', structural_complexity: 1, node_count: expect.any(Number), edge_count: expect.any(Number) }),
    ]);
    expect(store().queryFacts('p', { view: 'flows', where: [{ column: 'owner', op: 'eq', value: 'a.ts::f' }] })).toEqual([
      expect.objectContaining({ completeness: 'complete', unknown_effect_count: 0, definition_count: expect.any(Number) }),
    ]);
    expect(store().queryFacts('p', { view: 'summaries', where: [{ column: 'owner', op: 'eq', value: 'a.ts::f' }] })).toEqual([
      expect.objectContaining({ completeness: 'complete', may_return: 1, may_throw: 0, return_atoms: '["number:1"]', return_parameters: '[]' }),
    ]);
    const before = snapshot(); closeRegistryStore(); store();
    const warm = await scanRepository(root, 'p'); expect(warm.errors).toEqual([]);
    expect(warm.cache).toMatchObject({ frontendHits: 4, frontendMisses: 0, summaryHits: 4, summaryMisses: 0, committed: true });
    expect(snapshot()).toEqual(before);
    write('a.ts', 'export function f(){return 2;}');
    const changed = await scanRepository(root, 'p'); expect(changed.errors).toEqual([]);
    expect(changed.cache).toMatchObject({ frontendHits: 3, frontendMisses: 1, summaryHits: 1, summaryMisses: 3 });
    expect(store().getSummaries('p').find(summary => summary.owner === 'c.ts::h')?.returnAtoms).toEqual(['number:2']);
    const incremental = snapshot();
    const full = await scanRepository(root, 'p', { full: true }); expect(full.errors).toEqual([]);
    expect(full.cache).toMatchObject({ frontendHits: 0, summaryHits: 0 }); expect(snapshot()).toEqual(incremental);
  });

  it('invalidates deleted imports and removes obsolete cache entries atomically', async () => {
    await scanRepository(root, 'p');
    mkdirSync(join(root, '.archive')); renameSync(join(root, 'a.ts'), join(root, '.archive', 'a.ts'));
    const result = await scanRepository(root, 'p'); expect(result.errors).toEqual([]);
    expect(result.cache).toMatchObject({ frontendHits: 3, summaryHits: 1, summaryMisses: 2 });
    expect(store().getSummaries('p').find(summary => summary.owner === 'b.ts::g')?.completeness).toBe('partial');
    const raw = new Database(database, { readonly: true });
    try { expect(raw.prepare("SELECT count(*) AS n FROM code_analysis_cache WHERE kind='frontend'").get()).toEqual({ n: 3 }); }
    finally { raw.close(); }
    const incremental = snapshot(); await scanRepository(root, 'p', { full: true }); expect(snapshot()).toEqual(incremental);
  });

  it('updates SCC caches on recursive changes without mixing old and new owners', async () => {
    write('a.ts', "import {g} from './b';export function f(x){if(x)return g(false);return 1;}");
    write('b.ts', "import {f} from './a';export function g(x){return f(x);}");
    await scanRepository(root, 'p'); const before = snapshot();
    const warm = await scanRepository(root, 'p'); expect(warm.cache.summaryMisses).toBe(0); expect(snapshot()).toEqual(before);
    write('a.ts', "import {g} from './b';export function f(x){if(x)return g(false);return 2;}");
    await scanRepository(root, 'p'); const changed = snapshot();
    await scanRepository(root, 'p', { full: true }); expect(snapshot()).toEqual(changed);
  });

  it('invalidates models and parser mode while preserving native-unavailable diagnostics', async () => {
    write('a.ts', "import{basename}from'node:path';export function f(){return basename('x');}");
    await scanRepository(root, 'p');
    write('.cxt-models.json', JSON.stringify({ schemaVersion: 1, versions: { node: '22.19.0' }, assumptions: ['unmodified-external-bindings'] }));
    const changed = await scanRepository(root, 'p'); expect(changed.errors).toEqual([]);
    expect(changed.cache.frontendHits).toBe(4); expect(changed.cache.summaryHits).toBe(0);
    expect(changed.models.calls.applied).toBeGreaterThan(0);
    const fallback = vi.spyOn(native, 'loadTreeSitterFrontend').mockImplementation((_lang, filePath) => { throw new FrontendError({ code: 'parser-unavailable', filePath, message: 'native ABI missing' }); });
    const failed = await scanRepository(root, 'p', { parser: 'ast' }); expect(failed.errors.length).toBeGreaterThan(0); expect(failed.cache.committed).toBe(false);
    const auto = await scanRepository(root, 'p'); expect(auto.parserBreakdown.lexical).toBe(4); expect(auto.diagnostics.every(d => d.code === 'parser-unavailable')).toBe(true);
    fallback.mockRestore(); const recovered = await scanRepository(root, 'p'); expect(recovered.parserBreakdown.ast).toBe(4); expect(recovered.cache.frontendHits).toBe(0);
    const lexical = await scanRepository(root, 'p', { parser: 'lexical' }); expect(lexical.cache.frontendHits).toBe(0);
    expect((await scanRepository(root, 'p', { parser: 'lexical' })).cache.frontendHits).toBe(4);
  });

  it('rolls back caches with facts on failed storage and rejects corrupted cached bytes', async () => {
    await scanRepository(root, 'p'); const before = snapshot();
    const raw = new Database(database);
    const caches = () => raw.prepare('SELECT * FROM code_analysis_cache ORDER BY kind, cache_key').all();
    const prior = caches(); write('a.ts', 'export function f(){return 2;}');
    const original = store().replaceAnalysisCache.bind(store());
    const mutation = vi.spyOn(store(), 'replaceAnalysisCache').mockImplementation((project, rows) => { original(project, rows); throw new Error('storage interrupted'); });
    const failed = await scanRepository(root, 'p'); expect(failed.errors).toEqual(['storage interrupted']); expect(failed.cache.committed).toBe(false);
    expect(snapshot()).toEqual(before); expect(caches()).toEqual(prior); mutation.mockRestore();
    write('a.ts', 'export function f(){return 1;}');
    raw.prepare("UPDATE code_analysis_cache SET payload_hash = ? WHERE kind = 'frontend' AND cache_key = 'a.ts'").run(hashText('corrupted'));
    const corrupt = await scanRepository(root, 'p'); expect(corrupt.errors.join('\n')).toContain('cache integrity mismatch'); expect(snapshot()).toEqual(before);
    expect((await scanRepository(root, 'p', { full: true })).errors).toEqual([]); raw.close();
  });

  it('migrates v8 facts without fabricating cache hits and recreates read views', async () => {
    await scanRepository(root, 'p'); const before = snapshot(); closeRegistryStore();
    const raw = new Database(database); raw.exec('DROP TABLE code_analysis_cache; DROP VIEW cxt_query_calls;'); raw.pragma('user_version = 8'); raw.close();
    store(); expect(snapshot()).toEqual(before);
    expect(store().queryFacts('p', { view: 'calls' }).length).toBeGreaterThan(0);
    expect((await scanRepository(root, 'p')).cache.frontendHits).toBe(0);
    const reopened = new SqliteRegistryStore(database); expect(reopened.searchEntities('f', 20, 'p').length).toBeGreaterThan(0); reopened.close();
    expect(readFileSync(database).length).toBeGreaterThan(0);
  });
});
