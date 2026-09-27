import { describe, expect, it } from 'vitest';
import { extractFile } from '../../src/registry/entityScanner.js';
import { reachableNodes } from '../../src/analysis/cfg.js';
import type { AstLanguage } from '../../src/frontend/types.js';

function program(source: string, language: AstLanguage = 'typescript') {
  const file = language === 'typescript' ? 'x.ts' : language === 'python' ? 'x.py' : 'x.rs';
  return extractFile(source, file, language, 'ast').controlFlow!.find(g => g.owner === `${file}::f`)!;
}
describe('AST dataflow facts', () => {
  it.each([
    ['typescript', 'function f(input){let x=input; x=2; return x;}'],
    ['python', 'def f(input):\n x=input\n x=2\n return x'],
    ['rust', 'fn f(input:i32)->i32{let mut x=input; x=2; return x;}'],
  ] as const)('keeps %s parameters initialized and local writes scoped', (language, source) => {
    const graph = program(source, language), facts = graph.dataflow!;
    expect(facts.variables.find(v => v.name === 'input')).toMatchObject({ category: 'parameter', initial: { kind: 'unknown' } });
    const x = facts.variables.find(v => v.name === 'x')!;
    expect(x).toMatchObject({ category: 'local', initial: { kind: 'uninitialized' } });
    expect(Object.values(facts.effects).flatMap(e => e.writes).filter(w => w.target.kind === 'variable' && w.target.key === x.key)).toHaveLength(2);
  });

  it('distinguishes var hoisting, lexical shadowing and captured bindings', () => {
    const graph = program('function f(input){var hoisted; let x=1; {let x=2; use(x);} function inner(){return input;} return x;}');
    const variables = graph.dataflow!.variables;
    expect(variables.find(v => v.name === 'hoisted')?.initial.kind).toBe('undefined');
    expect(new Set(variables.filter(v => v.name === 'x').map(v => v.key)).size).toBe(2);
    expect(variables.find(v => v.name === 'input')?.captured).toBe(true);
  });

  it('does not read a simple assignment LHS but retains compound reads', () => {
    const graph = program('function f(){let x; x=1; x+=2; return x;}');
    const plain = graph.nodes.find(n => n.astType === 'identifier' && n.span.startOffset === 'function f(){let x; '.length)!;
    expect(graph.dataflow!.effects[plain.id].value.kind).toBe('unknown');
    const compound = graph.nodes.find(n => n.text === 'x+=2')!;
    expect(graph.dataflow!.effects[compound.id].writes[0].value).toMatchObject({ kind: 'binary', operator: '+' });
  });

  it('retains the chosen conditional/optional value and binds a default only on its initializer path', () => {
    const graph = program('function f(x=init()){let y=x?yes():no();return x?.field;}');
    const defaultNode = graph.nodes.find(n => n.binding === 'parameter-default')!;
    expect(graph.dataflow!.effects[defaultNode.id].writes[0].target).toMatchObject({ kind: 'variable' });
    expect(graph.nodes.filter(n => n.text.startsWith('conditional ') && n.valueSource)).toHaveLength(2);
    const skipped = graph.nodes.find(n => n.constantValue === 'undefined')!;
    expect(graph.dataflow!.effects[skipped.id].value.kind).toBe('undefined');
    const condition = graph.nodes.find(n => n.text === 'parameter is undefined')!;
    const alreadyDefined = graph.edges.find(e => e.from === condition.id && e.kind === 'false')!;
    expect(reachableNodes(graph, alreadyDefined.to).has(defaultNode.id)).toBe(false);
  });

  it('does not define a Python loop variable on zero iterations or treat it as a parameter', () => {
    const graph = program('def f(xs):\n for x in xs:\n  use(x)\n return x', 'python');
    const variable = graph.dataflow!.variables.find(v => v.name === 'x')!;
    expect(variable).toMatchObject({ category: 'local', initial: { kind: 'uninitialized' } });
    const binding = graph.nodes.find(n => n.binding === 'iteration')!;
    const condition = graph.nodes.find(n => n.text === 'iterator has next')!;
    const exhausted = graph.edges.find(e => e.from === condition.id && e.kind === 'false')!;
    expect(reachableNodes(graph, exhausted.to).has(binding.id)).toBe(false);
    expect(graph.dataflow!.effects[binding.id].writes[0].target).toEqual({ kind: 'variable', key: variable.key });
  });

  it('clears Python exception aliases on return and normal handler exit', () => {
    const graph = program('def f(x):\n try:\n  run()\n except Error as e:\n  if x: return e\n  use(e)\n return e', 'python');
    const variable = graph.dataflow!.variables.find(v => v.name === 'e')!;
    expect(variable.category).toBe('local');
    const clears = graph.nodes.filter(n => n.binding === 'exception-clear');
    expect(clears.length).toBeGreaterThanOrEqual(2);
    expect(clears.every(node => graph.dataflow!.effects[node.id].deletes.includes(variable.key))).toBe(true);
  });

  it('leaves a Python annotation without a value from overwriting an existing binding', () => {
    const graph = program('def f():\n x=1\n x: int\n return x', 'python');
    const annotation = graph.nodes.find(n => n.text === 'x: int')!;
    expect(graph.dataflow!.effects[annotation.id].writes).toEqual([]);
  });
});
