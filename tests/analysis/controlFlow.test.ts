import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import ts from 'tree-sitter-typescript';
import { extractFile } from '../../src/registry/entityScanner.js';
import { reachableNodes, type ControlFlowGraph } from '../../src/analysis/cfg.js';
import { buildControlFlow } from '../../src/frontend/controlFlow.js';
import type { AstLanguage } from '../../src/frontend/types.js';

function graph(source: string, language: AstLanguage = 'typescript'): ControlFlowGraph {
  const path = language === 'typescript' ? 'x.ts' : language === 'python' ? 'x.py' : 'x.rs';
  const cfg = extractFile(source, path, language, 'ast').controlFlow!.find(g => g.owner === `${path}::f`)!;
  expect(cfg, source).toBeDefined();
  return cfg;
}
function nodes(cfg: ControlFlowGraph, text: string) { return cfg.nodes.filter(n => n.text === text); }
function reaches(cfg: ControlFlowGraph, from: string, to: string): boolean {
  return nodes(cfg, from).some(start => nodes(cfg, to).some(end => reachableNodes(cfg, start.id).has(end.id)));
}
function normalGraph(cfg: ControlFlowGraph): ControlFlowGraph {
  return { ...cfg, edges: cfg.edges.filter(e => e.kind !== 'exception') };
}

