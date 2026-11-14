import { describe, expect, it } from 'vitest';
import { extractFile } from '../../src/registry/entityScanner.js';
import { analyzeDataflow, mergeValue, type AbstractValue } from '../../src/analysis/dataflow.js';
import { applyRustCopyTypes } from '../../src/frontend/dataflowFacts.js';
import type { AstLanguage } from '../../src/frontend/types.js';

function analyze(source: string, language: AstLanguage = 'typescript', iterationBudget?: number) {
  const file = language === 'typescript' ? 'x.ts' : language === 'python' ? 'x.py' : 'x.rs';
  const graph = extractFile(source, file, language, 'ast').controlFlow!.find(g => g.owner === `${file}::f`)!;
  return { graph, result: analyzeDataflow(graph, { iterationBudget }) };
}
const returnedAtoms = (result: ReturnType<typeof analyze>['result']) => [...new Set(result.returns.flatMap(r => r.value.atoms))].sort();

describe('intraprocedural fixed point', () => {
  it('applies project-level Rust Copy declarations to a struct allocation from another file', () => {
    const source = 'struct Value { value: i32 } fn f() { let x = Value { value: 1 }; let y = x; x.value; }';
    const file = extractFile(source, 'consumer.rs', 'rust', 'ast');
    const graph = file.controlFlow!.find(g => g.owner === 'consumer.rs::f')!;
    applyRustCopyTypes([graph], new Set(['Value']));
    expect(analyzeDataflow(graph).ownershipFindings.filter(finding => finding.kind === 'use-after-move')).toHaveLength(0);
  });

  it('does not move a Rust parameter whose Copy proof comes from another file', () => {
    const file = extractFile('struct Value { value: i32 } fn f(value: Value) { let owned = value; value; }', 'consumer.rs', 'rust', 'ast');
    const graph = file.controlFlow!.find(g => g.owner === 'consumer.rs::f')!;
    applyRustCopyTypes([graph], new Set(['Value']));
    const flow = analyzeDataflow(graph);
    expect(flow.movedParameters).toEqual([]);
    expect(flow.ownershipFindings).toHaveLength(0);
  });

  it('does not move Rust reference parameters, including mutable references', () => {
    for (const type of ['&Value', '&mut Value', '*const Value', '*mut Value']) {
      const file = extractFile(`struct Value { value: i32 } fn f(value: ${type}) { let alias = value; value; }`, 'references.rs', 'rust', 'ast');
      const graph = file.controlFlow!.find(g => g.owner === 'references.rs::f')!;
      const flow = analyzeDataflow(graph);
      expect(flow.movedParameters, type).toEqual([]);
      expect(flow.ownershipFindings, type).toHaveLength(0);
    }
  });

  it('widens joined values while keeping distinct Unicode definitions and their parameter provenance', () => {
    const make = (definition: string, atoms: string[], parameter: string): AbstractValue => ({
      atoms, definitions: [definition], parameters: [parameter], alternatives: [{ definition, atoms, parameters: [parameter] }],
    });
    const first = make('é', ['number:1', 'number:2', 'number:3', 'number:4', 'number:5'], 'a');
    const second = make('e\u0301', ['number:6', 'number:7', 'number:8', 'number:9'], 'b');
    const joined = mergeValue(first, second);
    expect(joined.atoms).toEqual(['*number']);
    expect(joined.alternatives).toHaveLength(2);
    expect(joined.alternatives.find(choice => choice.definition === 'é')?.parameters).toEqual(['a']);
    expect(joined.alternatives.find(choice => choice.definition === 'e\u0301')?.parameters).toEqual(['b']);
    expect(mergeValue(joined, make('é', ['number:6', 'number:7', 'number:8', 'number:9'], 'c')).alternatives
      .find(choice => choice.definition === 'é')).toEqual({ definition: 'é', atoms: ['*number'], parameters: ['a', 'c'] });
    expect(first.atoms).toHaveLength(5);
  });

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

  it.each([
    ['typescript', 'function f(obj){obj.x=2;return obj.x;}'],
    ['python', 'def f(obj):\n obj.x=2\n return obj.x'],
  ] as const)('tracks concrete %s member mutation through a parameter receiver by definition', (language, source) => {
    const { result } = analyze(source, language);
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
    expect(analyze('function* f(){yield 1;}').result.completeness).toBe('complete');
    const graph = analyze('function f(x){return x;}').graph;
    expect(analyzeDataflow(graph, { stateBudget: 1 }).diagnostics.some(d => d.code === 'state-budget')).toBe(true);
    expect(analyzeDataflow(graph, { workBudget: 1 }).diagnostics.some(d => d.code === 'work-budget')).toBe(true);
  });

  it('keeps Python yield-from delegation complete while reaching the post-delegation continuation', () => {
    const { graph, result } = analyze('def f():\n yield from values\n after()', 'python');
    expect(result.completeness).toBe('complete');
    const continuation = graph.nodes.find(node => node.text === 'after()');
    expect(continuation).toBeDefined();
    expect(result.reachableNodes).toContain(continuation!.id);
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

  it('retains typed exception provenance through Python except* matching', () => {
    const { result } = analyze(`def f():
 try:
  raise ValueError()
 except* ValueError as error:
  return error
 return None
`, 'python');
    expect(result.completeness).toBe('complete');
    expect(result.diagnostics).toEqual([]);
    expect(result.returns.some(item => item.value.atoms.some(atom => atom === 'exception:ValueError'))).toBe(true);
  });

  it('preserves statically known ExceptionGroup member types for except*', () => {
    const { result } = analyze(`def f():
 try:
  raise ExceptionGroup('errors', [ValueError(), TypeError()])
 except* ValueError as error:
  return error
 return None
`, 'python');
    expect(result.returns.some(item => item.value.atoms.includes('exception-group:ValueError|TypeError'))).toBe(true);
  });

  it('flattens statically known nested ExceptionGroup members for except*', () => {
    const { result } = analyze(`def f():
 try:
  raise ExceptionGroup('outer', [ExceptionGroup('inner', [ValueError()]), TypeError()])
 except* ValueError as error:
  return error
 return None
`, 'python');
    expect(result.returns.some(item => item.value.atoms.includes('exception-group:ValueError|TypeError'))).toBe(true);
  });

  it('binds Python context-manager targets without claiming modeled enter or ownership semantics', () => {
    const { graph, result } = analyze('def f(path):\n with open(path) as handle:\n  return handle', 'python');
    const use = result.uses.find(item => item.variable.endsWith(':handle'));
    expect(use).toBeDefined();
    expect(use?.mayBeUninitialized).toBe(false);
    expect(use?.definitions.length).toBeGreaterThan(0);
    expect(result.completeness).toBe('partial');
    expect(result.diagnostics.some(d => d.message.includes('ownership lifecycle are not modeled'))).toBe(true);
    expect(graph.nodes.some(node => node.text === '__enter__' && node.binding === 'resource-enter')).toBe(true);
    const exits = graph.nodes.filter(node => node.text === '__exit__');
    expect(exits.length).toBeGreaterThan(0);
    expect(exits.every(node => node.resourceSource && graph.dataflow?.effects[node.id]?.value.kind === 'temporary')).toBe(true);
    expect(Object.values(graph.dataflow?.effects ?? {}).some(effect => effect.value.kind === 'call' && effect.value.arguments.length === 1)).toBe(true);
  });

  it('binds multiple Python context-manager targets before the suite and retains them after exit', () => {
    const { result } = analyze('def f():\n with first() as a, second() as b:\n  inside = (a, b)\n return a, b', 'python');
    for (const name of ['a', 'b']) {
      const uses = result.uses.filter(item => item.variable.endsWith(`:${name}`));
      expect(uses.length).toBeGreaterThanOrEqual(2);
      expect(uses[0].mayBeUninitialized).toBe(false);
    }
    expect(result.uses.filter(item => item.variable.endsWith(':a')).at(-1)?.mayBeUninitialized).toBe(false);
    // If the second __enter__ throws and the first __exit__ suppresses it, b was never bound.
    expect(result.uses.filter(item => item.variable.endsWith(':b')).at(-1)?.mayBeUninitialized).toBe(true);
    expect(result.completeness).toBe('partial');
    expect(result.diagnostics.filter(d => d.message.includes('ownership lifecycle are not modeled'))).toHaveLength(2);
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

  it('tracks proven Rust heap moves while preserving borrowed reads', () => {
    const moved = analyze('fn f(){let x=Value{value:1};let y=x;x.value;}', 'rust').result;
    expect(moved.ownershipFindings).toEqual([
      expect.objectContaining({ kind: 'use-after-move', certainty: 'possible', definitions: expect.arrayContaining([expect.stringContaining(':var:')]) }),
    ]);
    expect(moved.uses.some(use => use.mayBeMoved)).toBe(true);
    const borrowed = analyze('fn f(){let x=Value{value:1};let y=&x;x.value;}', 'rust').result;
    expect(borrowed.ownershipFindings).toEqual([]);
    expect(borrowed.uses.every(use => !use.mayBeMoved)).toBe(true);
    const copyArray = analyze('fn f(){let x=[1,2];let y=x;x[0];}', 'rust').result;
    expect(copyArray.ownershipFindings).toEqual([]);
    const copyStruct = analyze('struct Value{value:i32}\nimpl Copy for Value {}\nfn f(){let x=Value{value:1};let y=x;x;}', 'rust').result;
    expect(copyStruct.ownershipFindings).toEqual([]);
    const derivedCopy = analyze('#[derive(Copy, Clone)]\nstruct Token{value:u32}\nfn f(){let x=Token{value:1};let y=x;x;}', 'rust').result;
    expect(derivedCopy.ownershipFindings).toEqual([]);
    const cloneOnly = analyze('#[derive(Clone)]\nstruct Token{value:u32}\nfn f(){let x=Token{value:1};let y=x;x;}', 'rust').result;
    expect(cloneOnly.ownershipFindings).toEqual([
      expect.objectContaining({ kind: 'use-after-move', certainty: 'possible' }),
    ]);
    const genericCopy = analyze('fn f<T: Copy>(value:T){ let owned=value; value; }', 'rust').result;
    expect(genericCopy.ownershipFindings).toEqual([]);
    const boundedGeneric = analyze('#[derive(Copy, Clone)]\nstruct Wrapper<T: Copy>{value:T}\nfn f(){let x=Wrapper{value:1};let y=x;x;}', 'rust').result;
    expect(boundedGeneric.ownershipFindings).toEqual([]);
    const whereBoundedGeneric = analyze('#[derive(Copy, Clone)]\nstruct Wrapper<T> where T: Copy {value:T}\nfn f(){let x=Wrapper{value:1};let y=x;x;}', 'rust').result;
    expect(whereBoundedGeneric.ownershipFindings).toEqual([]);
    const partiallyBoundedGeneric = analyze('#[derive(Copy, Clone)]\nstruct Pair<T,U:Copy>{first:T,second:U}\nfn f(){let x=Pair{first:Vec::<u8>::new(),second:1};let y=x;x;}', 'rust').result;
    expect(partiallyBoundedGeneric.ownershipFindings).toEqual([
      expect.objectContaining({ kind: 'use-after-move', certainty: 'possible' }),
    ]);
    const genericClone = analyze('fn f<T: Clone>(value:T){ let owned=value; value; }', 'rust').result;
    expect(genericClone.ownershipFindings).toEqual([
      expect.objectContaining({ kind: 'use-after-move', certainty: 'possible' }),
    ]);
    const genericDerived = analyze('#[derive(Copy, Clone)]\nstruct Wrapper<T>{value:T}\nfn f(){let x=Wrapper{value:Vec::<u8>::new()};let y=x;x;}', 'rust').result;
    expect(genericDerived.ownershipFindings).toEqual([
      expect.objectContaining({ kind: 'use-after-move', certainty: 'possible' }),
    ]);
    const copy = analyze('fn f(){let x=1;let y=x;x+1;}', 'rust').result;
    expect(copy.ownershipFindings).toEqual([]);
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

  it('uses exact exception constructor types when dispatching Python handlers', () => {
    const caught = analyze('def f():\n try:\n  raise ValueError\n except ValueError:\n  return 1\n return 2', 'python').result;
    const missed = analyze('def f():\n try:\n  raise ValueError\n except TypeError:\n  return 1\n return 2', 'python').result;
    expect(caught.returns.map(item => item.value.atoms)).toContainEqual(['number:1']);
    expect(missed.returns.map(item => item.value.atoms)).not.toContainEqual(['number:1']);
  });

  it('uses the closed built-in Python exception hierarchy for base handlers', () => {
    const base = analyze('def f():\n try:\n  raise ValueError\n except Exception:\n  return 1', 'python').result;
    const sibling = analyze('def f():\n try:\n  raise ValueError\n except TypeError:\n  return 1', 'python').result;
    expect(base.returns.map(item => item.value.atoms)).toContainEqual(['number:1']);
    expect(sibling.returns.map(item => item.value.atoms)).not.toContainEqual(['number:1']);
  });

  it('preserves the active exception through a Python bare re-raise', () => {
    const result = analyze('def f():\n try:\n  try:\n   raise ValueError\n  except ValueError:\n   raise\n except ValueError:\n  return 1\n return 2\n', 'python').result;
    expect(result.completeness).toBe('complete');
    expect(result.returns.map(item => item.value.atoms)).toContainEqual(['number:1']);
    expect(result.returns.map(item => item.value.atoms)).not.toContainEqual(['number:2']);
  });

  it('tracks Python match capture bindings from the matched subject', () => {
    const result = analyze('def f(value):\n match value:\n  case {"kind": kind, "code": code}:\n   return kind\n  case [head, *tail]:\n   return head\n', 'python').result;
    expect(result.completeness).toBe('complete');
    expect(result.returns.some(item => item.value.parameters.some(parameter => parameter.endsWith(':value')))).toBe(true);
    expect(result.uses.some(use => use.variable.endsWith(':kind') && use.definitions.length > 0)).toBe(true);
  });

  it('keeps only common captures for a Python OR-pattern', () => {
    const result = analyze('def f(value):\n match value:\n  case {"kind": kind} | {"type": kind}:\n   return kind\n', 'python').result;
    expect(result.completeness).toBe('complete');
    expect(result.uses.some(use => use.variable.endsWith(':kind') && use.definitions.length > 0)).toBe(true);
  });

  it('tracks Python class-pattern positional and keyword captures', () => {
    const result = analyze('def f(value):\n match value:\n  case Point(x, y):\n   return x\n  case Point(x=x, y=y):\n   return y\n', 'python').result;
    expect(result.completeness).toBe('complete');
    expect(result.uses.some(use => use.variable.endsWith(':x') && use.definitions.length > 0)).toBe(true);
    expect(result.uses.some(use => use.variable.endsWith(':y') && use.definitions.length > 0)).toBe(true);
    expect(result.returns.some(item => item.value.parameters.some(parameter => parameter.endsWith(':value')))).toBe(true);
  });

  it('does not bind Python match wildcard captures', () => {
    const result = analyze('def f(value):\n match value:\n  case {"kind": _}:\n   return value\n', 'python').result;
    expect(result.completeness).toBe('complete');
    expect(result.definitions.some(definition => definition.location.endsWith(':_'))).toBe(false);
  });

  it('tracks Rust match tuple and struct pattern bindings', () => {
    const result = analyze('fn f(value: E) -> i32 { match value { E::A { x: field } => field, E::B(item, _) => item, _ => 0 } }', 'rust').result;
    expect(result.completeness).toBe('complete');
    expect(result.uses.some(use => use.variable.endsWith(':field') && use.definitions.length > 0)).toBe(true);
    expect(result.uses.some(use => use.variable.endsWith(':item') && use.definitions.length > 0)).toBe(true);
  });

  it('tracks Rust if-let and while-let pattern bindings', () => {
    const ifResult = analyze('fn f(value: Option<String>) { if let Some(item) = value { use_it(item); } }', 'rust').result;
    const whileResult = analyze('fn f(value: Option<String>) { while let Some(item) = value { use_it(item); break; } }', 'rust').result;
    for (const result of [ifResult, whileResult]) {
      expect(result.completeness).toBe('complete');
      expect(result.uses.some(use => use.variable.endsWith(':item') && use.definitions.length > 0)).toBe(true);
    }
  });

  it('marks a Rust match by-value scrutinee as moved after capture', () => {
    const result = analyze('fn f(value: Option<String>) { match value { Some(item) => use_it(item), _ => {} } use_it(value); }', 'rust').result;
    expect(result.ownershipFindings.some(finding => finding.kind === 'use-after-move' && finding.variable.endsWith(':value'))).toBe(true);
  });

  it('does not move a Rust match scrutinee for ref or reference patterns', () => {
    const result = analyze('fn f(value: Option<String>) { match value { Some(ref item) => use_it(item), _ => {} } use_it(value); }', 'rust').result;
    expect(result.ownershipFindings.some(finding => finding.kind === 'use-after-move' && finding.variable.endsWith(':value'))).toBe(false);
  });

  it('preserves source provenance through TypeScript rest destructuring', () => {
    const result = analyze('function f(value: {a:number,b:number}) { const {a, ...rest} = value; return rest.b; }', 'typescript').result;
    expect(result.completeness).toBe('complete');
    expect(result.returns.some(item => item.value.parameters.some(parameter => parameter.endsWith(':value')))).toBe(true);
  });

  it('matches Python exception tuples without treating the tuple as one class', () => {
    const caught = analyze('def f():\n try:\n  raise TypeError\n except (ValueError, TypeError):\n  return 1\n return 2', 'python').result;
    const missed = analyze('def f():\n try:\n  raise OSError\n except (ValueError, TypeError):\n  return 1\n return 2', 'python').result;
    const inherited = analyze('def f():\n try:\n  raise FileNotFoundError\n except (ValueError, OSError):\n  return 1\n return 2', 'python').result;
    expect(caught.returns.map(item => item.value.atoms)).toContainEqual(['number:1']);
    expect(missed.returns.map(item => item.value.atoms)).not.toContainEqual(['number:1']);
    expect(inherited.returns.map(item => item.value.atoms)).toContainEqual(['number:1']);
  });

  it('preserves taint from expressions nested in a simple Python comprehension', () => {
    const result = analyze("import os\ndef f():\n return [os.environ['CODE'] for _ in [1]]\n", 'python').result;
    expect(result.returns.some(item => item.value.atoms.some(atom => atom.startsWith('tainted:python-os-environ')))).toBe(true);
    expect(result.completeness).toBe('complete');
  });

  it('keeps filtered Python comprehensions complete when one filter is lowered', () => {
    const result = analyze('def f(xs):\n return [x for x in xs if x]\n', 'python').result;
    expect(result.completeness).toBe('complete');
  });

  it('models nested Python comprehension iterators without dropping outer dependencies', () => {
    const result = analyze('def f(xs, ys):\n return [x+y for x in xs for y in ys]\n', 'python').result;
    expect(result.completeness).toBe('complete');
    expect(result.returns.some(item => item.value.parameters.some(parameter => parameter.endsWith(':xs')))).toBe(true);
    expect(result.returns.some(item => item.value.parameters.some(parameter => parameter.endsWith(':ys')))).toBe(true);
  });

  it('preserves ordered multiple filters in a single Python comprehension', () => {
    const result = analyze('def f(xs):\n return [x for x in xs if x if x > 1]\n', 'python').result;
    expect(result.completeness).toBe('complete');
  });

  it('lowers filters after the final nested Python comprehension clause', () => {
    const result = analyze('def f(xs, ys):\n return [x+y for x in xs for y in ys if y]\n', 'python').result;
    expect(result.completeness).toBe('complete');
  });

  it('lowers a filter between nested Python comprehension clauses', () => {
    const result = analyze('def f(xs, ys):\n return [x+y for x in xs if x for y in ys if y]\n', 'python').result;
    expect(result.completeness).toBe('complete');
    expect(result.returns.some(item => item.value.parameters.some(parameter => parameter.endsWith(':xs')))).toBe(true);
    expect(result.returns.some(item => item.value.parameters.some(parameter => parameter.endsWith(':ys')))).toBe(true);
  });

  it('preserves parameter provenance through an async Python comprehension', () => {
    const result = analyze('async def f(xs):\n return [x async for x in xs]\n', 'python').result;
    expect(result.completeness).toBe('complete');
    expect(result.returns.some(item => item.value.parameters.some(parameter => parameter.endsWith(':xs')))).toBe(true);
  });

  it('uses local Python exception class bases without guessing unrelated classes', () => {
    const source = 'class MyError(ValueError):\n pass\ndef f():\n try:\n  raise MyError\n except Exception:\n  return 1';
    const file = extractFile(source, 'x.py', 'python', 'ast');
    const graph = file.controlFlow!.find(item => item.owner === 'x.py::f')!;
    expect(graph.dataflow?.exceptionParents).toEqual({ MyError: ['ValueError'] });
    expect(analyzeDataflow(graph).returns.map(item => item.value.atoms)).toContainEqual(['number:1']);
  });

  it('walks multiple local exception bases without collapsing them to one parent', () => {
    const source = 'class MyError(ValueError, OSError):\n pass\ndef f():\n try:\n  raise MyError\n except OSError:\n  return 1';
    const file = extractFile(source, 'x.py', 'python', 'ast');
    const graph = file.controlFlow!.find(item => item.owner === 'x.py::f')!;
    expect(graph.dataflow?.exceptionParents).toEqual({ MyError: ['ValueError', 'OSError'] });
    expect(analyzeDataflow(graph).returns.map(item => item.value.atoms)).toContainEqual(['number:1']);
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
    const formatting = analyze('function f(input){let a={x:1};`${input}`;return a.x;}').result;
    expect(returnedAtoms(formatting)).toContain('*number');
    expect(returnedAtoms(analyze('function f(){let a={x:1};`${1}`;return a.x;}').result)).toEqual(['number:1']);
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
