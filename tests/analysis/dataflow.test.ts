import { describe, expect, it } from 'vitest';
import { extractFile } from '../../src/registry/entityScanner.js';
import { analyzeDataflow } from '../../src/analysis/dataflow.js';
import type { AstLanguage } from '../../src/frontend/types.js';

function analyze(source: string, language: AstLanguage = 'typescript', iterationBudget?: number) {
  const file = language === 'typescript' ? 'x.ts' : language === 'python' ? 'x.py' : 'x.rs';
  const graph = extractFile(source, file, language, 'ast').controlFlow!.find(g => g.owner === `${file}::f`)!;
  return { graph, result: analyzeDataflow(graph, { iterationBudget }) };
}
const returnedAtoms = (result: ReturnType<typeof analyze>['result']) => [...new Set(result.returns.flatMap(r => r.value.atoms))].sort();

describe('intraprocedural fixed point', () => {
  it.each([
    ['typescript', 'function f(input){let x=input;let saved=x;x=2;return saved;}'],
    ['python', 'def f(input):\n x=input\n saved=x\n x=2\n return saved'],
    ['rust', 'fn f(input:i32)->i32{let mut x=input;let saved=x;x=2;return saved;}'],
  ] as const)('preserves %s source dependencies before strong kill', (language, source) => {
    const { result } = analyze(source, language);
    expect(result.completeness).toBe('complete');
    expect(result.returns[0].value.parameters).toHaveLength(1);
    expect(result.returns[0].value.parameters[0]).toMatch(/:input$/);
    expect(result.returns[0].value.definitions).toHaveLength(1);
    expect(result.returns[0].value.definitions[0]).toMatch(/:saved$/);
  });

  it('removes overwritten definitions instead of unioning every assignment', () => {
    const { result } = analyze('function f(){let x=1;x=2;return x;}');
    expect(returnedAtoms(result)).toEqual(['number:2']);
    expect(result.returns[0].value.definitions).toHaveLength(1);
  });

  it('joins branch definitions and narrows null alternatives together with their provenance', () => {
    const { graph, result } = analyze('function f(flag){let x=null;if(flag)x={v:1};if(x===null)return 0;return x.v;}');
    expect(returnedAtoms(result)).toEqual(['number:0', 'number:1']);
    const reads = result.uses.filter(use => use.variable.endsWith(':x'));
    expect(reads[0].definitions).toHaveLength(2);
    expect(reads.at(-1)?.definitions).toHaveLength(1);
    expect(reads.at(-1)?.value.atoms.every(atom => atom.startsWith('object:'))).toBe(true);
    expect(result.reachableNodes.every(id => graph.nodes[id])).toBe(true);
  });

  it.each([
    ['python', 'def f(flag):\n if flag:\n  x=1\n return x'],
    ['rust', 'fn f(flag:bool)->i32{let x;if flag{x=1;}return x;}'],
  ] as const)('retains %s potentially uninitialized definitions at a merge', (language, source) => {
    const { result } = analyze(source, language);
    expect(result.uses.filter(use => use.variable.endsWith(':x')).some(use => use.mayBeUninitialized)).toBe(true);
    expect(returnedAtoms(result)).toContain('uninitialized');
  });

  it('tracks an alias field strong update on the same allocated object', () => {
    const { result } = analyze('function f(){let a={x:1};let b=a;b.x=2;return a.x;}');
    expect(result.completeness).toBe('complete');
    expect(returnedAtoms(result)).toEqual(['number:2']);
    expect(result.returns[0].value.definitions[0]).toContain('heap:');
  });

  it('terminates loops with stable definition IDs and filters impossible numeric exit values', () => {
    const { result } = analyze('function f(){let x=0;while(x<3){x++;}return x;}');
    expect(result.completeness).toBe('complete');
    expect(result.iterations).toBeLessThan(1024);
    expect(returnedAtoms(result)).toEqual(['number:3']);
    expect(result.returns[0].value.definitions).toHaveLength(1);
  });

  it('reports budget exhaustion and unsupported CFGs as partial', () => {
    const capped = analyze('function f(){let x=0;while(x<3){x++;}return x;}', 'typescript', 1).result;
    expect(capped.completeness).toBe('partial');
    expect(capped.diagnostics.some(d => d.code === 'iteration-budget')).toBe(true);
    expect(analyze('function* f(){yield 1;}').result.completeness).toBe('partial');
    const graph = analyze('function f(x){return x;}').graph;
    expect(analyzeDataflow(graph, { stateBudget: 1 }).diagnostics.some(d => d.code === 'state-budget')).toBe(true);
    expect(analyzeDataflow(graph, { workBudget: 1 }).diagnostics.some(d => d.code === 'work-budget')).toBe(true);
  });

  it('lets finally override or suppress a previous return', () => {
    expect(returnedAtoms(analyze('function f(){try{return 1;}finally{return 2;}}').result)).toEqual(['number:2']);
    expect(analyze('function f(){try{return 1;}finally{throw 2;}}').result.returns).toEqual([]);
    expect(returnedAtoms(analyze('function f(){while(true){try{return 1;}finally{break;}}return 2;}').result)).toEqual(['number:2']);
  });

  it('does not apply a conditional RHS or parameter default on the skipped path', () => {
    expect(returnedAtoms(analyze('function f(){let x=false;let y=x?1:2;return y;}').result)).toEqual(['number:2']);
    expect(returnedAtoms(analyze('function f(){let x=null;return x?.value;}').result)).toEqual(['undefined']);
    const withDefault = analyze('function f(x=1){return x;}').result;
    expect(returnedAtoms(withDefault)).not.toContain('undefined');
    expect(withDefault.returns.flatMap(r => r.value.alternatives).some(choice => choice.atoms.includes('number:1'))).toBe(true);
  });

  it('clears a Python exception alias on exit while preserving the evaluated return value', () => {
    const { result } = analyze('def f():\n try:\n  raise error\n except Error as e:\n  saved=e\n return e', 'python');
    expect(result.uses.filter(use => use.variable.endsWith(':e')).at(-1)?.mayBeUninitialized).toBe(true);
  });

  it('retains an unescaped local across unknown calls and havocs captured variables and heap', () => {
    expect(returnedAtoms(analyze('function f(){let x=1;external();return x;}').result)).toEqual(['number:1']);
    const captured = analyze('function f(){let x=1;function inner(){x=2;}external(inner);return x;}').result;
    expect(returnedAtoms(captured)).toContain('*number');
    const heap = analyze('function f(){let a={x:1};external(a);return a.x;}').result;
    expect(returnedAtoms(heap)).toContain('*number');
  });

  it('resumes await through cleanup and keeps suspension out of normal returns', () => {
    const { graph, result } = analyze('async function f(){let x=1;try{await external();x=2;}finally{x=3;}return x;}');
    expect(result.completeness).toBe('complete');
    expect(returnedAtoms(result)).toEqual(['number:3']);
    expect(result.returns.every(r => r.node !== graph.suspensionExit)).toBe(true);
  });

  it('includes expression-body and Rust tail returns', () => {
    const tsGraph = extractFile('const f = (x) => x;', 'x.ts', 'typescript', 'ast').controlFlow![0];
    expect(analyzeDataflow(tsGraph).returns[0].value.parameters[0]).toMatch(/:x$/);
    expect(returnedAtoms(analyze('fn f()->i32{3}', 'rust').result)).toEqual(['number:3']);
    expect(returnedAtoms(analyze('def f():\n return', 'python').result)).toEqual(['null']);
  });

  it('does not read destructuring targets before their assignment', () => {
    const { result } = analyze('def f():\n a,b=(1,2)\n return a', 'python');
    expect(result.uses.some(use => use.mayBeUninitialized)).toBe(false);
    expect(returnedAtoms(result)).toEqual(['number:1']);
  });

  it('carries iterable dependencies into loop bindings', () => {
    const { result } = analyze('def f(xs):\n for item in xs:\n  return item', 'python');
    expect(result.returns.some(r => r.value.parameters.some(p => p.endsWith(':xs')))).toBe(true);
  });

  it('carries thrown value dependencies into exception bindings', () => {
    const { result } = analyze('def f(error):\n try:\n  raise error\n except Error as e:\n  return e', 'python');
    expect(result.returns.some(r => r.value.parameters.some(p => p.endsWith(':error')))).toBe(true);
  });

  it('invalidates deleted fields and clears Python local bindings', () => {
    const ts = analyze('function f(){let a={x:1};delete a.x;return a.x;}').result;
    expect(returnedAtoms(ts)).toContain('undefined');
    const py = analyze('def f():\n x=1\n del x\n return x', 'python').result;
    expect(returnedAtoms(py)).toEqual(['uninitialized']);
    expect(py.uses.at(-1)?.mayBeUninitialized).toBe(true);
  });

  it('keeps a for-of lexical binding distinct from the outer same-name variable', () => {
    const { graph, result } = analyze('function f(xs){let item=2;for(const item of xs){item;}return item;}');
    expect(returnedAtoms(result)).toEqual(['number:2']);
    expect(graph.dataflow?.variables.filter(v => v.name === 'item')).toHaveLength(2);
    expect(graph.dataflow?.variables.filter(v => v.name === 'item').every(v => v.category === 'local')).toBe(true);
  });

  it('does not retain local constants across direct eval or heap constants across dynamic operators', () => {
    const dynamic = analyze('function f(code){let x=1;eval(code);return x;}').result;
    expect(returnedAtoms(dynamic)).toContain('*number');
    const protocol = analyze('function f(input){let a={x:1};input+1;return a.x;}').result;
    expect(returnedAtoms(protocol)).toContain('*number');
    expect(protocol.unknownEffects.length).toBeGreaterThan(0);
  });

  it('preserves interpolation dependencies and does not shift sparse or spread array fields', () => {
    expect(analyze('function f(input){return `hello ${input}`;}').result.returns[0].value.parameters[0]).toMatch(/:input$/);
    expect(analyze('def f(input):\n return f"hello {input}"', 'python').result.returns[0].value.parameters[0]).toMatch(/:input$/);
    expect(returnedAtoms(analyze('function f(){let a=[,,3];return a[2];}').result)).toEqual(['number:3']);
    const spread = analyze('function f(input){let a={x:1,...input};return a.x;}').result;
    expect(spread.completeness).toBe('partial');
    expect(returnedAtoms(spread)).toContain('*number');
  });
});