describe('AST control flow', () => {
  it.each([
    ['typescript', 'function f(x){ if(x) return 1; else return 2; dead(); }', 'dead()'],
    ['python', 'def f(x):\n if x: return 1\n else: return 2\n dead()', 'dead()'],
    ['rust', 'fn f(x: bool) { if x { return; } else { return; } dead(); }', 'dead()'],
  ] as const)('preserves early return and unreachable nodes in %s', (language, source, dead) => {
    const cfg = graph(source, language);
    expect(cfg.completeness).toBe('complete');
    expect(cfg.structuralComplexity).toBe(2);
    expect(reachableNodes(cfg).has(cfg.exit)).toBe(true);
    expect(nodes(cfg, dead).every(n => !reachableNodes(cfg).has(n.id))).toBe(true);
  });

  it('keeps pending return, exception and normal finally paths separate', () => {
    const cfg = graph('function f(x){try {if(x) return 1; work();} finally {cleanup();} after();}');
    expect(nodes(cfg, 'cleanup()')).toHaveLength(3);
    expect(reaches(cfg, 'return 1;', 'cleanup()')).toBe(true);
    expect(reaches(cfg, 'return 1;', 'after()')).toBe(false);
    expect(reaches(cfg, 'work()', 'after()')).toBe(true);
    const cleanupForReturn = nodes(cfg, 'cleanup for return')[0];
    expect(reachableNodes(cfg, cleanupForReturn.id).has(cfg.exceptionExit)).toBe(true);
    expect(reachableNodes(cfg, cleanupForReturn.id).has(cfg.exit)).toBe(true);
  });

  it.each([
    ['typescript', 'function f(){try {throw problem;} finally {return 2;} dead();}', 'throw problem;', 'return 2;'],
    ['python', 'def f():\n try:\n  raise problem\n finally:\n  return 2\n dead()', 'raise problem', 'return 2'],
  ] as const)('lets a finally return override a pending exception in %s', (language, source, thrown, returned) => {
    const cfg = graph(source, language);
    expect(reaches(cfg, thrown, returned)).toBe(true);
    expect(reachableNodes(cfg).has(cfg.exceptionExit)).toBe(false);
    expect(reachableNodes(cfg).has(cfg.exit)).toBe(true);
    expect(nodes(cfg, 'dead()').every(n => !reachableNodes(cfg).has(n.id))).toBe(true);
  });

  it('routes break and continue through finally to different loop destinations', () => {
    const cfg = normalGraph(graph('function f(x){for(let i=0;i<x;i++){try {if(x) break; continue;} finally {cleanup();}} after();}'));
    expect(reaches(cfg, 'break;', 'cleanup()')).toBe(true);
    expect(reaches(cfg, 'break;', 'after()')).toBe(true);
    expect(reaches(cfg, 'break;', 'i++')).toBe(false);
    expect(reaches(cfg, 'continue;', 'i++')).toBe(true);
    expect(cfg.diagnostics).toEqual([]);
  });

  it('executes do body before every part of its condition and follows continue to the condition', () => {
    const cfg = normalGraph(graph('function f(){do {body(); continue; dead();} while(check()); after();}'));
    expect(reaches(cfg, 'continue;', 'check()')).toBe(true);
    expect(reaches(cfg, 'check()', 'body()')).toBe(true);
    expect(reachableNodes(cfg).has(nodes(cfg, 'dead()')[0].id)).toBe(false);
    const initialPath = cfg.edges.find(e => e.from === cfg.entry)!;
    expect(cfg.nodes[initialPath.to].text).toBe('loop header');
  });

  it('keeps Python loop else off the break path and on exhaustion', () => {
    const cfg = normalGraph(graph('def f(xs):\n for x in xs:\n  break\n else:\n  exhausted()\n after()', 'python'));
    expect(reaches(cfg, 'break', 'exhausted()')).toBe(false);
    expect(reaches(cfg, 'break', 'after()')).toBe(true);
    expect(reaches(cfg, 'iterator has next', 'exhausted()')).toBe(true);
    expect(cfg.completeness).toBe('complete');
  });

  it('keeps Python try else off a caught exception path', () => {
    const cfg = normalGraph(graph('def f():\n try:\n  raise error\n except Error:\n  caught()\n else:\n  success()\n finally:\n  cleanup()\n after()', 'python'));
    expect(reaches(cfg, 'raise error', 'caught()')).toBe(true);
    expect(reaches(cfg, 'caught()', 'success()')).toBe(false);
    expect(reaches(cfg, 'caught()', 'after()')).toBe(true);
    expect(reachableNodes(cfg).has(nodes(cfg, 'success()')[0].id)).toBe(false);
  });

  it('preserves switch fallthrough and labeled continue without swallowing it as switch break', () => {
    const cfg = normalGraph(graph('function f(x){outer: for(;;){switch(x){case 1: one(); case 2: two(); break; default: continue outer;} after();}}'));
    expect(reaches(cfg, 'one()', 'two()')).toBe(true);
    expect(reaches(cfg, 'two()', 'after()')).toBe(true);
    expect(cfg.diagnostics).toEqual([]);
    expect(cfg.structuralComplexity).toBe(3);
  });

  it('branches short circuit and conditional expressions without executing both alternatives', () => {
    const cfg = normalGraph(graph('function f(a){const x=a ? yes() : no(); return a && right();}'));
    expect(reaches(cfg, 'yes()', 'no()')).toBe(false);
    expect(reaches(cfg, 'no()', 'yes()')).toBe(false);
    expect(reaches(cfg, 'yes()', 'right()')).toBe(true);
    expect(cfg.structuralComplexity).toBe(3);
  });

  it('branches Rust residual propagation to return without reaching later statements', () => {
    const cfg = normalGraph(graph('fn f(){ let x=run()?; after(); }', 'rust'));
    const test = nodes(cfg, 'Try::branch')[0];
    const failed = cfg.edges.find(e => e.from === test.id && e.kind === 'false')!;
    expect(failed.to).toBe(cfg.exit);
    expect(cfg.structuralComplexity).toBe(2);
    expect(cfg.completeness).toBe('complete');
  });

  it('short circuits an entire optional chain, including computed keys and call arguments', () => {
    for (const source of ['function f(x){x?.run(arg());after();}', 'function f(x){x?.[key()].run(arg());after();}',
      'function f(x){x.run?.(arg());after();}']) {
      const cfg = normalGraph(graph(source));
      expect(cfg.completeness).toBe('complete');
      const test = nodes(cfg, 'receiver is nullish')[0];
      expect(test, source).toBeDefined();
      const shortcut = cfg.edges.find(e => e.from === test.id && e.kind === 'true')!;
      const reachable = reachableNodes(cfg, shortcut.to);
      expect(nodes(cfg, 'arg()').some(n => reachable.has(n.id))).toBe(false);
      expect(nodes(cfg, 'key()').some(n => reachable.has(n.id))).toBe(false);
      expect(nodes(cfg, 'after()').some(n => reachable.has(n.id))).toBe(true);
    }
  });

  it('ends optional chaining at parentheses and short circuits logical assignments', () => {
    const parens = normalGraph(graph('function f(x){(x?.run)(arg());}'));
    const test = nodes(parens, 'receiver is nullish')[0];
    const shortcut = parens.edges.find(e => e.from === test.id && e.kind === 'true')!;
    expect(nodes(parens, 'arg()').some(n => reachableNodes(parens, shortcut.to).has(n.id))).toBe(true);
    for (const operator of ['&&=', '||=', '??=']) {
      const cfg = normalGraph(graph(`function f(x){x ${operator} work(); after();}`));
      expect(cfg.completeness).toBe('complete');
      expect(cfg.structuralComplexity).toBe(2);
      const condition = cfg.nodes.find(n => n.kind === 'condition')!;
      const skipped = cfg.edges.find(e => e.from === condition.id && e.kind === (operator === '||=' ? 'true' : 'false'))!;
      expect(nodes(cfg, 'work()').some(n => reachableNodes(cfg, skipped.to).has(n.id))).toBe(false);
    }
  });

  it('handles Rust match guards, wildcard arms and labeled loops', () => {
    const cfg = normalGraph(graph("fn f(x: i32){ 'outer: loop { match x { 1 if guard() => break 'outer, _ => continue 'outer } } after(); }", 'rust'));
    expect(cfg.diagnostics).toEqual([]);
    expect(reaches(cfg, "break 'outer", 'after()')).toBe(true);
    expect(reaches(cfg, "continue 'outer", 'guard()')).toBe(true);
    expect(cfg.structuralComplexity).toBe(3);
  });

  it('runs Python context exits in reverse order and permits exception suppression', () => {
    const cfg = graph('def f():\n with first() as a, second() as b:\n  raise error\n after()', 'python');
    expect(reaches(cfg, 'raise error', '__exit__')).toBe(true);
    expect(nodes(cfg, '__enter__').map(node => node.binding)).toEqual(['resource-enter', 'resource-enter']);
    expect(reaches(cfg, 'raise error', 'after()')).toBe(true);
    const exits = nodes(cfg, '__exit__');
    const inner = exits.filter(n => n.span.column === Math.max(...exits.map(n => n.span.column)));
    const outer = exits.filter(n => n.span.column === Math.min(...exits.map(n => n.span.column)));
    expect(inner[0].span.column).toBeGreaterThan(outer[0].span.column);
    expect(inner.some(start => outer.some(end => reachableNodes(cfg, start.id).has(end.id)))).toBe(true);
    expect(outer.some(start => inner.some(end => reachableNodes(cfg, start.id).has(end.id)))).toBe(false);
    expect(cfg.completeness).toBe('complete');
  });

  it('isolates nested function bodies and models generator suspension while reporting macros', () => {
    const outer = graph('function f(){function inner(){return 1;} after();}');
    expect(nodes(outer, 'return 1;')).toEqual([]);
    expect(reachableNodes(outer).has(nodes(outer, 'after()')[0].id)).toBe(true);
    const generator = graph('function* f(){yield 1;after();}');
    expect(generator.completeness).toBe('complete');
    const yielded = generator.nodes.find(node => node.kind === 'suspend')!;
    expect(generator.edges).toContainEqual({ from: yielded.id, to: generator.suspensionExit, kind: 'suspend' });
    expect(generator.edges).toContainEqual(expect.objectContaining({ from: yielded.id, kind: 'resume' }));
    expect(reachableNodes(generator, yielded.id).has(nodes(generator, 'after()')[0].id)).toBe(true);
    expect(graph('fn f(){panic!("bad");}', 'rust').diagnostics[0].message).toContain('macro');
  });

  it('marks a node budget stop as partial instead of declaring a complete graph', () => {
    const parser = new Parser(); parser.setLanguage(ts.typescript);
    const callable = parser.parse('function f(){one();two();three();}').rootNode.namedChild(0)!;
    const cfg = buildControlFlow(callable, 'x.ts', 'x.ts::f', 'typescript', 5);
    expect(cfg.completeness).toBe('partial');
    expect(cfg.diagnostics[0].code).toBe('budget-exceeded');
    expect(cfg.nodes).toHaveLength(5);
  });

  it.each([
    ['typescript', 'async function f(){try{await work();}finally{cleanup();}after();}'],
    ['python', 'async def f():\n try:\n  await work()\n finally:\n  cleanup()\n after()'],
  ] as const)('models %s await suspension, resumed success and failure through cleanup', (language, source) => {
    const cfg = graph(source, language);
    expect(cfg.completeness).toBe('complete');
    const awaited = cfg.nodes.find(n => n.kind === 'suspend')!;
    expect(awaited).toBeDefined();
    const suspended = cfg.edges.find(e => e.from === awaited.id && e.kind === 'suspend')!;
    const resumed = cfg.edges.find(e => e.from === awaited.id && e.kind === 'resume')!;
    const rejected = cfg.edges.find(e => e.from === awaited.id && e.kind === 'exception')!;
    expect(suspended.to).toBe(cfg.suspensionExit);
    expect(cfg.edges.filter(e => e.from === suspended.to)).toEqual([]);
    expect(nodes(cfg, 'cleanup()').some(n => reachableNodes(cfg, resumed.to).has(n.id))).toBe(true);
    expect(nodes(cfg, 'cleanup()').some(n => reachableNodes(cfg, rejected.to).has(n.id))).toBe(true);
    expect(nodes(cfg, 'after()').some(n => reachableNodes(cfg, rejected.to).has(n.id))).toBe(false);
    expect(reachableNodes(cfg, rejected.to).has(cfg.exceptionExit)).toBe(true);
  });

  it('models Rust await inside the current function and leaves deferred async-block semantics partial', () => {
    const cfg = graph('async fn f(){work().await;after();}', 'rust');
    expect(cfg.completeness).toBe('complete');
    expect(cfg.nodes.some(n => n.kind === 'suspend')).toBe(true);
    expect(graph('fn f(){let future=async {work().await;};}', 'rust').completeness).toBe('partial');
  });

  it('splits Python exception groups across except* arms and carries the remainder', () => {
    const cfg = graph(`def f():
  try:
    raise ExceptionGroup('errors', [ValueError(), TypeError()])
  except* ValueError as error:
    handle_value(error)
  except* TypeError:
    handle_type()
  return 1
`, 'python');
    expect(cfg.completeness).toBe('complete');
    expect(cfg.diagnostics).toEqual([]);
    expect(cfg.nodes.filter(node => node.text.includes('exception group matches')).length).toBe(2);
    expect(cfg.edges.some(edge => edge.kind === 'false')).toBe(true);
    expect(cfg.nodes.some(node => node.binding === 'exception')).toBe(true);
  });

  it('models Python generator yield suspension and resumed cleanup', () => {
    const cfg = graph('def f():\n yield value\n after()', 'python');
    expect(cfg.completeness).toBe('complete');
    const yielded = cfg.nodes.find(node => node.kind === 'suspend')!;
    expect(yielded).toBeDefined();
    expect(cfg.executionKind).toBe('generator');
    expect(reachableNodes(cfg, yielded.id).has(nodes(cfg, 'after()')[0].id)).toBe(true);
  });

  it('models Python yield-from delegation as a repeated suspension until exhaustion', () => {
    const cfg = graph('def f():\n yield from values\n after()', 'python');
    expect(cfg.completeness).toBe('complete');
    expect(nodes(cfg, 'yield from exhausted')).toHaveLength(1);
    expect(nodes(cfg, 'yield from resume')).toHaveLength(1);
    const exhausted = nodes(cfg, 'yield from exhausted')[0];
    const next = nodes(cfg, 'yield from resume')[0];
    expect(cfg.edges).toContainEqual({ from: next.id, to: exhausted.id, kind: 'resume' });
    expect(cfg.edges).toContainEqual({ from: next.id, to: cfg.suspensionExit, kind: 'suspend' });
    expect(reachableNodes(cfg, exhausted.id).has(nodes(cfg, 'after()')[0].id)).toBe(true);
  });

  it('lowers a single-clause Python comprehension filter as a loop back-edge', () => {
    const cfg = graph('def f(xs):\n return [x for x in xs if x]', 'python');
    expect(cfg.completeness).toBe('complete');
    expect(cfg.nodes.some(node => node.text === 'comprehension filter')).toBe(true);
    const filter = cfg.nodes.find(node => node.text === 'comprehension filter')!;
    expect(cfg.edges).toContainEqual(expect.objectContaining({ from: filter.id, kind: 'back' }));
  });

  it('keeps filters between nested Python comprehension clauses on the current loop', () => {
    const cfg = graph('def f(xs, ys):\n return [x+y for x in xs if x for y in ys if y]\n', 'python');
    expect(cfg.completeness).toBe('complete');
    expect(cfg.nodes.filter(node => node.text === 'comprehension filter')).toHaveLength(2);
    expect(cfg.edges.filter(edge => edge.kind === 'back')).toHaveLength(4);
  });

  it('models async Python comprehension iteration as suspension and resume', () => {
    const cfg = graph('async def f(xs):\n return [x async for x in xs]\n', 'python');
    expect(cfg.executionKind).toBe('async');
    expect(cfg.nodes.some(node => node.kind === 'suspend' && node.text === 'async comprehension iterator next')).toBe(true);
    expect(cfg.nodes.some(node => node.kind === 'condition' && node.text === 'iterator has next')).toBe(true);
    expect(cfg.completeness).toBe('complete');
  });

  it('keeps Python generator expression body effects deferred', () => {
    const cfg = graph('def f(xs):\n return (danger(x) for x in xs)\n', 'python');
    expect(cfg.completeness).toBe('partial');
    expect(cfg.nodes.some(node => node.text === 'lazy generator expression')).toBe(true);
    expect(cfg.nodes.some(node => node.text === 'danger(x)')).toBe(false);
  });

  it.each([
    ['typescript', 'async function f(){for await (const item of items){work(item);}after();}'],
    ['python', 'async def f():\n async for item in items:\n  work(item)\n after()'],
  ] as const)('models %s async iteration suspension and exhaustion', (language, source) => {
    const cfg = graph(source, language);
    expect(cfg.completeness).toBe('complete');
    const suspended = cfg.nodes.find(node => node.kind === 'suspend')!;
    expect(suspended.text).toBe('async iterator next');
    expect(cfg.edges).toContainEqual({ from: suspended.id, to: cfg.suspensionExit, kind: 'suspend' });
    expect(cfg.edges).toContainEqual(expect.objectContaining({ from: suspended.id, kind: 'resume' }));
    expect(reachableNodes(cfg).has(nodes(cfg, 'after()')[0].id)).toBe(true);
  });

  it('models Python async context enter and exit suspension', () => {
    const cfg = graph('async def f():\n async with manager:\n  work()\n after()', 'python');
    expect(cfg.completeness).toBe('complete');
    expect(nodes(cfg, 'async context enter')).toHaveLength(1);
    expect(nodes(cfg, 'async context exit')).toHaveLength(2);
    expect(cfg.nodes.some(node => node.text === '__aenter__')).toBe(true);
    expect(cfg.nodes.filter(node => node.text === '__aexit__')).toHaveLength(2);
    expect(cfg.nodes.filter(node => node.kind === 'suspend')).toHaveLength(3);
    expect(cfg.edges.filter(edge => edge.kind === 'suspend')).toHaveLength(3);
    expect(reachableNodes(cfg).has(nodes(cfg, 'after()')[0].id)).toBe(true);
  });
});
