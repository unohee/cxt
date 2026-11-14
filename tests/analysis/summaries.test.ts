import { describe, expect, it } from 'vitest';
import { extractFile } from '../../src/registry/entityScanner.js';
import { resolveSymbols } from '../../src/analysis/resolveSymbols.js';
import { analyzeSummaries, linkSummaryCalls, summaryComponents } from '../../src/analysis/summaries.js';
import type { AstLanguage } from '../../src/frontend/types.js';

function analyze(files: Record<string, string>, language: AstLanguage = 'typescript', componentIterationBudget?: number,
  exceptionParents?: Record<string, string[]>) {
  const extracted = Object.entries(files).map(([path, source]) => extractFile(source, path, language, 'ast'));
  return analyzeSummaries(extracted.flatMap(f => f.controlFlow ?? []), resolveSymbols(extracted.map(f => f.symbols!)).calls, { componentIterationBudget, exceptionParents });
}

describe('interprocedural summaries', () => {
  it('summarizes direct Rust parameter moves and borrows', () => {
    const moved = analyze({ 'move.rs': 'struct Value { value: i32 } fn consume(value: Value) { let owned = value; owned.value; }' }, 'rust');
    expect(moved.summaries.find(summary => summary.owner === 'move.rs::consume')?.movesParameters).toEqual([0]);
    const borrowed = analyze({ 'borrow.rs': 'struct Value { value: i32 } fn inspect(value: Value) { let view = &value; view; }' }, 'rust');
    expect(borrowed.summaries.find(summary => summary.owner === 'borrow.rs::inspect')?.borrowsParameters).toEqual([0]);
    expect(borrowed.summaries.find(summary => summary.owner === 'borrow.rs::inspect')?.movesParameters).toBeUndefined();
  });

  it.each([
    ['typescript', 'x.ts', 'function pick(a,b){return b;}function f(input,ignored){return pick(ignored,input);}'],
    ['python', 'x.py', 'def pick(a,b):\n return b\ndef f(input,ignored):\n return pick(ignored,input)'],
    ['rust', 'x.rs', 'fn pick(a:i32,b:i32)->i32{b}fn f(input:i32,ignored:i32)->i32{pick(ignored,input)}'],
  ] as const)('substitutes %s argument dependencies at each call site', (language, path, source) => {
    const result = analyze({ [path]: source }, language);
    const summary = result.summaries.find(s => s.owner === `${path}::f`)!;
    expect(summary.completeness).toBe('complete');
    expect(summary.returnParameters).toHaveLength(1);
    expect(summary.returnParameters[0]).toMatch(/:input$/);
    expect(summary.effects.unknown).toBe(false);
    expect(result.flows.find(f => f.owner === summary.owner)?.calls[0].resolution).toBe('summary');
  });

  it('propagates through imported wrappers without mixing different calls', () => {
    const result = analyze({
      'lib.ts': 'export function pick(a,b){return b;}',
      'wrap.ts': "import {pick} from './lib';export function wrap(a,b){return pick(a,b);}",
      'main.ts': "import {wrap} from './wrap';function f(left,right){const a=wrap(0,left);const b=wrap(0,right);return a;}",
    });
    const summary = result.summaries.find(s => s.owner === 'main.ts::f')!;
    expect(summary.completeness).toBe('complete');
    expect(summary.returnParameters).toHaveLength(1);
    expect(summary.returnParameters[0]).toMatch(/:left$/);
    const calls = result.flows.find(f => f.owner === summary.owner)!.calls;
    expect(calls.map(c => c.arguments[1].parameters[0])).toEqual([expect.stringMatching(/:left$/), expect.stringMatching(/:right$/)]);
  });

  it('propagates constants without treating an arbitrary parameter-dependent function as identity', () => {
    const result = analyze({ 'x.ts': 'function constant(){return 3;}function f(){return constant();}function increment(x){return x+1;}function g(){return increment(1);}' });
    expect(result.summaries.find(s => s.owner === 'x.ts::f')?.returnAtoms).toEqual(['number:3']);
    const returned = result.summaries.find(s => s.owner === 'x.ts::g')!.returnAtoms;
    expect(returned).not.toEqual(['number:1']);
  });

  it('reaches a recursive component fixed point and retains base-case parameter flow', () => {
    const result = analyze({ 'x.ts': 'function f(flag,input){if(flag)return input;return g(flag,input);}function g(flag,input){return f(flag,input);}' });
    expect(result.components).toContainEqual(['x.ts::f', 'x.ts::g']);
    for (const summary of result.summaries) {
      expect(summary.completeness).toBe('complete');
      expect(summary.iterations).toBeGreaterThan(1);
      expect(summary.returnParameters).toHaveLength(1);
      expect(summary.returnParameters[0]).toMatch(/:input$/);
    }
  });

  it('marks the entire recursive component partial on truncation', () => {
    const result = analyze({ 'x.ts': 'function f(input){if(input)return input;return g(input);}function g(input){return f(input);}' }, 'typescript', 1);
    expect(result.summaries.every(s => s.completeness === 'partial' && s.reasons.includes('component-iteration-budget'))).toBe(true);
  });

  it('widens a growing recursive numeric range to a finite fixed point', () => {
    const result = analyze({ 'x.ts': 'function f(flag){if(flag)return 0;return f(flag)+1;}' });
    expect(result.summaries[0].completeness).toBe('complete');
    expect(result.summaries[0].returnAtoms).toEqual(['*number']);
    expect(result.summaries[0].iterations).toBeLessThanOrEqual(16);
  });

  it('reports no normal return for unconditionally recursive calls', () => {
    const result = analyze({ 'x.ts': 'function f(){return f();}function g(){f();return 1;}' });
    expect(result.summaries.every(s => s.mayReturn === false)).toBe(true);
    expect(result.flows.every(f => f.returns.length === 0)).toBe(true);
  });

  it('propagates thrown input dependence through a catch binding', () => {
    const result = analyze({ 'x.ts': 'function fail(error,unused){throw error;}function f(input){try{fail(input,0);}catch(e){return e;}}' });
    const summary = result.summaries.find(s => s.owner === 'x.ts::f')!;
    expect(summary.returnParameters).toHaveLength(1);
    expect(summary.returnParameters[0]).toMatch(/:input$/);
    expect(result.summaries.find(s => s.owner === 'x.ts::fail')?.throwParameters[0]).toMatch(/:error$/);
  });

  it('uses a collision-free project exception hierarchy across Python files', () => {
    const result = analyze({
      'errors.py': 'class MyError(ValueError):\n pass\n',
      'app.py': 'def f():\n try:\n  raise MyError\n except Exception:\n  return 1\n return 2\n',
    }, 'python', undefined, { MyError: ['ValueError'] });
    const flow = result.flows.find(item => item.owner === 'app.py::f')!;
    expect(flow.completeness).toBe('complete');
    expect(flow.returns.map(item => item.value.atoms)).toContainEqual(['number:1']);
  });

  it('does not claim complete summaries for unknown effects or unsupported argument binding', () => {
    const external = analyze({ 'x.ts': 'function f(input){return external(input);}' }).summaries[0];
    expect(external.completeness).toBe('partial');
    expect(external.reasons).toContain('unknown-external-effect');
    const keyword = analyze({ 'x.py': 'def pick(a,b):\n return b\ndef f(input):\n return pick(b=input,a=0)' }, 'python');
    expect(keyword.summaries.find(s => s.owner === 'x.py::f')?.completeness).toBe('partial');
    const destructuring = analyze({ 'x.ts': 'function f({x}){return x;}' });
    expect(destructuring.summaries[0].reasons).toContain('unsupported-parameter-binding');
  });

  it('links exact spans without mutating the original graphs', () => {
    const extracted = extractFile('function id(x){return x;}function f(x){return id(x);}', 'x.ts', 'typescript', 'ast');
    const before = structuredClone(extracted.controlFlow);
    const calls = resolveSymbols([extracted.symbols!]).calls;
    const linked = linkSummaryCalls(extracted.controlFlow!, calls);
    expect(extracted.controlFlow).toEqual(before);
    expect(summaryComponents(linked)).toEqual([['x.ts::id'], ['x.ts::f']]);
    const wrong = linkSummaryCalls(extracted.controlFlow!, calls.map(c => ({ ...c, endColumn: c.endColumn + 1 })));
    expect(Object.values(wrong[1].dataflow!.effects).some(e => e.value.kind === 'call' && e.value.target)).toBe(false);
  });

  it('preserves possible closure and mutated-heap input dependencies at unknown boundaries', () => {
    const closure = analyze({ 'x.ts': 'function f(input){function inner(){return input;}return inner();}' });
    expect(closure.summaries.find(s => s.owner === 'x.ts::f.inner')?.reasons).toContain('external-value-dependence');
    expect(closure.summaries.find(s => s.owner === 'x.ts::f')?.returnParameters[0]).toMatch(/:input$/);
    expect(closure.summaries.find(s => s.owner === 'x.ts::f')?.completeness).toBe('partial');
    const heap = analyze({ 'x.ts': 'function f(input){let a={x:0};a.x=input;return external(a);}' });
    expect(heap.summaries[0].returnParameters[0]).toMatch(/:input$/);
  });

  it('invalidates static call targets after unknown mutation but retains a previously copied function', () => {
    const result = analyze({ 'x.ts': 'function original(x){return 0;}function f(input){external();return original(input);}function g(input){const saved=original;external();return saved(input);}' });
    const f = result.flows.find(f => f.owner === 'x.ts::f')!;
    expect(f.calls.at(-1)?.resolution).toBe('unknown');
    expect(f.returns[0].value.atoms).toContain('*number');
    const g = result.flows.find(f => f.owner === 'x.ts::g')!;
    expect(g.calls.at(-1)?.resolution).toBe('summary');
    expect(g.returns[0].value.atoms).toEqual(['number:0']);
  });

  it.each([
    ['typescript', 'x.ts', 'async function deferred(){return 3;}function f(){return deferred();}'],
    ['python', 'x.py', 'async def deferred():\n return 3\ndef f():\n return deferred()'],
    ['rust', 'x.rs', 'async fn deferred()->i32{3}fn f(){deferred();}'],
  ] as const)('does not substitute the %s async body result for its suspended-call object', (language, file, source) => {
    const result = analyze({ [file]: source }, language);
    expect(result.summaries.find(s => s.owner === `${file}::deferred`)?.reasons).toContain('resumable-call-contract');
    expect(result.flows.find(f => f.owner === `${file}::f`)?.calls[0].resolution).toBe('unknown');
  });

  it('does not treat a generator with no yield as a synchronous function', () => {
    const result = analyze({ 'x.ts': 'function* deferred(){return 3;}function f(){return deferred();}' });
    expect(result.summaries.find(s => s.owner === 'x.ts::deferred')?.reasons).toContain('resumable-call-contract');
  });
});
