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
  it('persists model provenance and preserves the full snapshot on invalid models or late storage failure', async () => {
    const config = { schemaVersion: 1, versions: { node: '22.19.0' }, assumptions: ['unmodified-external-bindings'], packs: [] };
    write('.cxt-models.json', JSON.stringify(config));
    write('x.ts', "import {basename} from 'node:path';function f(){return basename('x');}");
    const result = await scanRepository(projectDir, 'models', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    expect(result.models.calls).toEqual({ applied: 1 });
    const store = getRegistryStore(), before = store.getDataflow('models'), manifest = store.getModelManifest('models');
    expect(manifest).toEqual(result.models.manifest);
    expect(store.getCallSites('models')[0].external).toEqual({ language: 'typescript', module: 'node:path', symbol: 'basename' });
    write('.cxt-models.json', JSON.stringify({ ...config, versions: { node: '>=22' } }));
    await expect(scanRepository(projectDir, 'models', { parser: 'ast' })).rejects.toThrow();
    expect(store.getDataflow('models')).toEqual(before);
    expect(store.getModelManifest('models')).toEqual(manifest);
    write('.cxt-models.json', JSON.stringify({ ...config, versions: { node: '24.0.0' } }));
    write('x.ts', 'function changed(){return 7;}');
    vi.spyOn(store, 'replaceRelationsForProject').mockImplementation(() => { throw new Error('model snapshot failure'); });
    const failed = await scanRepository(projectDir, 'models', { parser: 'ast' });
    expect(failed.errors).toEqual(['model snapshot failure']);
    expect(failed.models.calls).toEqual({});
    expect(store.getModelManifest('models')).toEqual(manifest);
    expect(store.getDataflow('models')).toEqual(before);
    expect(store.getEntityByName('changed', 'models')).toBeNull();
  });

  it('persists modeled callback registration edges separately from direct calls', async () => {
    write('.cxt-models.json', JSON.stringify({ schemaVersion: 1, versions: { 'npm:callback-api': '1.0.0' }, assumptions: ['unmodified-external-bindings'], packs: ['callbacks.json'] }));
    write('callbacks.json', JSON.stringify({ schemaVersion: 1, id: 'callback.pack', version: '1.0.0', models: [{
      id: 'register', language: 'typescript', module: 'callback-api', symbol: 'register', package: 'npm:callback-api',
      versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['string', 'any'],
      returns: { type: 'unit', dependsOn: [] }, effects: 'none', callbacks: [{ parameter: 1 }],
      throws: { possible: false, dependsOn: [] }, source: 'https://example.com/callback-api/register',
    }] }));
    write('x.ts', "import {register} from 'callback-api';function handler(){}function f(){register('ready', handler);}");
    const result = await scanRepository(projectDir, 'callback-edges', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const store = getRegistryStore();
    const entities = store.listEntities({ projectId: 'callback-edges' }).entities;
    const owner = entities.find(entity => entity.qualifiedName === 'x.ts::f')!;
    const handler = entities.find(entity => entity.qualifiedName === 'x.ts::handler')!;
    expect(store.getRelations(owner.id)).toContainEqual({ targetId: handler.id, targetName: 'handler', relationType: 'registers' });
  });

  it('exposes taint findings and sink summaries through read-only fact queries', async () => {
    write('.cxt-models.json', JSON.stringify({ schemaVersion: 1, versions: { 'npm:taint-api': '1.0.0' }, assumptions: ['unmodified-external-bindings'], packs: ['taint.json'] }));
    const base = { language: 'typescript', module: 'taint-api', package: 'npm:taint-api', versions: { min: '1.0.0', before: '2.0.0' }, effects: 'none', throws: { possible: false, dependsOn: [] }, source: 'https://example.com/taint' };
    write('taint.json', JSON.stringify({ schemaVersion: 1, id: 'taint-pack', version: '1.0.0', models: [
      { ...base, id: 'source', symbol: 'source', parameters: [], returns: { type: 'unknown', dependsOn: [] }, taint: { source: true } },
      { ...base, id: 'sink', symbol: 'sink', parameters: ['any'], returns: { type: 'unit', dependsOn: [] }, taint: { sinkParameters: [0] } },
    ] }));
    write('x.ts', "import {source, sink} from 'taint-api';function wrap(value){sink(value);}function f(){wrap(source());}");
    const result = await scanRepository(projectDir, 'taint-query', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const store = getRegistryStore();
    expect(store.queryFacts('taint-query', { view: 'flows', where: [{ column: 'taint_finding_count', op: 'eq', value: 1 }] })
      .some(row => row.owner === 'x.ts::f')).toBe(true);
    expect(store.queryFacts('taint-query', { view: 'taints', where: [{ column: 'owner', op: 'eq', value: 'x.ts::f' }] }))
      .toEqual([expect.objectContaining({ owner: 'x.ts::f', parameter: 0, atoms: '["tainted"]' })]);
    expect(store.queryFacts('taint-query', { view: 'summaries', where: [{ column: 'taint_sink_parameter_count', op: 'eq', value: 1 }] })
      .some(row => row.owner === 'x.ts::wrap')).toBe(true);
  });

  it('propagates an unambiguous Python exception hierarchy across files', async () => {
    write('errors.py', 'class MyError(ValueError):\n pass\n');
    write('app.py', 'def f():\n try:\n  raise MyError\n except Exception:\n  return 1\n return 2\n');
    const result = await scanRepository(projectDir, 'python-exception-hierarchy', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const flow = getRegistryStore().getDataflow('python-exception-hierarchy').find(item => item.owner === 'app.py::f')!;
    expect(flow.completeness).toBe('complete');
    expect(flow.returns.map(item => item.value.atoms)).toContainEqual(['number:1']);
  });

  it('keeps duplicate Python exception names exact-only across files', async () => {
    write('one/errors.py', 'class MyError(ValueError):\n pass\n');
    write('two/errors.py', 'class MyError(TypeError):\n pass\n');
    write('app.py', 'def f():\n try:\n  raise MyError\n except Exception:\n  return 1\n return 2\n');
    const result = await scanRepository(projectDir, 'python-exception-collision', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const flow = getRegistryStore().getDataflow('python-exception-collision').find(item => item.owner === 'app.py::f')!;
    expect(flow.completeness).toBe('complete');
    expect(flow.returns.map(item => item.value.atoms)).not.toContainEqual(['number:1']);
    expect(flow.throws.length).toBeGreaterThan(0);
  });

  it('follows a Python imported exception base through a project hierarchy', async () => {
    write('errors.py', 'class Base(ValueError):\n pass\n');
    write('child.py', 'from errors import Base\nclass Child(Base):\n pass\n');
    write('app.py', 'def f():\n try:\n  raise Child\n except ValueError:\n  return 1\n return 2\n');
    const result = await scanRepository(projectDir, 'python-exception-chain', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const flow = getRegistryStore().getDataflow('python-exception-chain').find(item => item.owner === 'app.py::f')!;
    expect(flow.returns.map(item => item.value.atoms)).toContainEqual(['number:1']);
  });

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

  it('applies project-level Rust Copy proofs to parameter ownership summaries', async () => {
    write('src/types.rs', 'pub struct Value { pub value: i32 } impl Copy for Value {}');
    write('src/consumer.rs', 'fn consume(value: Value) { let owned = value; value; }');
    const result = await scanRepository(projectDir, 'copy-cross-file', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const summary = getRegistryStore().getSummaries('copy-cross-file').find(item => item.owner === 'src/consumer.rs::consume');
    expect(summary?.movesParameters).toBeUndefined();
    expect(getRegistryStore().getDataflow('copy-cross-file').find(item => item.owner === 'src/consumer.rs::consume')?.ownershipFindings).toEqual([]);
  });

  it('applies Rust derive(Copy) proofs across files', async () => {
    write('src/types.rs', '#[derive(Copy, Clone)]\npub struct Token { pub value: u32 }');
    write('src/consumer.rs', 'fn consume(value: Token) { let owned = value; value; }');
    const result = await scanRepository(projectDir, 'derive-copy-cross-file', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const summary = getRegistryStore().getSummaries('derive-copy-cross-file').find(item => item.owner === 'src/consumer.rs::consume');
    expect(summary?.movesParameters).toBeUndefined();
    expect(getRegistryStore().getDataflow('derive-copy-cross-file').find(item => item.owner === 'src/consumer.rs::consume')?.ownershipFindings).toEqual([]);
  });

  it('keeps ambiguous cross-file Rust Copy names conservative', async () => {
    write('src/copy.rs', 'pub struct Value { pub value: i32 } impl Copy for Value {}');
    write('src/noncopy.rs', 'pub struct Value { pub value: i32 }');
    write('src/consumer.rs', 'fn consume(value: Value) { let owned = value; value; }');
    const result = await scanRepository(projectDir, 'copy-ambiguous', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const summary = getRegistryStore().getSummaries('copy-ambiguous').find(item => item.owner === 'src/consumer.rs::consume');
    expect(summary?.movesParameters).toEqual([0]);
  });

  it('exposes persisted Rust ownership and summary counts through fact queries', async () => {
    write('src/ownership.rs', 'struct Value { value: i32 } fn consume(value: Value) { let owned = value; value.value; } fn caller() { let x = Value { value: 1 }; let y = x; x.value; }');
    const result = await scanRepository(projectDir, 'semantic-query', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const store = getRegistryStore();
    expect(store.queryFacts('semantic-query', { view: 'flows', where: [{ column: 'ownership_finding_count', op: 'eq', value: 1 }] })
      .some(row => row.owner === 'src/ownership.rs::caller')).toBe(true);
    expect(store.queryFacts('semantic-query', { view: 'summaries', where: [{ column: 'moved_parameter_count', op: 'eq', value: 1 }] })
      .some(row => row.owner === 'src/ownership.rs::consume')).toBe(true);
  });

  it('uses project tsconfig path aliases during the persisted call-site pass', async () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } }));
    write('src/lib.ts', 'export function run() {}');
    write('src/main.ts', "import {run} from '@app/lib'; function caller(){run();}");
    const result = await scanRepository(projectDir, 'tsconfig-alias', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    expect(result.callSites.resolved).toBeGreaterThan(0);
    expect(getRegistryStore().getCallSites('tsconfig-alias').find(call => call.expression === 'run')).toMatchObject({ resolution: 'resolved', target: 'src/lib.ts::run', reason: 'import' });
  });

  it('resolves workspace package imports from package.json names during scan', async () => {
    write('packages/core/package.json', JSON.stringify({ name: '@workspace/core' }));
    write('packages/core/index.ts', 'export function run() {}');
    write('src/main.ts', "import {run} from '@workspace/core'; function caller(){run();}");
    const result = await scanRepository(projectDir, 'workspace-package', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    expect(getRegistryStore().getCallSites('workspace-package').find(call => call.expression === 'run')).toMatchObject({ resolution: 'resolved', target: 'packages/core/index.ts::run', reason: 'import' });
  });

  it('resolves unique interface implementations and preserves ambiguous dispatch', async () => {
    write('src/runner.ts', 'export interface Runner { run(): void } export class Impl implements Runner { run() {} }');
    write('src/main.ts', "import {Runner} from './runner'; function caller(x: Runner){x.run();}");
    const result = await scanRepository(projectDir, 'interface-dispatch', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    expect(getRegistryStore().getCallSites('interface-dispatch').find(call => call.expression === 'x.run')).toMatchObject({
      resolution: 'resolved', target: 'src/runner.ts::Impl.run', reason: 'receiver-type',
    });
  });

  it('resolves a unique Rust trait implementation in persisted call sites', async () => {
    write('src/runner.rs', 'trait Runner { fn run(&self); } struct Impl; impl Runner for Impl { fn run(&self){} } fn caller(x: Runner){ x.run(); }');
    const result = await scanRepository(projectDir, 'rust-trait-dispatch', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    expect(getRegistryStore().getCallSites('rust-trait-dispatch').find(call => call.expression === 'x.run')).toMatchObject({
      resolution: 'resolved', target: 'src/runner.rs::<Impl as Runner>.run', reason: 'receiver-type',
    });
  });

  it('persists TypeScript instanceof narrowing in call-site resolution', async () => {
    write('src/narrow.ts', 'class A { run() {} } class B { run() {} } function caller(x: A | B){ if (x instanceof A) { x.run(); } x.run(); }');
    const result = await scanRepository(projectDir, 'instanceof-narrowing', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const calls = getRegistryStore().getCallSites('instanceof-narrowing').filter(call => call.expression === 'x.run');
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ resolution: 'resolved', target: 'src/narrow.ts::A.run', reason: 'receiver-type' }),
      expect.objectContaining({ resolution: 'unresolved', reason: 'ambiguous-binding' }),
    ]));
  });

  it('persists TypeScript instanceof exclusion in an else branch', async () => {
    write('src/narrow.ts', 'class A { run() {} } class B { run() {} } function caller(x: A | B){ if (x instanceof A) { afterA(); } else { x.run(); } }');
    const result = await scanRepository(projectDir, 'instanceof-exclusion', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    expect(getRegistryStore().getCallSites('instanceof-exclusion').find(call => call.expression === 'x.run')).toMatchObject({
      resolution: 'resolved', target: 'src/narrow.ts::B.run', reason: 'receiver-type',
    });
  });

  it('persists TypeScript in-property union narrowing in call sites', async () => {
    write('src/in-narrow.ts', 'class A { run() {} } class B { stop() {} } function caller(x: A | B){ if ("run" in x) { x.run(); } else { x.stop(); } }');
    const result = await scanRepository(projectDir, 'in-property-narrowing', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const calls = getRegistryStore().getCallSites('in-property-narrowing');
    expect(calls.find(call => call.expression === 'x.run')).toMatchObject({ resolution: 'resolved', target: 'src/in-narrow.ts::A.run', reason: 'receiver-type' });
    expect(calls.find(call => call.expression === 'x.stop')).toMatchObject({ resolution: 'resolved', target: 'src/in-narrow.ts::B.stop', reason: 'receiver-type' });
  });

  it('persists Python isinstance union narrowing in call sites', async () => {
    write('src/narrow.py', 'class A:\n def run(self): pass\nclass B:\n def stop(self): pass\ndef caller(x: A | B):\n if isinstance(x, A):\n  x.run()\n else:\n  x.stop()');
    const result = await scanRepository(projectDir, 'python-isinstance-narrowing', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const calls = getRegistryStore().getCallSites('python-isinstance-narrowing');
    expect(calls.find(call => call.expression === 'x.run')).toMatchObject({ resolution: 'resolved', target: 'src/narrow.py::A.run', reason: 'receiver-type' });
    expect(calls.find(call => call.expression === 'x.stop')).toMatchObject({ resolution: 'resolved', target: 'src/narrow.py::B.stop', reason: 'receiver-type' });
  });

  it('persists negated Python isinstance narrowing in call sites', async () => {
    write('src/negated.py', 'class A:\n def run(self): pass\nclass B:\n def stop(self): pass\ndef caller(x: A | B):\n if not isinstance(x, A):\n  x.stop()\n else:\n  x.run()');
    const result = await scanRepository(projectDir, 'python-negated-isinstance', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const calls = getRegistryStore().getCallSites('python-negated-isinstance');
    expect(calls.find(call => call.expression === 'x.stop')).toMatchObject({ resolution: 'resolved', target: 'src/negated.py::B.stop', reason: 'receiver-type' });
    expect(calls.find(call => call.expression === 'x.run')).toMatchObject({ resolution: 'resolved', target: 'src/negated.py::A.run', reason: 'receiver-type' });
  });

  it('persists discriminated object type-alias narrowing in call-site resolution', async () => {
    write('src/narrow.ts', 'export type A = { kind: "a"; run(): void }; export type B = { kind: "b"; run(): void }; export class ImplA implements A { kind: "a"; run() {} } export class ImplB implements B { kind: "b"; run() {} } function caller(x: A | B){ if (x.kind === "a") { x.run(); } }');
    const result = await scanRepository(projectDir, 'discriminant-alias-narrowing', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    expect(getRegistryStore().getCallSites('discriminant-alias-narrowing').find(call => call.expression === 'x.run')).toMatchObject({
      resolution: 'resolved', target: 'src/narrow.ts::ImplA.run', reason: 'receiver-type',
    });
  });

  it('resolves discriminants declared in an imported TypeScript module', async () => {
    write('src/types.ts', 'export interface A { kind: "a"; run(): void } export interface B { kind: "b"; run(): void } export class ImplA implements A { kind: "a"; run() {} } export class ImplB implements B { kind: "b"; run() {} }');
    write('src/main.ts', 'import {A, B} from "./types"; function caller(x: A | B){ if (x.kind === "a") { x.run(); } }');
    const result = await scanRepository(projectDir, 'cross-file-discriminant', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    expect(getRegistryStore().getCallSites('cross-file-discriminant').find(call => call.expression === 'x.run')).toMatchObject({
      resolution: 'resolved', target: 'src/types.ts::ImplA.run', reason: 'receiver-type',
    });
  });

  it('persists TypeScript discriminant switch-case call resolution', async () => {
    write('src/switch.ts', 'interface A { kind: "a"; run(): void } interface B { kind: "b"; run(): void } class ImplA implements A { kind: "a"; run() {} } class ImplB implements B { kind: "b"; run() {} } function caller(x: A | B){ switch (x.kind) { case "a": x.run(); break; default: x.run(); } }');
    const result = await scanRepository(projectDir, 'switch-discriminant', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const calls = getRegistryStore().getCallSites('switch-discriminant').filter(call => call.expression === 'x.run');
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ resolution: 'resolved', target: 'src/switch.ts::ImplA.run', reason: 'receiver-type' }),
      expect.objectContaining({ resolution: 'resolved', target: 'src/switch.ts::ImplB.run', reason: 'receiver-type' }),
    ]));
  });

  it('honors package.json exports and rejects private workspace subpaths', async () => {
    write('packages/core/package.json', JSON.stringify({ name: '@workspace/core', exports: { '.': './index.ts' } }));
    write('packages/core/index.ts', 'export function run() {}');
    write('packages/core/private.ts', 'export function hidden() {}');
    write('src/main.ts', "import {run} from '@workspace/core'; import {hidden} from '@workspace/core/private'; function caller(){run();hidden();}");
    const result = await scanRepository(projectDir, 'workspace-exports', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const calls = getRegistryStore().getCallSites('workspace-exports');
    expect(calls.find(call => call.expression === 'run')).toMatchObject({ resolution: 'resolved', target: 'packages/core/index.ts::run' });
    expect(calls.find(call => call.expression === 'hidden')).toMatchObject({ resolution: 'unresolved', reason: 'missing-module' });
  });

  it('resolves conditional and wildcard package exports while keeping private paths closed', async () => {
    write('packages/core/package.json', JSON.stringify({ name: '@workspace/core', exports: {
      '.': { import: './index.js', default: './index.ts' },
      './features/*': { types: './features/*.d.ts', import: './features/*.js' },
    } }));
    write('packages/core/index.ts', 'export function run() {}');
    write('packages/core/features/fast.ts', 'export function fast() {}');
    write('packages/core/private.ts', 'export function hidden() {}');
    write('src/main.ts', "import {run} from '@workspace/core'; import {fast} from '@workspace/core/features/fast'; import {hidden} from '@workspace/core/private'; function caller(){run();fast();hidden();}");
    const result = await scanRepository(projectDir, 'workspace-conditional-exports', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    const calls = getRegistryStore().getCallSites('workspace-conditional-exports');
    expect(calls.find(call => call.expression === 'run')).toMatchObject({ resolution: 'resolved', target: 'packages/core/index.ts::run' });
    expect(calls.find(call => call.expression === 'fast')).toMatchObject({ resolution: 'resolved', target: 'packages/core/features/fast.ts::fast' });
    expect(calls.find(call => call.expression === 'hidden')).toMatchObject({ resolution: 'unresolved', reason: 'missing-module' });
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
    const summaries = store.getSummaries('ast-failure');
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
    expect(store.getSummaries('ast-failure')).toEqual(summaries);
  });

  it('atomically rolls back entities, call facts and relations when final relation persistence fails', async () => {
    write('src/x.ts', 'function run() { run(); }');
    await scanRepository(projectDir, 'rollback', { parser: 'ast' });
    const store = getRegistryStore();
    const before = store.listEntities({ projectId: 'rollback' });
    const sites = store.getCallSites('rollback');
    const cfgs = store.getControlFlow('rollback');
    const flows = store.getDataflow('rollback');
    const summaries = store.getSummaries('rollback');
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
    expect(store.getSummaries('rollback')).toEqual(summaries);
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
