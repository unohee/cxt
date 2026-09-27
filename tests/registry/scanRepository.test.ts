import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepository } from '../../src/registry/entityScanner.js';
import { getRegistryStore, closeRegistryStore } from '../../src/registry/sqliteStore.js';
import * as treeSitter from '../../src/frontend/treeSitter.js';
import * as dataflow from '../../src/analysis/dataflow.js';
import { FrontendError } from '../../src/frontend/types.js';

// scanRepository uses the global registry store singleton.
// Pre-initialize the singleton with a tmp DB path so tests don't pollute
// the user's ~/.cxt/registry.db.

let projectDir: string;
let tmpDbDir: string;

function write(rel: string, content: string): void {
  const abs = join(projectDir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
  closeRegistryStore();
  projectDir = mkdtempSync(join(tmpdir(), 'cxt-proj-'));
  tmpDbDir = mkdtempSync(join(tmpdir(), 'cxt-db-'));
  // Pre-init singleton with tmp path
  getRegistryStore(join(tmpDbDir, 'registry.db'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeRegistryStore();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(tmpDbDir, { recursive: true, force: true });
});

describe('scanRepository — AST frontend and snapshot safety', () => {
  it('preserves the prior snapshot when a dataflow pass exceeds the scan deadline', async () => {
    write('x.ts', 'function f(){return 1;}');
    await scanRepository(projectDir, 'flow-timeout', { parser: 'ast' });
    const store = getRegistryStore();
    const before = store.listEntities({ projectId: 'flow-timeout' });
    const flows = store.getDataflow('flow-timeout');
    write('x.ts', 'function changed(){return 2;}');
    const originalNow = Date.now, originalAnalyze = dataflow.analyzeDataflow;
    let elapsed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => originalNow() + elapsed);
    vi.spyOn(dataflow, 'analyzeDataflow').mockImplementation(graph => {
      const result = originalAnalyze(graph); elapsed = 10_000; return result;
    });
    const result = await scanRepository(projectDir, 'flow-timeout', { parser: 'ast', timeoutMs: 5000 });
    expect(result.errors).toEqual(['scan timed out during dataflow']);
    expect(result.dataflow.total).toBe(0);
    expect(store.listEntities({ projectId: 'flow-timeout' })).toEqual(before);
    expect(store.getDataflow('flow-timeout')).toEqual(flows);
  });

  it('persists private declarations and distinct same-name methods with exact ownership', async () => {
    write('src/x.ts', 'type Private = number;\nconst convert = (x:number) => x;\nclass A { run() { convert(1); } }\nclass B { run() {} }');
    const result = await scanRepository(projectDir, 'ast', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    expect(result.parserBreakdown).toEqual({ ast: 1 });
    expect(result.registered).toBe(6);
    const store = getRegistryStore();
    expect(store.findEntitiesByName('run', 'ast')).toHaveLength(2);
    expect(store.getEntityByName('src/x.ts::A.run', 'ast')?.lineStart).toBe(3);
    const a = store.getEntityByName('src/x.ts::A', 'ast')!;
    expect(store.getOutgoingRelations(a.id, 'calls')).toEqual([]);
    const method = store.getEntityByName('src/x.ts::A.run', 'ast')!;
    expect(store.getOutgoingRelations(method.id, 'calls').map(r => r.targetName)).toEqual(['convert']);
  });

  it('keeps the complete previous snapshot when any source has a syntax error', async () => {
    write('src/x.ts', 'function target() {}\nfunction caller() { target(); }');
    await scanRepository(projectDir, 'ast-failure', { parser: 'ast' });
    const store = getRegistryStore();
    const before = store.listEntities({ projectId: 'ast-failure' });
    const relations = store.countRelations('ast-failure');
    const callSites = store.getCallSites('ast-failure');
    const cfgs = store.getControlFlow('ast-failure');
    const flows = store.getDataflow('ast-failure');
    write('src/x.ts', 'function replacement() {}');
    write('src/invalid.ts', 'function broken(');
    const result = await scanRepository(projectDir, 'ast-failure', { parser: 'auto' });
    expect(result.errors.join(' ')).toContain('invalid.ts');
    expect(result.diagnostics[0]).toMatchObject({ code: 'syntax-error', filePath: 'src/invalid.ts' });
    expect(result.registered + result.updated + result.removed).toBe(0);
    expect(store.listEntities({ projectId: 'ast-failure' })).toEqual(before);
    expect(store.countRelations('ast-failure')).toBe(relations);
    expect(store.getCallSites('ast-failure')).toEqual(callSites);
    expect(store.getControlFlow('ast-failure')).toEqual(cfgs);
    expect(store.getDataflow('ast-failure')).toEqual(flows);
  });

  it('atomically rolls back entities, call facts and relations when final relation persistence fails', async () => {
    write('src/x.ts', 'function run() { run(); }');
    await scanRepository(projectDir, 'rollback', { parser: 'ast' });
    const store = getRegistryStore();
    const before = store.listEntities({ projectId: 'rollback' });
    const sites = store.getCallSites('rollback');
    const cfgs = store.getControlFlow('rollback');
    const flows = store.getDataflow('rollback');
    const relations = store.countRelations('rollback');
    write('src/x.ts', 'function replacement() { missing(); }');
    vi.spyOn(store, 'replaceRelationsForProject').mockImplementation(() => { throw new Error('injected storage failure'); });
    const result = await scanRepository(projectDir, 'rollback', { parser: 'ast' });
    expect(result.errors).toEqual(['injected storage failure']);
    expect(result.registered + result.updated + result.removed + result.relationsLoaded).toBe(0);
    expect(result.callSites.total).toBe(0);
    expect(store.listEntities({ projectId: 'rollback' })).toEqual(before);
    expect(store.getCallSites('rollback')).toEqual(sites);
    expect(store.getControlFlow('rollback')).toEqual(cfgs);
    expect(store.getDataflow('rollback')).toEqual(flows);
    expect(store.countRelations('rollback')).toBe(relations);
  });

  it('stores each call site and derives deduplicated recursive and imported edges on rescan', async () => {
    write('src/lib.ts', 'export function target() {}');
    write('src/main.ts', "import { target as alias } from './lib';\nimport { external } from 'package';\nfunction caller() { alias(); alias(); caller(); unknown(); external(); }\ncaller();");
    const result = await scanRepository(projectDir, 'facts', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    expect(result.callSites).toEqual({ total: 6, resolved: 4, unresolved: 1, external: 1 });
    const store = getRegistryStore();
    const caller = store.getEntityByName('src/main.ts::caller', 'facts')!;
    const sites = store.getCallSites('facts');
    expect(sites).toHaveLength(6);
    expect(sites[5]).toMatchObject({ caller: undefined, target: caller.qualifiedName, line: 4, column: 1 });
    expect(store.getOutgoingRelations(caller.id, 'calls')).toHaveLength(2);
    await scanRepository(projectDir, 'facts', { parser: 'ast' });
    expect(store.getCallSites('facts')).toEqual(sites);
    write('src/main.ts', 'function caller() { absent(); }');
    await scanRepository(projectDir, 'facts', { parser: 'ast' });
    expect(store.getCallSites('facts')).toHaveLength(1);
    expect(store.getOutgoingRelations(caller.id, 'calls')).toEqual([]);
  });

  it('exposes unavailable native parsers and fails explicit AST mode without replacing data', async () => {
    write('src/x.ts', 'export function run() {}');
    await scanRepository(projectDir, 'missing-parser', { parser: 'ast' });
    vi.spyOn(treeSitter, 'loadTreeSitterFrontend').mockImplementation(() => {
      throw new FrontendError({ code: 'parser-unavailable', filePath: 'src/x.ts', message: 'native binding unavailable' });
    });
    const auto = await scanRepository(projectDir, 'missing-parser', { parser: 'auto' });
    expect(auto.parserBreakdown).toEqual({ lexical: 1 });
    expect(auto.diagnostics[0].code).toBe('parser-unavailable');
    const strict = await scanRepository(projectDir, 'missing-parser', { parser: 'ast' });
    expect(strict.errors.join(' ')).toContain('native binding unavailable');
    expect(strict.registered + strict.updated + strict.removed).toBe(0);
    expect(getRegistryStore().getEntityByName('src/x.ts::run', 'missing-parser')?.status).toBe('active');
  });

  it('does not downgrade a broken query or missing query asset to lexical success', async () => {
    write('src/x.ts', 'export function run() {}');
    vi.spyOn(treeSitter, 'loadTreeSitterFrontend').mockImplementation(() => { throw new Error('invalid extraction query'); });
    const result = await scanRepository(projectDir, 'bad-query', { parser: 'auto' });
    expect(result.errors.join(' ')).toContain('invalid extraction query');
    expect(result.registered).toBe(0);
    expect(result.parserBreakdown).toEqual({});
  });

  it('updates declaration kind when a function binding becomes a value', async () => {
    write('src/x.ts', 'const work = () => 1;');
    await scanRepository(projectDir, 'kind-change', { parser: 'ast' });
    write('src/x.ts', 'const work = 1;');
    await scanRepository(projectDir, 'kind-change', { parser: 'ast' });
    expect(getRegistryStore().getEntityByName('src/x.ts::work', 'kind-change')?.kind).toBe('constant');
  });

  it('honors the environment switch and rejects an invalid mode before scanning', async () => {
    write('src/x.ts', 'type Hidden = string;');
    vi.stubEnv('CXT_PARSER', 'lexical');
    const result = await scanRepository(projectDir, 'lexical');
    expect(result.parserBreakdown).toEqual({ lexical: 1 });
    expect(result.extracted).toBe(0);
    vi.stubEnv('CXT_PARSER', 'bogus');
    await expect(scanRepository(projectDir, 'invalid-mode')).rejects.toThrow('Invalid CXT_PARSER');
  });
});

describe('scanRepository — file walking + test mapping', () => {
  it('detects entities in TS source and parses .test.ts as test file', async () => {
    write('src/math.ts', 'export function add(a: number, b: number) { return a + b; }');
    write('src/math.test.ts', `
      import { add } from './math';
      import { describe, it, expect } from 'vitest';
      describe('add', () => {
        it('works', () => { expect(add(1, 2)).toBe(3); });
      });
    `);

    const result = await scanRepository(projectDir, 'tproj-1');

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.extracted).toBeGreaterThanOrEqual(1);
    expect(result.testsMapped).toBeGreaterThanOrEqual(1);
  });

  it('maps tests via direct named import', async () => {
    write('src/foo.ts', 'export function helper() { return 42; }');
    write('src/foo.test.ts', `
      import { helper } from './foo';
      it('works', () => { helper(); });
    `);

    const result = await scanRepository(projectDir, 'tproj-2');
    expect(result.testsMapped).toBeGreaterThanOrEqual(1);
  });

  it('maps tests via nearby test file (call-by-name fallback)', async () => {
    write('src/util.ts', 'export function compute() { return 1; }');
    write('src/util.test.ts', `
      const u = require('./util');
      it('works', () => { compute(); });
    `);

    const result = await scanRepository(projectDir, 'tproj-3');
    expect(result.testsMapped).toBeGreaterThanOrEqual(1);
  });

  it('skips node_modules via built-in ignore rules', async () => {
    write('src/main.ts', 'export function main() {}');
    write('node_modules/some-pkg/index.ts', 'export function shouldBeSkipped() {}');

    const result = await scanRepository(projectDir, 'tproj-4');
    expect(result.scanned).toBe(1);
  });

  it('applies ordered file ignore rules before extracting entities', async () => {
    write('.cxtignore', '*.generated.ts\n!keep.generated.ts\n');
    write('drop.generated.ts', 'export function dropped() {}');
    write('keep.generated.ts', 'export function kept() {}');

    const result = await scanRepository(projectDir, 'tproj-ignore-files');
    const store = getRegistryStore();
    expect(result.scanned).toBe(1);
    expect(store.findEntitiesByName('dropped', 'tproj-ignore-files')).toHaveLength(0);
    expect(store.findEntitiesByName('kept', 'tproj-ignore-files')).toHaveLength(1);
  });

  it('returns language breakdown for multiple languages', async () => {
    write('src/a.ts', 'export function a() {}');
    write('src/b.py', 'def b(): pass');
    write('src/c.go', 'package main\nfunc C() {}');

    const result = await scanRepository(projectDir, 'tproj-5');
    expect(result.languageBreakdown.typescript).toBeGreaterThanOrEqual(1);
    expect(result.languageBreakdown.python).toBeGreaterThanOrEqual(1);
    expect(result.languageBreakdown.go).toBeGreaterThanOrEqual(1);
  });

  it('handles empty repository without errors', async () => {
    const result = await scanRepository(projectDir, 'tproj-6');
    expect(result.scanned).toBe(0);
    expect(result.extracted).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('skips files larger than MAX_FILE_SIZE', async () => {
    const big = 'export const X = "' + 'x'.repeat(600 * 1024) + '";';
    write('src/big.ts', big);
    write('src/small.ts', 'export function small() {}');

    const result = await scanRepository(projectDir, 'tproj-7');
    expect(result.scanned).toBe(1);
  });

  it('maps tests via basename match across parallel directory trees', async () => {
    // src/registry/foo.ts ↔ tests/registry/foo.test.ts
    // The test file does NOT import or call the entity by name — only the
    // basename match should mark it as tested.
    write('src/registry/foo.ts', 'export function privateHelper() { return 1; }\nexport class Bar {}');
    write('tests/registry/foo.test.ts', `
      // No import of foo, no direct call to privateHelper or Bar
      describe('something', () => {
        it('does stuff', () => { expect(1).toBe(1); });
      });
    `);

    const result = await scanRepository(projectDir, 'tproj-basename');
    // Both privateHelper and Bar should be tested via basename rule
    expect(result.testsMapped).toBeGreaterThanOrEqual(2);
  });

  it('basename rule does not match unrelated files with different basenames', async () => {
    write('src/foo.ts', 'export function fooFn() {}');
    write('src/bar.ts', 'export function barFn() {}');
    write('tests/foo.test.ts', `
      it('test', () => {});
    `);

    const result = await scanRepository(projectDir, 'tproj-basename-neg');
    // foo.ts should be mapped (basename match), bar.ts should NOT
    expect(result.testsMapped).toBe(1);
  });

  it('marks deleted entities as broken on re-scan', async () => {
    write('src/a.ts', 'export function alpha() {}\nexport function beta() {}');
    const r1 = await scanRepository(projectDir, 'tproj-rescan');
    expect(r1.extracted).toBe(2);

    // Delete beta from source
    write('src/a.ts', 'export function alpha() {}');
    const r2 = await scanRepository(projectDir, 'tproj-rescan');
    expect(r2.extracted).toBe(1);
    expect(r2.removed).toBeGreaterThanOrEqual(1);
  });
});

describe('scanRepository — relation graph (calls/extends/implements)', () => {
  it('loads a calls edge between two same-file functions', async () => {
    write('src/mod.ts', `
export function helper() { return 1; }
export function caller() { return helper(); }
`.trim());

    const result = await scanRepository(projectDir, 'rel-1');
    expect(result.relationsLoaded).toBeGreaterThanOrEqual(1);

    const store = getRegistryStore();
    const callerEnts = store.findEntitiesByName('caller', 'rel-1');
    expect(callerEnts).toHaveLength(1);
    const callees = store.getOutgoingRelations(callerEnts[0].id);
    expect(callees.map((c) => c.targetName)).toContain('helper');
  });

  it('records the reverse direction (who-calls)', async () => {
    write('src/mod.ts', `
export function leaf() { return 1; }
export function a() { return leaf(); }
export function b() { return leaf(); }
`.trim());

    await scanRepository(projectDir, 'rel-2');
    const store = getRegistryStore();
    const leaf = store.findEntitiesByName('leaf', 'rel-2')[0];
    const callers = store.getIncomingRelations(leaf.id);
    expect(callers.map((c) => c.sourceName).sort()).toEqual(['a', 'b']);
  });

  it('computes transitive impact set via reverse BFS', async () => {
    // c -> b -> a  (a is the leaf; changing a impacts b and c)
    write('src/chain.ts', `
export function a() { return 1; }
export function b() { return a(); }
export function c() { return b(); }
`.trim());

    await scanRepository(projectDir, 'rel-3');
    const store = getRegistryStore();
    const a = store.findEntitiesByName('a', 'rel-3')[0];
    const impact = store.getImpactSet(a.id);
    const names = impact.map((i) => i.name).sort();
    expect(names).toEqual(['b', 'c']);
    // b is direct (depth 1), c is indirect (depth 2)
    expect(impact.find((i) => i.name === 'b')?.depth).toBe(1);
    expect(impact.find((i) => i.name === 'c')?.depth).toBe(2);
  });

  it('records an extends edge for class inheritance', async () => {
    write('src/cls.ts', `
export class Base { run() {} }
export class Derived extends Base { go() {} }
`.trim());

    await scanRepository(projectDir, 'rel-4');
    const store = getRegistryStore();
    const derived = store.findEntitiesByName('Derived', 'rel-4')[0];
    const rels = store.getOutgoingRelations(derived.id, 'extends');
    expect(rels.map((r) => r.targetName)).toContain('Base');
  });

  it('resolves an imported symbol despite same-name declarations in other files', async () => {
    // The import binding identifies x.ts; y.ts must never enter this edge.
    write('src/x.ts', 'export function shared() { return 1; }');
    write('src/y.ts', 'export function shared() { return 2; }');
    write('src/z.ts', `
import { shared } from './x';
export function uses() { return shared(); }
`.trim());

    await scanRepository(projectDir, 'rel-5');
    const store = getRegistryStore();
    const uses = store.findEntitiesByName('uses', 'rel-5')[0];
    const callees = store.getOutgoingRelations(uses.id);
    expect(callees.map((c) => c.targetName)).toEqual(['shared']);
    expect(callees[0].targetFile).toBe('src/x.ts');
  });

  it('clears stale edges on re-scan', async () => {
    write('src/r.ts', `
export function target() { return 1; }
export function user() { return target(); }
`.trim());
    const r1 = await scanRepository(projectDir, 'rel-6');
    expect(r1.relationsLoaded).toBeGreaterThanOrEqual(1);

    // Remove the call → edge must disappear
    write('src/r.ts', `
export function target() { return 1; }
export function user() { return 99; }
`.trim());
    await scanRepository(projectDir, 'rel-6');
    const store = getRegistryStore();
    expect(store.countRelations('rel-6')).toBe(0);
  });

  it('preserves existing edges when an oversized file makes the scan incomplete', async () => {
    write('src/r.ts', `
export function target() { return 1; }
export function user() { return target(); }
`.trim());
    await scanRepository(projectDir, 'rel-partial');
    const store = getRegistryStore();
    const before = store.countRelations('rel-partial');
    expect(before).toBeGreaterThan(0);

    write('src/oversized.ts', 'export const huge = "' + 'x'.repeat(600 * 1024) + '";');
    const result = await scanRepository(projectDir, 'rel-partial');

    expect(result.errors.some((error) => error.includes('oversized.ts'))).toBe(true);
    expect(result.relationsLoaded).toBe(0);
    expect(store.countRelations('rel-partial')).toBe(before);
  });

  it('rolls back reconciliation when registering the new snapshot fails', async () => {
    write('src/r.ts', 'export function target() { return 1; }\nexport function user() { return target(); }');
    await scanRepository(projectDir, 'rel-persist-failure');
    const store = getRegistryStore();
    const relationsBefore = store.countRelations('rel-persist-failure');

    write('src/r.ts', 'export function target() { return 2; }\nexport function replacement() { return target(); }');
    const register = vi.spyOn(store, 'registerEntity').mockImplementationOnce(() => {
      throw new Error('database is full');
    });
    const result = await scanRepository(projectDir, 'rel-persist-failure');
    register.mockRestore();

    expect(result.errors).toContain('register src/r.ts::replacement: database is full');
    expect(result.registered).toBe(0);
    expect(result.relationsLoaded).toBe(0);
    expect(store.getEntityByName('src/r.ts::user', 'rel-persist-failure')?.status).toBe('active');
    expect(store.countRelations('rel-persist-failure')).toBe(relationsBefore);
  });
});

describe('scanRepository — broken zombie restore (INT-1477)', () => {
  it('restores scanner-authored broken entities to active when rediscovered, reviving relations and name lookup', async () => {
    const store = getRegistryStore();
    const code = 'export function alpha() { return 1; }\nexport function beta() { return alpha(); }';

    // 1차 스캔: alpha/beta 등록 + beta→alpha edge
    write('src/a.ts', code);
    await scanRepository(projectDir, 'tproj-restore');
    expect(store.getEntityByName('src/a.ts::beta', 'tproj-restore')?.status).toBe('active');
    expect(store.countRelations('tproj-restore')).toBeGreaterThanOrEqual(1);

    // beta 삭제 → broken + edge 소멸 + 이름 검색에서 제외
    write('src/a.ts', 'export function alpha() { return 1; }');
    await scanRepository(projectDir, 'tproj-restore');
    expect(store.getEntityByName('src/a.ts::beta', 'tproj-restore')?.status).toBe('broken');
    expect(store.findEntitiesByName('beta', 'tproj-restore')).toHaveLength(0);
    expect(store.countRelations('tproj-restore')).toBe(0);

    // beta 복구 → active 복원 + edge 부활 + 이름 검색 복귀
    write('src/a.ts', code);
    const r3 = await scanRepository(projectDir, 'tproj-restore');
    expect(r3.registered).toBe(0); // 새 등록이 아니라 기존 행 복원이어야 함
    const beta = store.getEntityByName('src/a.ts::beta', 'tproj-restore');
    expect(beta?.status).toBe('active');
    expect(store.findEntitiesByName('beta', 'tproj-restore')).toHaveLength(1);

    const alpha = store.findEntitiesByName('alpha', 'tproj-restore')[0];
    const callers = store.getIncomingRelations(alpha.id, 'calls');
    expect(callers.some(r => r.sourceName === 'beta')).toBe(true);
  });

  it('does not restore broken entities that were not authored by the scanner', async () => {
    const store = getRegistryStore();
    const manual = store.registerEntity({
      projectId: 'tproj-manual',
      kind: 'function',
      name: 'gamma',
      filePath: 'src/m.ts',
      status: 'active',
      author: 'human',
    });
    store.changeEntityStatus(manual.id, 'broken');

    write('src/m.ts', 'export function gamma() { return 3; }');
    await scanRepository(projectDir, 'tproj-manual');

    expect(store.getEntity(manual.id)?.status).toBe('broken');
  });
});

describe('scanRepository — v3 scanner metric persistence (INT-3881)', () => {
  it('persists is_exported/loc/nesting_depth/param_count instead of discarding them', async () => {
    write('src/metrics.ts', [
      'export function withParams(a: number, b: number, c: number) {',
      '  if (a > 0) {',
      '    if (b > 0) {',
      '      return a + b + c;',
      '    }',
      '  }',
      '  return 0;',
      '}',
    ].join('\n'));

    await scanRepository(projectDir, 'tproj-v3');

    const store = getRegistryStore();
    const ent = store.getEntityByName('src/metrics.ts::withParams', 'tproj-v3');
    expect(ent).not.toBeNull();
    expect(ent?.isExported).toBe(true);
    expect(ent?.paramCount).toBe(3);
    expect(ent?.loc).toBeGreaterThan(0);
    expect(ent?.nestingDepth).toBeGreaterThanOrEqual(2);
  });
});
