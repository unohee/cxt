import { describe, expect, it } from 'vitest';
import { extractFile } from '../../src/registry/entityScanner.js';
import { resolveSymbols } from '../../src/analysis/resolveSymbols.js';
import { loadCallCorpus } from '../../bench/call-accuracy.js';
const fixtures = loadCallCorpus();

describe('symbol resolution: handwritten multi-file call-site oracle', () => {
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

  it('does not hoist Python definitions or JavaScript classes', () => {
    for (const [language, file, source] of [
      ['python', 'x.py', 'run()\ndef run(): pass'], ['typescript', 'x.ts', 'new Service(); class Service {}'],
    ] as const) {
      const facts = extractFile(source, file, language, 'ast').symbols!;
      expect(resolveSymbols([facts]).calls[0]).toMatchObject({ resolution: 'unresolved', reason: 'uninitialized-binding' });
    }
  });
});
