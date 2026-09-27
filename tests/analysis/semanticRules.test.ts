import { describe, expect, it } from 'vitest';
import { analyzeSemanticRules } from '../../src/analysis/semanticRules.js';
import { builtInRulePack, rulePackSchema } from '../../src/analysis/rulePack.js';
import { analyzeFileContent } from '../../src/registry/bsDetector.js';
import { extractFile } from '../../src/registry/entityScanner.js';
import { resolveSymbols } from '../../src/analysis/resolveSymbols.js';
import { analyzeDataflow } from '../../src/analysis/dataflow.js';

describe('semantic rule boundary', () => {
  it('emits source-located def-use evidence only when local analysis completes', () => {
    const source = 'def f():\n print(x)\n x=1';
    const full = analyzeSemanticRules(source, 'x.py', 'python');
    expect(full.completeness).toBe('complete');
    const hit = full.findings.find(hit => hit.rule.id === 'cxt/uninitialized-read')!;
    expect(hit.span.line).toBe(2);
    expect(hit.flow?.owner).toBe('x.py::f');
    expect(hit.flow?.definitions.length).toBeGreaterThan(0);
    expect(hit.flow?.steps.at(-1)).toEqual(hit.span);
    const partial = analyzeSemanticRules(source + '\n yield x', 'x.py', 'python');
    expect(partial.completeness).toBe('partial');
    expect(partial.diagnostics.length).toBeGreaterThan(0);
    expect(partial.findings.some(hit => hit.rule.id === 'cxt/uninitialized-read')).toBe(false);
  });
  it('shares category suppression with AST rules and fails on invalid source', () => {
    expect(analyzeSemanticRules('def f():\n print(x) # cxt-ignore: correctness\n x=1', 'x.py', 'python').findings).toEqual([]);
    expect(() => analyzeFileContent('def broken(', 'x.py', 'python')).toThrow('syntax-error');
    expect(analyzeFileContent('package example', 'x.go', 'go')).toMatchObject({ engine: 'lexical', completeness: 'partial' });
    expect(() => analyzeFileContent('function f(){return 1;}', 'x.ts', 'typescript', { checkDeadline: () => { throw new Error('deadline'); } })).toThrow('deadline');
  });
  it('validates metadata rather than silently accepting malformed rule packs', () => {
    expect(rulePackSchema.safeParse({ ...builtInRulePack, rules: [...builtInRulePack.rules, builtInRulePack.rules[0]] }).success).toBe(false);
    expect(rulePackSchema.safeParse({ ...builtInRulePack, rules: [{ ...builtInRulePack.rules[0], precisionBasis: 'measured' }] }).success).toBe(false);
    expect(rulePackSchema.safeParse({ ...builtInRulePack, rules: [{ ...builtInRulePack.rules[0], fixtures: {} }] }).success).toBe(false);
  });
  it('treats private named constant containers as definitions', () => {
    const result = analyzeFileContent('_BUDGET: dict[str, int] = {"light": 4_000, "heavy": 16_000}', 'profiles.py', 'python');
    expect(result.issues.filter(issue => issue.category === 'magic_number')).toEqual([]);
  });
  it('resolves object initializer names in lexical scope, retaining member lookup and caller', () => {
    const source = 'function run(){return 1;} function f(name){const obj={name:name,run:run()};return obj.name;} const api={run:run}; api.run();';
    const extracted = extractFile(source, 'x.ts', 'typescript', 'ast');
    const calls = resolveSymbols([extracted.symbols!]).calls;
    expect(calls.map(call => [call.target, call.caller])).toEqual([['x.ts::run', 'x.ts::f'], ['x.ts::run', undefined]]);
    const graph = extracted.controlFlow!.find(graph => graph.owner === 'x.ts::f')!;
    const flow = analyzeDataflow(graph);
    expect(flow.uses.filter(use => use.variable.endsWith(':name')).every(use => !use.mayBeUninitialized)).toBe(true);
    expect(analyzeFileContent(source, 'x.ts', 'typescript').issues.filter(issue => issue.category === 'correctness')).toEqual([]);
  });
  it('retains real lexical TDZ reads inside object values and skips class field names', () => {
    const source = 'function f(){const obj={name:name};let name=1;return obj;}';
    expect(analyzeFileContent(source, 'x.ts', 'typescript').issues.filter(issue => issue.category === 'correctness')).toHaveLength(1);
    const classSource = 'function name(){return 1;} class Box { static name = name(); }';
    expect(resolveSymbols([extractFile(classSource, 'x.ts', 'typescript', 'ast').symbols!]).calls[0].target).toBe('x.ts::name');
  });
});
