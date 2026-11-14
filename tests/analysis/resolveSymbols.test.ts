import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractFile } from '../../src/registry/entityScanner.js';
import { resolveSymbols } from '../../src/analysis/resolveSymbols.js';
import { loadCallCorpus } from '../../bench/call-accuracy.js';
const fixtures = loadCallCorpus();

describe('symbol resolution: handwritten multi-file call-site oracle', () => {
  it('keeps the resolver source parseable by the project TypeScript frontend', () => {
    const source = readFileSync(new URL('../../src/analysis/resolveSymbols.ts', import.meta.url), 'utf8');
    expect(() => extractFile(source, 'src/analysis/resolveSymbols.ts', 'typescript', 'ast')).not.toThrow();
  });

  it('resolves TypeScript path aliases when the project mapping is supplied', () => {
    const files = {
      'src/lib.ts': 'export function run() {}',
      'src/main.ts': "import {run} from '@app/lib'; run();",
    };
    const facts = Object.entries(files).map(([file, source]) => extractFile(source, file, 'typescript', 'ast').symbols!);
    const calls = resolveSymbols(facts, { typescriptPaths: { '@app/*': ['src/*'] }, typescriptBaseUrl: '.' }).calls;
    expect(calls.find(call => call.expression === 'run')).toMatchObject({ target: 'src/lib.ts::run', resolution: 'resolved', reason: 'import' });
  });

  it('resolves workspace package subpaths when package roots are supplied', () => {
    const files = {
      'packages/core/index.ts': 'export function run() {}',
      'src/main.ts': "import {run} from '@workspace/core'; run();",
    };
    const facts = Object.entries(files).map(([file, source]) => extractFile(source, file, 'typescript', 'ast').symbols!);
    const calls = resolveSymbols(facts, { typescriptPackageRoots: { '@workspace/core': 'packages/core' } }).calls;
    expect(calls.find(call => call.expression === 'run')).toMatchObject({ target: 'packages/core/index.ts::run', resolution: 'resolved', reason: 'import' });
  });

  it('does not resolve package subpaths absent from an explicit export mapping', () => {
    const files = {
      'packages/core/index.ts': 'export function run() {}',
      'src/main.ts': "import {run} from '@workspace/core/private'; run();",
    };
    const facts = Object.entries(files).map(([file, source]) => extractFile(source, file, 'typescript', 'ast').symbols!);
    const calls = resolveSymbols(facts, {
      typescriptPackageRoots: { '@workspace/core': 'packages/core' },
      typescriptPackageMappings: { '@workspace/core': ['packages/core/index.ts'] },
      typescriptRestrictedPackages: ['@workspace/core'],
    }).calls;
    expect(calls.find(call => call.expression === 'run')).toMatchObject({ resolution: 'unresolved', reason: 'missing-module' });
  });

  it('resolves package export patterns against indexed source files', () => {
    const files = {
      'packages/core/features/fast.ts': 'export function run() {}',
      'src/main.ts': "import {run} from '@workspace/core/features/fast'; run();",
    };
    const facts = Object.entries(files).map(([file, source]) => extractFile(source, file, 'typescript', 'ast').symbols!);
    const calls = resolveSymbols(facts, {
      typescriptPackagePatterns: [{ pattern: '@workspace/core/features/*', targets: ['packages/core/features/*.ts'] }],
    }).calls;
    expect(calls.find(call => call.expression === 'run')).toMatchObject({ target: 'packages/core/features/fast.ts::run', resolution: 'resolved', reason: 'import' });
  });

  it('keeps a conditional export with no indexed target unresolved', () => {
    const facts = [extractFile("import {run} from '@workspace/core'; run();", 'src/main.ts', 'typescript', 'ast').symbols!];
    const calls = resolveSymbols(facts, {
      typescriptPackageMappings: { '@workspace/core': ['packages/core/index.ts'] },
    }).calls;
    expect(calls.find(call => call.expression === 'run')).toMatchObject({ resolution: 'unresolved', reason: 'missing-module' });
  });

  for (const fixture of fixtures) it(fixture.id, () => {
    const facts = Object.entries(fixture.files).map(([file, source]) => extractFile(source, file, fixture.language, 'ast').symbols!);
    const actual = resolveSymbols(facts).calls;
    expect(actual).toHaveLength(fixture.expected.length);
    for (const [file, line, column, target, resolution, endLine, endColumn] of fixture.expected) {
      const sites = actual.filter(call => call.filePath === file && call.line === line && call.column === column
        && (endLine === undefined || (call.endLine === endLine && call.endColumn === endColumn)));
      expect(sites, `${file}:${line}:${column}`).toHaveLength(1);
      expect(sites[0].target ?? null, `${file}:${line}:${column}`).toBe(target);
      expect(sites[0].resolution).toBe(resolution ?? (target ? 'resolved' : 'unresolved'));
    }
  });

  it('records anonymous callback ownership instead of assigning callback calls to the outer function', () => {
    const facts = extractFile('function leaf() {}\nfunction outer() {\n  list.map(() => leaf());\n}', 'main.ts', 'typescript', 'ast').symbols!;
    const calls = resolveSymbols([facts]).calls;
    expect(calls.find(c => c.expression === 'leaf')?.caller).toBe('main.ts::outer.<lambda@3:12>');
    expect(calls.find(c => c.expression === 'list.map')?.caller).toBe('main.ts::outer');
  });

  it('does not bind shadowing loop/exception/match variables to same-name functions', () => {
    for (const [language, file, source] of [
      ['python', 'x.py', 'def run(): pass\ndef caller():\n for run in callbacks:\n  run()'],
      ['python', 'x.py', 'def run(): pass\ndef caller():\n try: pass\n except Error as run:\n  run()'],
      ['python', 'x.py', 'def run(): pass\ndef caller():\n return [run() for run in callbacks]'],
      ['rust', 'x.rs', 'fn run(){} fn caller(){for run in callbacks {run();}}'],
      ['rust', 'x.rs', 'fn run(){} fn caller(){match value {Some(run) => run(), _ => {}}}'],
      ['rust', 'x.rs', 'fn run(){} fn caller(){if let Some(run) = value {run();}}'],
    ] as const) {
      const facts = extractFile(source, file, language, 'ast').symbols!;
      expect(resolveSymbols([facts]).calls.filter(c => c.target), source).toEqual([]);
    }
  });

  it('rejects reads before initialization across nested blocks in the same function', () => {
    const facts = extractFile('function target(){} function caller(){ {f();} const f=target; }', 'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls[0]).toMatchObject({ resolution: 'unresolved', reason: 'uninitialized-binding' });
  });

  it('honors Python global and nonlocal bindings', () => {
    const source = 'def run(): pass\ndef outer():\n def run(): pass\n def global_call():\n  global run\n  run()\n def nonlocal_call():\n  nonlocal run\n  run()';
    const facts = extractFile(source, 'x.py', 'python', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.map(c => c.target)).toEqual(['x.py::run', 'x.py::outer.run']);
  });

  it('does not discard unknown star exports when choosing a target', () => {
    const files = { 'main.ts': "import {run} from './barrel'; run();", 'lib.ts': 'export function run() {}',
      'barrel.ts': "export * from './lib'; export * from 'external';" };
    const facts = Object.entries(files).map(([file, source]) => extractFile(source, file, 'typescript', 'ast').symbols!);
    expect(resolveSymbols(facts).calls[0]).toMatchObject({ resolution: 'unresolved', reason: 'ambiguous-binding' });
  });

  it('does not resolve an unknown own member to an inherited method', () => {
    const facts = extractFile('class Base { run(){} } class Child extends Base { run = unknown; } new Child().run();',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression.endsWith('.run'))?.target).toBeUndefined();
  });

  it('does not dispatch a receiver member after a proven member mutation', () => {
    const facts = extractFile('class Service { run() {} } function caller(){ const service = new Service(); service.run = unknown; service.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'service.run')).toMatchObject({
      resolution: 'unresolved', reason: 'reassigned-binding',
    });
  });

  it('resolves a uniquely implemented TypeScript interface receiver', () => {
    const facts = extractFile('interface Runner { run(): void } class Impl implements Runner { run() {} } function caller(x: Runner){ x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      target: 'x.ts::Impl.run', resolution: 'resolved', reason: 'receiver-type', confidence: 0.9,
    });
  });

  it('resolves TypeScript as and angle-bracket type assertions as receiver types', () => {
    const facts = extractFile('interface Runner { run(): void } function caller(value: any){ const a = value as Runner; a.run(); const b = <Runner>value; b.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    const calls = resolveSymbols([facts]).calls.filter(c => c.expression.endsWith('.run'));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ target: 'x.ts::Runner.run', resolution: 'resolved', reason: 'receiver-type' });
    expect(calls[1]).toMatchObject({ target: 'x.ts::Runner.run', resolution: 'resolved', reason: 'receiver-type' });
  });

  it('resolves a TypeScript generic receiver to its extends bound declaration', () => {
    const facts = extractFile('interface Runner { run(): void } function caller<T extends Runner>(x: T){ x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      target: 'x.ts::Runner.run', resolution: 'resolved', reason: 'receiver-type', confidence: 0.9,
    });
  });

  it('resolves a TypeScript generic receiver through intersection bounds', () => {
    const facts = extractFile('interface Runner { run(): void } interface Tagged { tag: string } function caller<T extends Runner & Tagged>(x: T){ x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      target: 'x.ts::Runner.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('keeps nested generic type arguments inside one TypeScript bound', () => {
    const facts = extractFile('interface Result {} interface Box<T> { run(): void } function caller<T extends Box<Result>>(x: T){ x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      target: 'x.ts::Box.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('keeps a generic intersection bound unresolved when one arm is unknown', () => {
    const facts = extractFile('interface Runner { run(): void } function caller<T extends Runner & Missing>(x: T){ x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      resolution: 'unresolved', reason: 'unknown-receiver',
    });
  });

  it('keeps a TypeScript union constraint ambiguous when only one arm has the member', () => {
    const facts = extractFile('interface Runner { run(): void } interface Tagged { tag: string } function caller<T extends Runner | Tagged>(x: T){ x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      resolution: 'unresolved', reason: 'ambiguous-binding',
    });
  });

  it('resolves a TypeScript union constraint when every arm converges on one method', () => {
    const facts = extractFile('class Base { run() {} } class A extends Base {} class B extends Base {} function caller<T extends A | B>(x: T){ x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      target: 'x.ts::Base.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('resolves an imported TypeScript generic bound to the imported interface method', () => {
    const files = {
      'types.ts': 'export interface Runner { run(): void }',
      'main.ts': 'import {Runner} from "./types"; function caller<T extends Runner>(x: T){ x.run(); }',
    };
    const facts = Object.entries(files).map(([file, source]) => extractFile(source, file, 'typescript', 'ast').symbols!);
    expect(resolveSymbols(facts).calls.find(c => c.expression === 'x.run')).toMatchObject({
      target: 'types.ts::Runner.run', resolution: 'resolved', reason: 'receiver-type', confidence: 0.9,
    });
  });

  it('resolves an identity TypeScript conditional alias at a concrete generic call site', () => {
    const facts = extractFile(
      'class TextResult { run() {} } class OtherResult { run() {} } type PickResult<T> = T extends string ? TextResult : OtherResult; function make(): PickResult<number> { return new OtherResult(); } function caller(){ make().run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'make')).toMatchObject({ target: 'x.ts::make', resolution: 'resolved' });
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'make().run')).toMatchObject({
      target: 'x.ts::OtherResult.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('keeps a conditional alias over mixed union arms ambiguous', () => {
    const facts = extractFile(
      'class TextResult { run() {} } class OtherResult { run() {} } type PickResult<T> = T extends string ? TextResult : OtherResult; function make(): PickResult<string | number> { return new OtherResult(); } function caller(){ make().run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'make().run')).toMatchObject({
      resolution: 'unresolved', reason: 'ambiguous-binding',
    });
  });

  it('resolves a simple TypeScript infer conditional through one generic container', () => {
    const facts = extractFile(
      'class Result { run() {} } interface Box<T> { value: T } type Unwrap<T> = T extends Box<infer U> ? U : never; function make(): Unwrap<Box<Result>> { return new Result(); } function caller(){ make().run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(facts.conditionalTypes?.['x.ts::Unwrap']).toMatchObject({ infer: { container: 'Box', parameter: 'U' } });
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'make().run')).toMatchObject({
      target: 'x.ts::Result.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('resolves a direct multi-infer conditional through one generic container', () => {
    const facts = extractFile(
      'class First { run() {} } class Second { run() {} } interface Pair<A, B> { first: A; second: B } type PickFirst<T> = T extends Pair<infer A, infer B> ? A : never; function make(): PickFirst<Pair<First, Second>> { return new First(); } function caller(){ make().run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(facts.conditionalTypes?.['x.ts::PickFirst']?.inferences).toEqual([
      { container: 'Pair', parameter: 'A', index: 0 },
      { container: 'Pair', parameter: 'B', index: 1 },
    ]);
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'make().run')).toMatchObject({
      target: 'x.ts::First.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('resolves a nested TypeScript infer conditional through generic containers', () => {
    const facts = extractFile(
      'class Result { run() {} } interface Box<T> { value: T } interface Pair<A, B> { first: A; second: B } type PickNested<T> = T extends Pair<infer A, Box<infer B>> ? B : never; function make(): PickNested<Pair<Result, Box<Result>>> { return new Result(); } function caller(){ make().run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(facts.conditionalTypes?.['x.ts::PickNested']?.inferencePatterns).toEqual([
      { path: [0], containers: ['Pair'], parameter: 'A' },
      { path: [1, 0], containers: ['Pair', 'Box'], parameter: 'B' },
    ]);
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'make().run')).toMatchObject({
      target: 'x.ts::Result.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('keeps interface dispatch ambiguous with multiple implementations', () => {
    const facts = extractFile('interface Runner { run(): void } class A implements Runner { run() {} } class B implements Runner { run() {} } function caller(x: Runner){ x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({ resolution: 'unresolved', reason: 'ambiguous-binding' });
  });

  it('resolves a uniquely implemented Rust trait receiver and rejects multiple impls', () => {
    const unique = extractFile('trait Runner { fn run(&self); } struct Impl; impl Runner for Impl { fn run(&self){} } fn caller(x: Runner){ x.run(); }',
      'x.rs', 'rust', 'ast').symbols!;
    expect(resolveSymbols([unique]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      target: 'x.rs::<Impl as Runner>.run', resolution: 'resolved', reason: 'receiver-type', confidence: 0.9,
    });
    expect(resolveSymbols([unique]).bases).toContainEqual({ source: 'x.rs::Impl', target: 'x.rs::Runner', type: 'implements' });
    const multiple = extractFile('trait Runner { fn run(&self); } struct A; impl Runner for A { fn run(&self){} } struct B; impl Runner for B { fn run(&self){} } fn caller(x: Runner){ x.run(); }',
      'x.rs', 'rust', 'ast').symbols!;
    expect(resolveSymbols([multiple]).calls.find(c => c.expression === 'x.run')).toMatchObject({ resolution: 'unresolved', reason: 'ambiguous-binding' });
  });

  it('resolves a Rust generic receiver to its trait declaration without guessing an impl', () => {
    const facts = extractFile('trait Runner { fn run(&self); } fn caller<T: Runner>(x: T){ x.run(); }',
      'x.rs', 'rust', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      target: 'x.rs::Runner.run', resolution: 'resolved', reason: 'receiver-type', confidence: 0.9,
    });
  });

  it('resolves Rust where-clause trait intersections through a shared method', () => {
    const facts = extractFile('trait Runner { fn run(&self); } trait Tagged { fn tag(&self); } fn caller<T>(x: T) where T: Runner + Tagged { x.run(); }',
      'x.rs', 'rust', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      target: 'x.rs::Runner.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('does not guess a concrete Rust impl for a generic intersection bound', () => {
    const facts = extractFile('trait Runner { fn run(&self); } trait Tagged { fn tag(&self); } struct Impl; impl Runner for Impl { fn run(&self){} } impl Tagged for Impl { fn tag(&self){} } fn caller<T>(x: T) where T: Runner + Tagged { x.run(); }',
      'x.rs', 'rust', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      target: 'x.rs::Runner.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('resolves union receivers only when all arms converge on one method', () => {
    const converged = extractFile('class Base { run() {} } class A extends Base {} class B extends Base {} function caller(x: A | B){ x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([converged]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      target: 'x.ts::Base.run', resolution: 'resolved', reason: 'receiver-type',
    });
    const divergent = extractFile('class A { run() {} } class B { run() {} } function caller(x: A | B){ x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([divergent]).calls.find(c => c.expression === 'x.run')).toMatchObject({ resolution: 'unresolved', reason: 'ambiguous-binding' });
  });

  it('resolves a TypeScript intersection receiver through a proven member', () => {
    const facts = extractFile('interface Runner { run(): void } interface Tagged { tag: string } function caller(x: Runner & Tagged){ x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      target: 'x.ts::Runner.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('keeps a Python base receiver ambiguous when an indexed subclass overrides the method', () => {
    const facts = extractFile('class Base:\n def run(self): pass\nclass Child(Base):\n def run(self): pass\ndef caller(x: Base):\n x.run()', 'x.py', 'python', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(c => c.expression === 'x.run')).toMatchObject({
      resolution: 'unresolved', reason: 'ambiguous-binding',
    });
  });

  it('narrows a union receiver inside a TypeScript instanceof branch only', () => {
    const facts = extractFile('class A { run() {} } class B { run() {} } function caller(x: A | B){ if (x instanceof A) { x.run(); } x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    const calls = resolveSymbols([facts]).calls.filter(call => call.expression === 'x.run');
    expect(calls[0]).toMatchObject({ target: 'x.ts::A.run', resolution: 'resolved', reason: 'receiver-type' });
    expect(calls[1]).toMatchObject({ resolution: 'unresolved', reason: 'ambiguous-binding' });
  });

  it('does not carry instanceof narrowing into a nested function with a shadowing parameter', () => {
    const facts = extractFile('class A { run() {} } class B { run() {} } function caller(x: A | B){ if (x instanceof A) { function inner(x: B){ x.run(); } inner(x); } }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(call => call.caller?.endsWith('caller.inner'))).toMatchObject({
      target: 'x.ts::B.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('narrows a single-statement instanceof consequence without braces', () => {
    const facts = extractFile('class A { run() {} } class B { run() {} } function caller(x: A | B){ if (x instanceof A) x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(call => call.expression === 'x.run')).toMatchObject({
      target: 'x.ts::A.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('excludes the instanceof type in a TypeScript else branch', () => {
    const facts = extractFile('class A { run() {} } class B { run() {} } function caller(x: A | B){ if (x instanceof A) { afterA(); } else { x.run(); } }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(call => call.expression === 'x.run')).toMatchObject({
      target: 'x.ts::B.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('narrows to the non-instanceof type in a negated TypeScript consequence', () => {
    const facts = extractFile('class A { run() {} } class B { run() {} } function caller(x: A | B){ if (!(x instanceof A)) { x.run(); } else { x.run(); } }',
      'x.ts', 'typescript', 'ast').symbols!;
    const calls = resolveSymbols([facts]).calls.filter(call => call.expression === 'x.run');
    expect(calls[0]).toMatchObject({ target: 'x.ts::B.run', resolution: 'resolved', reason: 'receiver-type' });
    expect(calls[1]).toMatchObject({ target: 'x.ts::A.run', resolution: 'resolved', reason: 'receiver-type' });
  });

  it('narrows a compound instanceof consequence without over-narrowing its alternative', () => {
    const facts = extractFile('class A { run() {} } class B { run() {} } function caller(x: A | B, ready: boolean){ if (x instanceof A && ready) { x.run(); } x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    const calls = resolveSymbols([facts]).calls.filter(call => call.expression === 'x.run');
    expect(calls[0]).toMatchObject({ target: 'x.ts::A.run', resolution: 'resolved', reason: 'receiver-type' });
    expect(calls[1]).toMatchObject({ resolution: 'unresolved', reason: 'ambiguous-binding' });
  });

  it('excludes every arm of a TypeScript instanceof disjunction in the alternative', () => {
    const facts = extractFile('class A { run() {} } class B { run() {} } class C { run() {} } function caller(x: A | B | C){ if (x instanceof A || x instanceof B) { ready(); } else { x.run(); } }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(call => call.expression === 'x.run')).toMatchObject({
      target: 'x.ts::C.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('narrows a TypeScript object union with an in-property check', () => {
    const facts = extractFile('class A { run() {} } class B { stop() {} } function caller(x: A | B){ if ("run" in x) { x.run(); } else { x.stop(); } }',
      'x.ts', 'typescript', 'ast').symbols!;
    const calls = resolveSymbols([facts]).calls;
    expect(calls.find(call => call.expression === 'x.run')).toMatchObject({
      target: 'x.ts::A.run', resolution: 'resolved', reason: 'receiver-type',
    });
    expect(calls.find(call => call.expression === 'x.stop')).toMatchObject({
      target: 'x.ts::B.stop', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('does not treat Python membership as TypeScript property narrowing', () => {
    const facts = extractFile('class A:\n def run(self): pass\ndef f(x):\n if "run" in x:\n  return x', 'x.py', 'python', 'ast').symbols!;
    expect(facts.propertyChecks).toEqual([]);
  });

  it('narrows Python class unions with isinstance in both branches', () => {
    const facts = extractFile('class A:\n def run(self): pass\nclass B:\n def stop(self): pass\ndef caller(x: A | B):\n if isinstance(x, A):\n  x.run()\n else:\n  x.stop()', 'x.py', 'python', 'ast').symbols!;
    const calls = resolveSymbols([facts]).calls;
    expect(calls.find(call => call.expression === 'x.run')).toMatchObject({ target: 'x.py::A.run', resolution: 'resolved', reason: 'receiver-type' });
    expect(calls.find(call => call.expression === 'x.stop')).toMatchObject({ target: 'x.py::B.stop', resolution: 'resolved', reason: 'receiver-type' });
  });

  it('handles negated and tuple Python isinstance checks conservatively', () => {
    const negated = extractFile('class A:\n def run(self): pass\nclass B:\n def stop(self): pass\ndef caller(x: A | B):\n if not isinstance(x, A):\n  x.stop()\n else:\n  x.run()', 'negated.py', 'python', 'ast').symbols!;
    const negatedCalls = resolveSymbols([negated]).calls;
    expect(negatedCalls.find(call => call.expression === 'x.stop')).toMatchObject({ target: 'negated.py::B.stop', resolution: 'resolved', reason: 'receiver-type' });
    expect(negatedCalls.find(call => call.expression === 'x.run')).toMatchObject({ target: 'negated.py::A.run', resolution: 'resolved', reason: 'receiver-type' });
    const tuple = extractFile('class A:\n def run(self): pass\nclass B:\n def stop(self): pass\nclass C:\n def close(self): pass\ndef caller(x: A | B | C):\n if isinstance(x, (A, B)):\n  ready()\n else:\n  x.close()', 'tuple.py', 'python', 'ast').symbols!;
    expect(resolveSymbols([tuple]).calls.find(call => call.expression === 'x.close')).toMatchObject({ target: 'tuple.py::C.close', resolution: 'resolved', reason: 'receiver-type' });
  });



  it('narrows a discriminated union inside a TypeScript branch', () => {
    const facts = extractFile('interface A { kind: "a"; run(): void } interface B { kind: "b"; run(): void } class ImplA implements A { kind: "a"; run() {} } class ImplB implements B { kind: "b"; run() {} } function caller(x: A | B){ if (x.kind === "a") { x.run(); } x.run(); }',
      'x.ts', 'typescript', 'ast').symbols!;
    const calls = resolveSymbols([facts]).calls.filter(call => call.expression === 'x.run');
    expect(calls[0]).toMatchObject({ target: 'x.ts::ImplA.run', resolution: 'resolved', reason: 'receiver-type' });
    expect(calls[1]).toMatchObject({ resolution: 'unresolved', reason: 'ambiguous-binding' });
  });

  it('collects discriminants from object type aliases', () => {
    const facts = extractFile('type A = { kind: "a"; run(): void }; type B = { kind: "b"; run(): void }; class ImplA implements A { kind: "a"; run() {} } class ImplB implements B { kind: "b"; run() {} } function caller(x: A | B){ if (x.kind === "a") { x.run(); } }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(call => call.expression === 'x.run')).toMatchObject({
      target: 'x.ts::ImplA.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('narrows the negative and else branches of a discriminant check', () => {
    const facts = extractFile('interface A { kind: "a"; run(): void } interface B { kind: "b"; run(): void } class ImplA implements A { kind: "a"; run() {} } class ImplB implements B { kind: "b"; run() {} } function caller(x: A | B){ if (x.kind !== "a") { x.run(); } else { x.run(); } }',
      'x.ts', 'typescript', 'ast').symbols!;
    const calls = resolveSymbols([facts]).calls.filter(call => call.expression === 'x.run');
    expect(calls[0]).toMatchObject({ target: 'x.ts::ImplB.run', resolution: 'resolved', reason: 'receiver-type' });
    expect(calls[1]).toMatchObject({ target: 'x.ts::ImplA.run', resolution: 'resolved', reason: 'receiver-type' });
  });

  it('uses imported discriminant declarations when narrowing a union', () => {
    const files = {
      'types.ts': 'export interface A { kind: "a"; run(): void } export interface B { kind: "b"; run(): void } export class ImplA implements A { kind: "a"; run() {} } export class ImplB implements B { kind: "b"; run() {} }',
      'main.ts': 'import {A, B} from "./types"; function caller(x: A | B){ if (x.kind === "a") { x.run(); } }',
    };
    const facts = Object.entries(files).map(([file, source]) => extractFile(source, file, 'typescript', 'ast').symbols!);
    expect(resolveSymbols(facts).calls.find(call => call.expression === 'x.run')).toMatchObject({
      target: 'types.ts::ImplA.run', resolution: 'resolved', reason: 'receiver-type',
    });
  });

  it('handles a disjunction of discriminant values and narrows its else arm', () => {
    const facts = extractFile('interface A { kind: "a"; run(): void } interface B { kind: "b"; run(): void } interface C { kind: "c"; run(): void } class ImplA implements A { kind: "a"; run() {} } class ImplB implements B { kind: "b"; run() {} } class ImplC implements C { kind: "c"; run() {} } function caller(x: A | B | C){ if (x.kind === "a" || x.kind === "b") { x.run(); } else { x.run(); } }',
      'x.ts', 'typescript', 'ast').symbols!;
    const calls = resolveSymbols([facts]).calls.filter(call => call.expression === 'x.run');
    expect(calls[0]).toMatchObject({ resolution: 'unresolved', reason: 'ambiguous-binding' });
    expect(calls[1]).toMatchObject({ target: 'x.ts::ImplC.run', resolution: 'resolved', reason: 'receiver-type' });
  });

  it('narrows the consequence of a discriminant check combined with another guard', () => {
    const facts = extractFile('interface A { kind: "a"; run(): void } interface B { kind: "b"; run(): void } class ImplA implements A { kind: "a"; run() {} } class ImplB implements B { kind: "b"; run() {} } function caller(x: A | B, ready: boolean){ if (x.kind === "a" && ready) { x.run(); } else { x.run(); } }',
      'x.ts', 'typescript', 'ast').symbols!;
    const calls = resolveSymbols([facts]).calls.filter(call => call.expression === 'x.run');
    expect(calls[0]).toMatchObject({ target: 'x.ts::ImplA.run', resolution: 'resolved', reason: 'receiver-type' });
    expect(calls[1]).toMatchObject({ resolution: 'unresolved', reason: 'ambiguous-binding' });
  });

  it('does not narrow an unsafe mixed discriminant disjunction', () => {
    const facts = extractFile('interface A { kind: "a"; run(): void } interface B { kind: "b"; run(): void } class ImplA implements A { kind: "a"; run() {} } class ImplB implements B { kind: "b"; run() {} } function caller(x: A | B, ready: boolean){ if (x.kind === "a" || ready) { x.run(); } }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(call => call.expression === 'x.run')).toMatchObject({
      resolution: 'unresolved', reason: 'ambiguous-binding',
    });
  });

  it('narrows TypeScript discriminated unions in switch cases', () => {
    const facts = extractFile('interface A { kind: "a"; run(): void } interface B { kind: "b"; run(): void } interface C { kind: "c"; run(): void } class ImplA implements A { kind: "a"; run() {} } class ImplB implements B { kind: "b"; run() {} } class ImplC implements C { kind: "c"; run() {} } function caller(x: A | B | C){ switch (x.kind) { case "a": x.run(); break; case "b": x.run(); break; default: x.run(); } }',
      'x.ts', 'typescript', 'ast').symbols!;
    const calls = resolveSymbols([facts]).calls.filter(call => call.expression === 'x.run');
    expect(calls[0]).toMatchObject({ target: 'x.ts::ImplA.run', resolution: 'resolved', reason: 'receiver-type' });
    expect(calls[1]).toMatchObject({ target: 'x.ts::ImplB.run', resolution: 'resolved', reason: 'receiver-type' });
    expect(calls[2]).toMatchObject({ target: 'x.ts::ImplC.run', resolution: 'resolved', reason: 'receiver-type' });
  });

  it('uses imported discriminants in switch cases and default', () => {
    const files = {
      'types.ts': 'export interface A { kind: "a"; run(): void } export interface B { kind: "b"; run(): void } export class ImplA implements A { kind: "a"; run() {} } export class ImplB implements B { kind: "b"; run() {} }',
      'main.ts': 'import {A, B} from "./types"; function caller(x: A | B){ switch (x.kind) { case "a": x.run(); break; default: x.run(); } }',
    };
    const facts = Object.entries(files).map(([file, source]) => extractFile(source, file, 'typescript', 'ast').symbols!);
    const calls = resolveSymbols(facts).calls.filter(call => call.expression === 'x.run');
    expect(calls[0]).toMatchObject({ target: 'types.ts::ImplA.run', resolution: 'resolved', reason: 'receiver-type' });
    expect(calls[1]).toMatchObject({ target: 'types.ts::ImplB.run', resolution: 'resolved', reason: 'receiver-type' });
  });

  it('keeps fallthrough case values in a switch narrowing', () => {
    const facts = extractFile('interface A { kind: "a"; run(): void } interface B { kind: "b"; run(): void } class ImplA implements A { kind: "a"; run() {} } class ImplB implements B { kind: "b"; run() {} } function caller(x: A | B){ switch (x.kind) { case "a": case "b": x.run(); break; } }',
      'x.ts', 'typescript', 'ast').symbols!;
    expect(resolveSymbols([facts]).calls.find(call => call.expression === 'x.run')).toMatchObject({
      resolution: 'unresolved', reason: 'ambiguous-binding',
    });
  });

  it('does not hoist Python definitions or JavaScript classes', () => {
    for (const [language, file, source] of [
      ['python', 'x.py', 'run()\ndef run(): pass'], ['typescript', 'x.ts', 'new Service(); class Service {}'],
    ] as const) {
      const facts = extractFile(source, file, language, 'ast').symbols!;
      expect(resolveSymbols([facts]).calls[0]).toMatchObject({ resolution: 'unresolved', reason: 'uninitialized-binding' });
    }
  });
});
