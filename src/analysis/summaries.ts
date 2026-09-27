import type { ControlFlowGraph } from './cfg.js';
import type { ResolvedCallSite } from './symbols.js';
import type { FunctionSummary, SummaryParameter } from './summaryTypes.js';
import type { DataExpr } from './dataflowTypes.js';
import { analyzeDataflow, applicableCallSummary, mergeValue, type DataflowResult } from './dataflow.js';
import { externalKey, modelSummary, type LibraryModelCatalog } from './libraryModels.js';

const sorted = (values: string[]) => [...new Set(values)].sort();
const topAtoms = ['*boolean', '*function', '*number', '*object', '*string', 'null', 'undefined', 'unit'];
export interface SummaryAnalysis {
  graphs: ControlFlowGraph[];
  flows: DataflowResult[];
  summaries: FunctionSummary[];
  components: string[][];
}

/** 원본 CFG를 보존하고 resolved call의 정확한 source span만 effect에 연결한다. */
export function linkSummaryCalls(graphs: ControlFlowGraph[], sites: ResolvedCallSite[], models?: LibraryModelCatalog): ControlFlowGraph[] {
  const key = (owner: string, line: number, column: number, endLine: number, endColumn: number) => `${owner}:${line}:${column}:${endLine}:${endColumn}`;
  const targets = new Map(sites.filter(site => site.caller && site.resolution === 'resolved' && site.target)
    .map(site => [key(site.caller!, site.line, site.column, site.endLine, site.endColumn), site.target!]));
  const external = new Map(sites.filter(site => site.caller && site.resolution === 'external' && site.external)
    .map(site => [key(site.caller!, site.line, site.column, site.endLine, site.endColumn), site.external!]));
  return graphs.map(source => {
    const graph: ControlFlowGraph = { ...source, dataflow: source.dataflow && { ...source.dataflow,
      variables: source.dataflow.variables.map(variable => ({ ...variable })),
      effects: Object.fromEntries(Object.entries(source.dataflow.effects).map(([id, effect]) => [id, { ...effect, value: { ...effect.value } }])) } };
    const candidates = new Map<string, Set<string>>();
    const producers = new Map(Object.values(graph.dataflow?.effects ?? {}).map(effect => [effect.resultKey, effect]));
    const writes = new Map<string, DataExpr[]>();
    for (const effect of Object.values(graph.dataflow?.effects ?? {})) for (const write of effect.writes) if (write.target.kind === 'variable') {
      writes.set(write.target.key, [...writes.get(write.target.key) ?? [], write.value]);
    }
    const candidate = (expression: DataExpr, target: string, seen = new Set<string>()): void => {
      if (expression.kind !== 'variable' && expression.kind !== 'temporary') return;
      const key = `${expression.kind}:${expression.key}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (expression.kind === 'temporary') {
        const producer = producers.get(expression.key);
        if (producer) candidate(producer.value, target, seen);
      } else {
        const choices = candidates.get(expression.key) ?? new Set<string>();
        choices.add(target); candidates.set(expression.key, choices);
        for (const value of writes.get(expression.key) ?? []) candidate(value, target, seen);
      }
    };
    for (const [id, effect] of Object.entries(graph.dataflow?.effects ?? {})) {
      if (effect.value.kind !== 'call') continue;
      const span = graph.nodes[Number(id)].span;
      effect.value.target = targets.get(key(graph.owner, span.line, span.column, span.endLine, span.endColumn));
      effect.value.external = external.get(key(graph.owner, span.line, span.column, span.endLine, span.endColumn));
      if (effect.value.external) {
        effect.value.model = models?.select(effect.value.external) ?? { status: 'unmodeled' };
        if (effect.value.model.status === 'candidate') effect.value.target = externalKey(effect.value.external);
      }
      const target = effect.value.target, callee = effect.value.callee;
      if (target) candidate(callee, target);
    }
    // import/외부 lexical binding의 정적 해석을 초기 callable 값으로 연결한다.
    // 이후 unknown 효과가 binding을 바꾸면 그 값을 근거로 요약 적용이 중단된다.
    for (const variable of graph.dataflow?.variables ?? []) {
      const choices = candidates.get(variable.key);
      if (variable.category === 'external' && variable.initial.kind === 'unknown' && choices?.size === 1) variable.initial = { kind: 'entity', target: [...choices][0] };
    }
    return graph;
  });
}

/** Iterative Kosaraju. 깊은 wrapper chain에서도 JavaScript stack에 의존하지 않는다. */
export function summaryComponents(graphs: ControlFlowGraph[]): string[][] {
  const owners = new Set(graphs.map(g => g.owner));
  const calls = new Map(graphs.map(graph => [graph.owner, sorted(Object.values(graph.dataflow?.effects ?? {})
    .flatMap(effect => effect.value.kind === 'call' && effect.value.target && owners.has(effect.value.target) ? [effect.value.target] : []))]));
  const reverse = new Map([...owners].map(owner => [owner, [] as string[]]));
  for (const [caller, callees] of calls) for (const callee of callees) reverse.get(callee)!.push(caller);
  const visited = new Set<string>(), finished: string[] = [];
  for (const owner of owners) {
    if (visited.has(owner)) continue;
    const stack: Array<[string, boolean]> = [[owner, false]];
    while (stack.length) {
      const [current, exiting] = stack.pop()!;
      if (exiting) { finished.push(current); continue; }
      if (visited.has(current)) continue;
      visited.add(current); stack.push([current, true]);
      for (const target of calls.get(current)!) if (!visited.has(target)) stack.push([target, false]);
    }
  }
  const components: string[][] = []; visited.clear();
  for (const owner of finished.reverse()) {
    if (visited.has(owner)) continue;
    const component: string[] = [], stack = [owner]; visited.add(owner);
    while (stack.length) {
      const current = stack.pop()!; component.push(current);
      for (const previous of reverse.get(current)!) if (!visited.has(previous)) { visited.add(previous); stack.push(previous); }
    }
    components.push(component.sort());
  }
  return components.reverse();
}

function fallback(summary: FunctionSummary, reason: string): FunctionSummary {
  const keys = summary.parameters.map(p => p.key);
  return { ...summary, completeness: 'partial', reasons: sorted([...summary.reasons, reason]), returnAtoms: topAtoms,
    returnParameters: keys, mayReturn: true, mayThrow: true, throwParameters: keys,
    effects: { heap: true, bindings: summary.effects.bindings, parameters: keys, unknown: true } };
}

function seed(graph: ControlFlowGraph, component: number): FunctionSummary {
  const parameters: SummaryParameter[] = (graph.dataflow?.parameters ?? []).flatMap(p => p.key && p.name ? [{ ...p, key: p.key, name: p.name }] : []);
  const summary: FunctionSummary = { owner: graph.owner, filePath: graph.filePath, completeness: 'complete', reasons: [], parameters,
    returnAtoms: [], returnParameters: [], mayReturn: false, mayThrow: false, throwParameters: [],
    effects: { heap: false, bindings: [], parameters: [], unknown: false }, component, iterations: 0 };
  if (graph.executionKind && graph.executionKind !== 'sync') return fallback(summary, 'resumable-call-contract');
  return !graph.dataflow?.parameters || graph.dataflow.parameters.some(p => !p.key || !p.name)
    ? fallback(summary, 'unsupported-parameter-binding') : summary;
}

function derive(graph: ControlFlowGraph, flow: DataflowResult, previous: FunctionSummary, available: Map<string, FunctionSummary>): FunctionSummary {
  const keys = new Set(previous.parameters.map(p => p.key));
  const reachable = new Set(flow.reachableNodes);
  const effects = Object.entries(graph.dataflow?.effects ?? {}).filter(([id]) => reachable.has(Number(id))).map(([, effect]) => effect);
  const variables = new Map(graph.dataflow?.variables.map(v => [v.key, v]) ?? []);
  const calls = flow.calls.filter(call => call.resolution === 'summary' && call.target).map(call => available.get(call.target!)!);
  for (const call of flow.calls.filter(call => call.resolution === 'model')) {
    const expression = graph.dataflow!.effects[call.node].value;
    if (expression.kind === 'call' && expression.model?.contract) calls.push(modelSummary(expression.target!, expression.model.contract));
  }
  const bindings = sorted(effects.flatMap(effect => effect.writes.flatMap(write => write.target.kind === 'variable'
    && variables.get(write.target.key)?.category === 'external' ? [write.target.key] : [])));
  const heap = effects.some(effect => effect.writes.some(write => write.target.kind === 'member')) || calls.some(call => call.effects.heap);
  const returned = flow.returns.map(r => r.value);
  const returnAtoms = returned.length ? returned.reduce(mergeValue).atoms : [];
  const mayThrowByOperator = effects.some(effect => ['binary', 'unary'].includes(effect.value.kind));
  const summary: FunctionSummary = { ...previous, completeness: 'complete', reasons: [],
    returnAtoms, returnParameters: sorted(returned.flatMap(v => v.parameters).filter(key => keys.has(key))),
    mayReturn: returned.some(v => v.atoms.length > 0), mayThrow: flow.throws.length > 0 || mayThrowByOperator,
    throwParameters: mayThrowByOperator ? [...keys] : sorted(flow.throws.flatMap(t => t.value.parameters).filter(key => keys.has(key))),
    effects: { heap, bindings: sorted([...bindings, ...calls.flatMap(call => call.effects.bindings)]),
      parameters: heap || bindings.length || calls.some(call => call.effects.bindings.length) ? [...keys] : [], unknown: false } };
  const references = [...calls.flatMap(call => call.models ?? []), ...flow.calls.flatMap(call => call.model?.status === 'applied' && call.model.reference ? [call.model.reference] : [])];
  if (references.length) summary.models = [...new Map(references.map(reference => [JSON.stringify(reference), reference])).values()];
  const reasons = [...previous.reasons, ...flow.diagnostics.map(d => d.code)];
  const definitions = new Map(flow.definitions.map(d => [d.id, d]));
  const pending = [...flow.returns, ...flow.throws].flatMap(output => output.value.definitions), seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const definition = definitions.get(id);
    if (!definition) continue;
    if (definition.location.startsWith('var:') && variables.get(definition.location.slice(4))?.category === 'external') reasons.push('external-value-dependence');
    pending.push(...definition.dependencies);
  }
  if (flow.unknownEffects.length) reasons.push('unknown-external-effect');
  if (returnAtoms.some(atom => atom.startsWith('object:') || atom.startsWith('function:'))) reasons.push('returned-heap-or-closure');
  if (reasons.length || flow.completeness === 'partial') return reasons.reduce(fallback, summary);
  return summary;
}

function joinSummary(left: FunctionSummary, right: FunctionSummary): FunctionSummary {
  const merged = mergeValue({ atoms: left.returnAtoms, definitions: [], parameters: [], alternatives: [] },
    { atoms: right.returnAtoms, definitions: [], parameters: [], alternatives: [] });
  return { ...right, completeness: left.completeness === 'partial' || right.completeness === 'partial' ? 'partial' : 'complete',
    reasons: sorted([...left.reasons, ...right.reasons]), returnAtoms: merged.atoms,
    returnParameters: sorted([...left.returnParameters, ...right.returnParameters]), mayReturn: left.mayReturn || right.mayReturn,
    mayThrow: left.mayThrow || right.mayThrow, throwParameters: sorted([...left.throwParameters, ...right.throwParameters]),
    effects: { heap: left.effects.heap || right.effects.heap, unknown: left.effects.unknown || right.effects.unknown,
      bindings: sorted([...left.effects.bindings, ...right.effects.bindings]), parameters: sorted([...left.effects.parameters, ...right.effects.parameters]) } };
}

export function analyzeSummaries(input: ControlFlowGraph[], sites: ResolvedCallSite[], options: { componentIterationBudget?: number; checkDeadline?: () => void; models?: LibraryModelCatalog } = {}): SummaryAnalysis {
  const limit = options.componentIterationBudget ?? 16;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('componentIterationBudget must be a positive safe integer');
  const graphs = linkSummaryCalls(input, sites, options.models), byOwner = new Map(graphs.map(graph => [graph.owner, graph]));
  const components = summaryComponents(graphs), summaries = new Map<string, FunctionSummary>(), flows = new Map<string, DataflowResult>();
  const contexts = new Map<string, string>();
  const solve = (graph: ControlFlowGraph) => {
    options.checkDeadline?.();
    const context = JSON.stringify(Object.values(graph.dataflow?.effects ?? {}).filter(effect => effect.value.kind === 'call').map(effect => {
      const summary = applicableCallSummary(effect.value, summaries);
      return summary ? { ...summary, iterations: 0, component: 0 } : null;
    }));
    if (contexts.get(graph.owner) === context && flows.has(graph.owner)) return flows.get(graph.owner)!;
    const flow = analyzeDataflow(graph, { summaries });
    contexts.set(graph.owner, context); flows.set(graph.owner, flow); return flow;
  };
  components.forEach((component, id) => component.forEach(owner => summaries.set(owner, seed(byOwner.get(owner)!, id))));
  for (const component of components) {
    const recursive = component.length > 1 || Object.values(byOwner.get(component[0])!.dataflow?.effects ?? {})
      .some(effect => effect.value.kind === 'call' && effect.value.target === component[0]);
    let converged = false;
    for (let round = 1; round <= (recursive ? limit : 1); round++) {
      let changed = false;
      for (const owner of component) {
        const graph = byOwner.get(owner)!, previous = summaries.get(owner)!;
        const flow = solve(graph);
        const next = joinSummary(previous, derive(graph, flow, previous, summaries));
        next.iterations = previous.iterations;
        if (JSON.stringify(previous) !== JSON.stringify(next)) changed = true;
        next.iterations = round; summaries.set(owner, next);
      }
      if (!recursive || !changed) { converged = true; break; }
    }
    if (!converged) {
      for (const owner of component) summaries.set(owner, fallback(summaries.get(owner)!, 'component-iteration-budget'));
      for (const owner of component) {
        solve(byOwner.get(owner)!);
      }
    }
  }
  return { graphs, flows: [...flows.values()], summaries: [...summaries.values()], components };
}
