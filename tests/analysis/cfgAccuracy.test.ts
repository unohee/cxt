import { describe, expect, it } from 'vitest';
import { loadCfgCorpus, cfgGate, scoreCfg } from '../../bench/cfg-accuracy.js';
import { extractFile } from '../../src/registry/entityScanner.js';

describe('handwritten CFG oracle and gate', () => {
  const corpus = loadCfgCorpus();
  for (const fixture of corpus) it(fixture.id, () => {
    const path = fixture.language === 'typescript' ? 'x.ts' : fixture.language === 'python' ? 'x.py' : 'x.rs';
    const graph = extractFile(fixture.source, path, fixture.language, 'ast').controlFlow!.find(g => g.owner === `${path}::f`);
    expect(cfgGate(scoreCfg(fixture, graph), 1)).toBe(true);
    const covered = graph!.blocks.flatMap(block => block.nodes);
    expect([...covered].sort((a, b) => a - b)).toEqual(graph!.nodes.map(node => node.id));
    expect(new Set(covered).size).toBe(covered.length);
    const membership = new Map(graph!.blocks.flatMap(block => block.nodes.map(node => [node, block.id] as const)));
    for (const edge of graph!.edges) {
      const from = membership.get(edge.from), to = membership.get(edge.to);
      if (from !== to) expect(graph!.blockEdges).toContainEqual({ from, to, kind: edge.kind });
    }
  });

  it('fails for missing graphs, wrong complexity, fabricated completeness and a bypass edge', () => {
    const fixture = corpus.find(f => f.id === 'ts-return')!;
    const graph = extractFile(fixture.source, 'x.ts', 'typescript', 'ast').controlFlow![0];
    const dead = graph.nodes.find(n => n.text === 'dead()')!;
    const mutated = [undefined, { ...graph, structuralComplexity: 1 }, { ...graph, completeness: 'partial' as const },
      { ...graph, edges: [...graph.edges, { from: graph.entry, to: dead.id, kind: 'normal' as const }] },
      { ...graph, nodes: graph.nodes.filter(n => n.id !== dead.id) }];
    for (const value of mutated) expect(cfgGate(scoreCfg(fixture, value), 1)).toBe(false);
    expect(cfgGate(scoreCfg(fixture, graph), 0)).toBe(false);
  });
});
