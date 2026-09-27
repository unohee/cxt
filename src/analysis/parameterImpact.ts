import type { ControlFlowGraph, SourceSpan } from './cfg.js';
import type { DataflowResult } from './dataflow.js';
import type { FunctionSummary } from './summaryTypes.js';

export interface ImpactStep {
  callee: string;
  caller: string;
  callNode: number;
  filePath: string;
  span: SourceSpan;
  evidence: 'return' | 'throw' | 'effect' | 'unknown';
  definitions: string[];
}
export interface ParameterImpact {
  mode: 'parameter-value-impact';
  target: string;
  parameter: string;
  maxDepth: number;
  completeness: 'complete' | 'partial';
  boundaries: Array<{ owner: string; reason: string }>;
  impacted: Array<{ owner: string; filePath: string; depth: number; path: ImpactStep[] }>;
  excluded: Array<{ owner: string; reason: string }>;
  unresolvedCalls: number;
}

/** 현재 parameter의 명시적 value dependence가 caller의 observable output에 닿는 경로. */
export function parameterImpact(graphs: ControlFlowGraph[], flows: DataflowResult[], summaries: FunctionSummary[], owner: string, parameter: string, maxDepth = 5): ParameterImpact {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 100) throw new RangeError('maxDepth must be an integer from 1 to 100');
  const byGraph = new Map(graphs.map(g => [g.owner, g])), byFlow = new Map(flows.map(f => [f.owner, f])), bySummary = new Map(summaries.map(s => [s.owner, s]));
  const seed = bySummary.get(owner);
  if (!seed || !byFlow.has(owner)) throw new Error(`summary_unavailable: ${owner}; rescan source`);
  const selected = seed.parameters.filter(p => p.name === parameter || p.key === parameter);
  if (selected.length !== 1) throw new Error(`parameter_not_found: ${parameter}; available: ${seed.parameters.map(p => p.name).join(', ')}`);
  const key = selected[0].key;
  const unresolved = new Set(graphs.flatMap(graph => Object.entries(graph.dataflow?.effects ?? {}).flatMap(([id, effect]) =>
    effect.value.kind === 'call' && !effect.value.target ? [`${graph.owner}:${graph.nodes[Number(id)].span.startOffset}:${graph.nodes[Number(id)].span.endOffset}`] : [])));
  const result: ParameterImpact = { mode: 'parameter-value-impact', target: owner, parameter: selected[0].name, maxDepth, completeness: 'complete', boundaries: [], impacted: [], excluded: [], unresolvedCalls: unresolved.size };
  const boundary = (current: string, reason: string) => {
    result.completeness = 'partial';
    if (!result.boundaries.some(b => b.owner === current && b.reason === reason)) result.boundaries.push({ owner: current, reason });
  };
  const knownValue = seed.completeness === 'complete' && seed.returnParameters.includes(key);
  const otherEffects = seed.throwParameters.includes(key) || seed.effects.parameters.includes(key);
  if (seed.completeness === 'complete' && !knownValue && !otherEffects) {
    result.excluded.push({ owner, reason: 'parameter-has-no-modeled-value-effect' }); return result;
  }
  if (unresolved.size) boundary(owner, 'unresolved-call-targets-outside-known-graph');
  const callers = new Map<string, Array<{ owner: string; node: number }>>();
  for (const graph of graphs) for (const [node, effect] of Object.entries(graph.dataflow?.effects ?? {})) {
    if (effect.value.kind !== 'call' || !effect.value.target) continue;
    const target = effect.value.target;
    callers.set(target, [...callers.get(target) ?? [], { owner: graph.owner, node: Number(node) }]);
  }
  const queue: Array<{ owner: string; path: ImpactStep[]; uncertain: boolean }> = [{ owner, path: [], uncertain: !knownValue || otherEffects || seed.completeness === 'partial' }];
  const visited = new Set<string>();
  const impacts = new Map<string, ParameterImpact['impacted'][number]>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    const stateKey = `${current.owner}:${current.uncertain}`;
    if (visited.has(stateKey)) continue;
    visited.add(stateKey);
    if (current.uncertain) boundary(current.owner, bySummary.get(current.owner)?.completeness === 'partial' ? 'partial-summary' : 'non-return-effects');
    for (const site of callers.get(current.owner) ?? []) {
      const graph = byGraph.get(site.owner)!, flow = byFlow.get(site.owner), summary = bySummary.get(site.owner);
      if (current.path.length >= maxDepth) { boundary(site.owner, 'depth-limit'); continue; }
      if (flow?.completeness === 'complete' && !flow.reachableNodes.includes(site.node)) continue;
      let evidence: ImpactStep['evidence'] | undefined, pathDefinitions: string[] = [];
      const uncertain = current.uncertain || !flow || !summary || flow.completeness === 'partial' || summary.completeness === 'partial';
      if (uncertain) { evidence = 'unknown'; boundary(site.owner, 'partial-value-boundary'); }
      else {
        const definitions = new Map(flow.definitions.map(d => [d.id, d]));
        const callDefinition = `${site.node}:call:${current.owner}`;
        const reaches = (roots: string[]): string[] | undefined => {
          const pending = roots.map(root => [root]); const seen = new Set<string>();
          for (let i = 0; i < pending.length; i++) {
            const path = pending[i], id = path.at(-1)!;
            if (id === callDefinition) return path;
            if (seen.has(id)) continue;
            seen.add(id);
            for (const dependency of definitions.get(id)?.dependencies ?? []) pending.push([...path, dependency]);
          }
          return undefined;
        };
        const returned = reaches(flow.returns.flatMap(r => r.value.definitions));
        const thrown = reaches(flow.throws.flatMap(r => r.value.definitions));
        const variables = new Map(graph.dataflow?.variables.map(v => [v.key, v]) ?? []);
        const affectedState = flow.definitions.filter(d => d.location.startsWith('heap:')
          || d.location.startsWith('var:') && variables.get(d.location.slice(4))?.category === 'external');
        const effect = reaches(affectedState.map(d => d.id));
        if (returned) { evidence = 'return'; pathDefinitions = returned; }
        else if (thrown) { evidence = 'throw'; pathDefinitions = thrown; }
        else if (effect) { evidence = 'effect'; pathDefinitions = effect; }
      }
      if (!evidence) { result.excluded.push({ owner: site.owner, reason: 'call-result-has-no-modeled-output-use' }); continue; }
      const step: ImpactStep = { callee: current.owner, caller: site.owner, callNode: site.node, filePath: graph.filePath,
        span: graph.nodes[site.node].span, evidence, definitions: pathDefinitions };
      const path = [...current.path, step];
      const previous = impacts.get(site.owner);
      if (!previous || path.length < previous.depth) impacts.set(site.owner, { owner: site.owner, filePath: graph.filePath, depth: path.length, path });
      queue.push({ owner: site.owner, path, uncertain: evidence !== 'return' });
    }
  }
  result.impacted = [...impacts.values()].filter(i => i.owner !== owner).sort((a, b) => a.depth - b.depth || a.owner.localeCompare(b.owner));
  result.excluded = result.excluded.filter(e => !impacts.has(e.owner));
  return result;
}
