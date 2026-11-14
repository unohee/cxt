import { describe, expect, it } from 'vitest';
import { extractFile } from '../../src/registry/entityScanner.js';
import { resolveSymbols } from '../../src/analysis/resolveSymbols.js';
import { analyzeSummaries } from '../../src/analysis/summaries.js';
import { parameterImpact } from '../../src/analysis/parameterImpact.js';

function analyze(source: string) {
  const parsed = extractFile(source, 'x.ts', 'typescript', 'ast');
  return analyzeSummaries(parsed.controlFlow!, resolveSymbols([parsed.symbols!]).calls);
}
describe('parameter value impact paths', () => {
  it('traces used call results through wrappers and excludes discarded results', () => {
    const a = analyze('function pick(a,b){return b;}function used(x){return pick(0,x);}function outer(x){return used(x);}function discard(x){pick(0,x);return 0;}');
    const result = parameterImpact(a.graphs, a.flows, a.summaries, 'x.ts::pick', 'b');
    expect(result.completeness).toBe('complete');
    expect(result.impacted.map(i => i.owner)).toEqual(['x.ts::used', 'x.ts::outer']);
    expect(result.excluded).toContainEqual({ owner: 'x.ts::discard', reason: 'call-result-has-no-modeled-output-use' });
    const path = result.impacted[1].path;
    expect(path.map(step => [step.callee, step.caller, step.evidence])).toEqual([['x.ts::pick', 'x.ts::used', 'return'], ['x.ts::used', 'x.ts::outer', 'return']]);
    expect(path.every(step => step.definitions.some(id => id.includes('call:')) && step.span.column > 0)).toBe(true);
  });

  it('returns no value impact for an ignored formal parameter', () => {
    const a = analyze('function pick(a,b){return b;}function caller(x){return pick(x,0);}');
    const result = parameterImpact(a.graphs, a.flows, a.summaries, 'x.ts::pick', 'a');
    expect(result.impacted).toEqual([]);
    expect(result.completeness).toBe('complete');
    expect(() => parameterImpact(a.graphs, a.flows, a.summaries, 'x.ts::pick', 'missing')).toThrow('parameter_not_found');
  });

  it('retains a boundary when unknown effects or unresolved target coverage prevent exclusion', () => {
    const a = analyze('function id(x){return x;}function caller(x){external();id(x);return 0;}');
    const result = parameterImpact(a.graphs, a.flows, a.summaries, 'x.ts::id', 'x');
    expect(result.completeness).toBe('partial');
    expect(result.unresolvedCalls).toBe(1);
    expect(result.impacted[0].path[0].evidence).toBe('unknown');
    expect(result.boundaries.some(b => b.reason === 'unresolved-call-targets-outside-known-graph')).toBe(true);
  });

  it('fails closed at the traversal depth limit', () => {
    const a = analyze('function id(x){return x;}function first(x){return id(x);}function second(x){return first(x);}');
    const result = parameterImpact(a.graphs, a.flows, a.summaries, 'x.ts::id', 'x', 1);
    expect(result.completeness).toBe('partial');
    expect(result.boundaries).toContainEqual({ owner: 'x.ts::second', reason: 'depth-limit' });
  });

  it('does not merge unrelated call-site values into an output path', () => {
    const a = analyze('function id(x){return x;}function caller(left,right){const a=id(left);const b=id(right);return a;}');
    const result = parameterImpact(a.graphs, a.flows, a.summaries, 'x.ts::id', 'x');
    expect(result.impacted).toHaveLength(1);
    const graph = a.graphs.find(g => g.owner === 'x.ts::caller')!;
    expect(graph.nodes[result.impacted[0].path[0].callNode].text).toBe('id(left)');
  });
});
