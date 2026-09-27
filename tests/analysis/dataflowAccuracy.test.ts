import { describe, expect, it } from 'vitest';
import { loadFlowCorpus, evaluateFlowFixture, flowGate, scoreFlow } from '../../bench/dataflow-accuracy.js';
import { analyzeDataflow } from '../../src/analysis/dataflow.js';

describe('handwritten dataflow oracle', () => {
  const corpus = loadFlowCorpus();
  for (const fixture of corpus) it(fixture.id, () => {
    const { graph, result } = evaluateFlowFixture(fixture);
    expect(flowGate(scoreFlow(fixture, graph, result), 1)).toBe(true);
  });
  it('rejects missing results, deleted definitions, invented dependence and fabricated completeness', () => {
    const fixture = corpus.find(f => f.id === 'ts-kill')!;
    const { graph, result } = evaluateFlowFixture(fixture);
    expect(result).toBeDefined();
    for (const mutation of [undefined, { ...result!, definitions: [] }, { ...result!, completeness: 'partial' as const },
      { ...result!, returns: result!.returns.map(r => ({ ...r, value: { ...r.value, parameters: ['x.ts#1:invented'] } })) },
      { ...result!, uses: result!.uses.map(use => ({ ...use, definitions: [] })) }]) {
      expect(flowGate(scoreFlow(fixture, graph, mutation), 1)).toBe(false);
    }
  });
  it('detects a missing assignment transfer and solver truncation', () => {
    const fixture = corpus.find(f => f.id === 'ts-kill')!;
    const { graph } = evaluateFlowFixture(fixture);
    const mutated = structuredClone(graph!);
    for (const [node, effect] of Object.entries(mutated.dataflow!.effects)) if (mutated.nodes[Number(node)].span.line === 3) effect.writes = [];
    expect(flowGate(scoreFlow(fixture, mutated, analyzeDataflow(mutated)), 1)).toBe(false);
    expect(flowGate(scoreFlow(fixture, graph, analyzeDataflow(graph!, { iterationBudget: 1 })), 1)).toBe(false);
  });
});
