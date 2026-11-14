import type { ControlFlowGraph } from './cfg.js';
import type { ExternalSymbol, ResolvedCallSite } from './symbols.js';
import type { FunctionSummary, SummaryParameter } from './summaryTypes.js';
import type { DataExpr } from './dataflowTypes.js';
import { analyzeDataflow, applicableCallSummary, mergeValue, type DataflowResult } from './dataflow.js';
import { externalKey, modelSummary, type LibraryModelCatalog } from './libraryModels.js';
import { hashText, type AnalysisCache } from './cache.js';

const sorted = (values: string[]) => [...new Set(values)].sort();
const topAtoms = ['*boolean', '*function', '*number', '*object', '*string', 'null', 'undefined', 'unit'];
/** Map a canonical model parameter to the source argument slot, including Python keywords. */
function modelArgumentIndex(expression: Extract<DataExpr, { kind: 'call' }>, parameter: number): number | undefined {
  const contract = expression.model?.contract;
  if (!contract?.parameterNames?.length || !expression.keywordArguments?.some(Boolean))
    return parameter < expression.arguments.length ? parameter : undefined;
  const assigned = new Map<number, number>(), used = new Set<number>();
  let nextPositional = 0;
  for (let actual = 0; actual < expression.arguments.length; actual++) {
    const name = expression.keywordArguments?.[actual] ? expression.argumentNames?.[actual] : undefined;
    let target: number | undefined;
    if (name) {
      const named = contract.parameterNames.indexOf(name);
      if (named >= 0) target = named;
    } else {
      while (used.has(nextPositional)) nextPositional++;
      if (nextPositional < contract.parameters.length) target = nextPositional++;
    }
    if (target !== undefined && !used.has(target)) { assigned.set(target, actual); used.add(target); }
  }
  return assigned.get(parameter);
}
export interface SummaryAnalysis {
  graphs: ControlFlowGraph[];
  flows: DataflowResult[];
  summaries: FunctionSummary[];
  components: string[][];
  cache: { reusedComponents: number; computedComponents: number };
}
interface CachedComponent { flows: DataflowResult[]; summaries: FunctionSummary[] }

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
    let uncertainBefore = false;
    for (const [id, effect] of Object.entries(graph.dataflow?.effects ?? {})) {
      if (effect.value.kind !== 'call') continue;
      const span = graph.nodes[Number(id)].span;
      const originalCallee = effect.value.callee;
      const originalProducer = originalCallee.kind === 'temporary' ? producers.get(originalCallee.key) : undefined;
      effect.value.target = targets.get(key(graph.owner, span.line, span.column, span.endLine, span.endColumn));
      effect.value.external = external.get(key(graph.owner, span.line, span.column, span.endLine, span.endColumn));
      // Python builtins are normally called without an import statement. Use
      // the same versioned model catalog for an unbound external name, while
      // leaving local shadowing and unresolved user imports untouched.
      const producerVariable = originalProducer?.value.kind === 'variable' ? originalProducer.value : undefined;
      if (!effect.value.target && !effect.value.external && (graph.language === 'python' || graph.language === 'typescript')
        && producerVariable) {
        const binding = graph.dataflow?.variables.find(variable => variable.key === producerVariable.key);
        const builtinName = binding?.name;
        const builtinModule = graph.language === 'python' ? 'builtins'
          : ['eval', 'Function', 'fetch', 'URL'].includes(builtinName ?? '') ? 'global' : undefined;
        if (binding?.category === 'external' && builtinName && builtinModule) {
          const builtin: ExternalSymbol = { language: graph.language, module: builtinModule, symbol: builtinName };
          const selection = models?.select(builtin);
          if (selection?.status === 'candidate') {
            effect.value.external = builtin;
            effect.value.model = selection;
            effect.value.target = externalKey(builtin);
            effect.value.callee = { kind: 'entity', target: effect.value.target };
            if (originalProducer) originalProducer.value = { kind: 'entity', target: effect.value.target };
          }
        }
      }
      // TypeScript global member APIs such as JSON.parse/stringify are
      // represented as an external object property rather than a callable
      // lexical binding. Resolve only the known global object and only when
      // its binding remains external; local JSON shadowing stays unresolved.
      const producerMember = originalProducer?.value.kind === 'member' ? originalProducer.value : undefined;
      const memberObjectProducer = producerMember?.object.kind === 'temporary' ? producers.get(producerMember.object.key) : undefined;
      const memberObject = memberObjectProducer?.value.kind === 'variable' ? memberObjectProducer.value : undefined;
      const memberBinding = memberObject ? graph.dataflow?.variables.find(variable => variable.key === memberObject.key) : undefined;
      if (!effect.value.target && !effect.value.external && graph.language === 'typescript'
        && memberBinding?.category === 'external' && memberBinding.name === 'JSON'
        && ['parse', 'stringify'].includes(producerMember?.property ?? '')) {
        const builtin: ExternalSymbol = { language: graph.language, module: 'global', symbol: `JSON.${producerMember!.property}` };
        const selection = models?.select(builtin);
        if (selection?.status === 'candidate') {
          effect.value.external = builtin;
          effect.value.model = selection;
          effect.value.target = externalKey(builtin);
          effect.value.callee = { kind: 'entity', target: effect.value.target };
          if (originalProducer) originalProducer.value = { kind: 'entity', target: effect.value.target };
        }
      }
      if (effect.value.external) {
        effect.value.model = models?.select(effect.value.external) ?? { status: 'unmodeled' };
        if (effect.value.model.status === 'candidate') {
          effect.value.target = externalKey(effect.value.external);
          if (!uncertainBefore && originalProducer?.value.kind === 'member') {
            // The resolver already proved this external binding. Namespace and
            // default property calls otherwise remain an opaque member value in
            // the flow graph and fail the model's callee proof.
            effect.value.callee = { kind: 'entity', target: effect.value.target };
            originalProducer.value = { kind: 'entity', target: effect.value.target };
          }
        }
      }
      const target = effect.value.target, callee = effect.value.callee;
      if (target) candidate(callee, target);
      if (!effect.value.target && !effect.value.external) uncertainBefore = true;
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
  const parameterIndexes = new Map(previous.parameters.map((parameter, index) => [parameter.key, index]));
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
  const freshResourceCall = calls.find(call => call.returnsResource);
  const parameterResourceKeys = returned.map(result => [...new Set(result.atoms.filter(atom => atom.startsWith('resource-param:')).map(atom => atom.slice('resource-param:'.length)))]);
  const borrowedKey = parameterResourceKeys.length && parameterResourceKeys.every(keys => keys.length === 1 && keys[0] === parameterResourceKeys[0][0])
    ? parameterResourceKeys[0][0] : undefined;
  const borrowedIndex = borrowedKey === undefined ? undefined : parameterIndexes.get(borrowedKey);
  const parameterAliasKeys = returned.map(result => [...new Set(result.atoms.filter(atom => atom.startsWith('parameter:')).map(atom => atom.slice('parameter:'.length)))]);
  const aliasKey = parameterAliasKeys.length && parameterAliasKeys.every(keys => keys.length === 1 && keys[0] === parameterAliasKeys[0][0])
    ? parameterAliasKeys[0][0] : undefined;
  const returnsParameter = aliasKey === undefined ? undefined : parameterIndexes.get(aliasKey);
  const returnsResource = returned.length && returned.every(value => value.atoms.some(atom => atom.startsWith('resource:'))) ? {
    source: 'fresh' as const, ...(freshResourceCall?.returnsResource?.enter ? { enter: freshResourceCall.returnsResource.enter } : {})
  } : borrowedIndex !== undefined ? { source: 'parameter' as const, parameter: borrowedIndex } : undefined;
  const releasesResource = flow.calls.flatMap(call => {
    const expression = graph.dataflow?.effects[call.node]?.value;
    const contract = expression?.kind === 'call' && expression.model?.status === 'candidate' ? expression.model.contract?.resource : undefined;
    if (!contract || contract.action !== 'release' || contract.identity !== 'argument' || contract.parameter === undefined || expression?.kind !== 'call') return [];
    const argument = expression.arguments[contract.parameter];
    const abstractArgument = flow.calls.find(candidate => candidate.node === call.node)?.arguments[contract.parameter];
    const parameter = argument?.kind === 'variable' && parameterIndexes.has(argument.key) ? parameterIndexes.get(argument.key)
      : abstractArgument?.parameters.length === 1 ? parameterIndexes.get(abstractArgument.parameters[0]) : undefined;
    return parameter === undefined ? [] : [{ parameter }];
  })[0];
  const movesParameters = [...new Set(flow.calls.flatMap(call => {
    const expression = graph.dataflow?.effects[call.node]?.value;
    const summary = (call.target ? available.get(call.target) : undefined)
      ?? (expression?.kind === 'call' && expression.model?.contract ? modelSummary(expression.target!, expression.model.contract) : undefined);
    if (!summary?.movesParameters?.length || expression?.kind !== 'call') return [];
    return summary.movesParameters.flatMap(parameter => {
      const argument = expression.arguments[parameter];
      const abstractArgument = call.arguments[parameter];
      const index = argument?.kind === 'variable' && parameterIndexes.has(argument.key) ? parameterIndexes.get(argument.key)
        : abstractArgument?.parameters.length === 1 ? parameterIndexes.get(abstractArgument.parameters[0]) : undefined;
      return index === undefined ? [] : [String(index)];
    });
  }))].map(Number).sort((left, right) => left - right);
  const borrowsParameters = [...new Set(flow.calls.flatMap(call => {
    const expression = graph.dataflow?.effects[call.node]?.value;
    const summary = (call.target ? available.get(call.target) : undefined)
      ?? (expression?.kind === 'call' && expression.model?.contract ? modelSummary(expression.target!, expression.model.contract) : undefined);
    if (!summary?.borrowsParameters?.length || expression?.kind !== 'call') return [];
    return summary.borrowsParameters.flatMap(parameter => {
      const argument = expression.arguments[parameter];
      const abstractArgument = call.arguments[parameter];
      const index = argument?.kind === 'variable' && parameterIndexes.has(argument.key) ? parameterIndexes.get(argument.key)
        : abstractArgument?.parameters.length === 1 ? parameterIndexes.get(abstractArgument.parameters[0]) : undefined;
      return index === undefined ? [] : [String(index)];
    });
  }))].map(Number).sort((left, right) => left - right);
  const callbackParameters = [...new Set(flow.calls.flatMap(call => {
    const expression = graph.dataflow?.effects[call.node]?.value;
    const summary = (call.target ? available.get(call.target) : undefined)
      ?? (expression?.kind === 'call' && expression.model?.contract ? modelSummary(expression.target!, expression.model.contract) : undefined);
    if (!summary?.callbackParameters?.length || expression?.kind !== 'call') return [];
    return summary.callbackParameters.flatMap(parameter => {
      const position = parameter === 'last' ? expression.arguments.length - 1 : modelArgumentIndex(expression, parameter);
      const argument = position === undefined ? undefined : expression.arguments[position];
      const abstractArgument = position === undefined ? undefined : call.arguments[position];
      const index = argument?.kind === 'variable' && parameterIndexes.has(argument.key) ? parameterIndexes.get(argument.key)
        : abstractArgument?.parameters.length === 1 ? parameterIndexes.get(abstractArgument.parameters[0]) : undefined;
      return index === undefined ? [] : [String(index)];
    });
  }))].map(Number).sort((left, right) => left - right);
  const callbackInvocationCandidates = flow.calls.flatMap(call => {
    const expression = graph.dataflow?.effects[call.node]?.value;
    const summary = (call.target ? available.get(call.target) : undefined)
      ?? (expression?.kind === 'call' && expression.model?.contract ? modelSummary(expression.target!, expression.model.contract) : undefined);
    if (!summary?.callbackInvocations?.length || expression?.kind !== 'call') return [];
    return summary.callbackInvocations.flatMap(invocation => {
      const callbackPosition = invocation.callbackParameter === 'last' ? expression.arguments.length - 1 : modelArgumentIndex(expression, invocation.callbackParameter);
      const callbackArgument = callbackPosition === undefined ? undefined : expression.arguments[callbackPosition];
      const callbackIndex = callbackArgument?.kind === 'variable' && parameterIndexes.has(callbackArgument.key) ? parameterIndexes.get(callbackArgument.key)
        : callbackPosition !== undefined && call.arguments[callbackPosition]?.parameters.length === 1 ? parameterIndexes.get(call.arguments[callbackPosition].parameters[0]) : undefined;
      const argumentIndexes = invocation.argumentParameters.map(parameter => {
        const position = modelArgumentIndex(expression, parameter);
        const argument = position === undefined ? undefined : expression.arguments[position];
        return argument?.kind === 'variable' && parameterIndexes.has(argument.key) ? parameterIndexes.get(argument.key)
          : position !== undefined && call.arguments[position]?.parameters.length === 1 ? parameterIndexes.get(call.arguments[position].parameters[0]) : undefined;
      });
      const variadicArgumentParameters = invocation.variadicArgumentFrom === undefined ? [] : expression.arguments.slice(invocation.variadicArgumentFrom).map((argument, offset) => {
        const parameter = invocation.variadicArgumentFrom! + offset;
        return argument.kind === 'variable' && parameterIndexes.has(argument.key) ? parameterIndexes.get(argument.key)
          : call.arguments[parameter]?.parameters.length === 1 ? parameterIndexes.get(call.arguments[parameter].parameters[0]) : undefined;
      }).filter((index): index is number => index !== undefined);
      if (callbackIndex === undefined || argumentIndexes.some(index => index === undefined)) return [];
      return [{ callbackParameter: callbackIndex, argumentParameters: argumentIndexes as number[],
        ...(variadicArgumentParameters.length ? { variadicArgumentParameters } : {}),
        ...(invocation.taintArgumentPositions?.length ? { taintArgumentPositions: invocation.taintArgumentPositions } : {}) }];
    });
  });
  const callbackInvocations = [...new Map(callbackInvocationCandidates.map(invocation => [JSON.stringify(invocation), invocation])).values()]
    .sort((left, right) => left.callbackParameter - right.callbackParameter || left.argumentParameters.join(',').localeCompare(right.argumentParameters.join(',')));
  const taintSanitizesParameters = [...new Set(flow.calls.flatMap(call => {
    const expression = graph.dataflow?.effects[call.node]?.value;
    const summary = (call.target ? available.get(call.target) : undefined)
      ?? (expression?.kind === 'call' && expression.model?.contract ? modelSummary(expression.target!, expression.model.contract) : undefined);
    if (!summary?.taintSanitizesParameters?.length || expression?.kind !== 'call') return [];
    return summary.taintSanitizesParameters.flatMap(parameter => {
      const abstractArgument = call.arguments[parameter];
      const formalKeys = abstractArgument?.parameters ?? [];
      const indexes = formalKeys.map(key => parameterIndexes.get(key)).filter((index): index is number => index !== undefined);
      return indexes.length === 1 ? indexes : [];
    });
  }))].sort((left, right) => left - right);
  const taintSinkParameters = [...new Set([
    ...flow.calls.flatMap(call => (call.taintParameterFlows ?? []).flatMap(flow =>
      flow.sourceParameters.map(source => parameterIndexes.get(source)).filter((index): index is number => index !== undefined))),
    ...flow.calls.flatMap(call => {
      const expression = graph.dataflow?.effects[call.node]?.value;
      const contract = expression?.kind === 'call' ? expression.model?.contract : undefined;
      if (!contract?.taint?.sinkParameters || expression?.kind !== 'call') return [];
      return contract.taint.sinkParameters.flatMap(parameter => {
        const position = modelArgumentIndex(expression, parameter);
        const argument = position === undefined ? undefined : expression.arguments[position];
        return argument?.kind === 'variable' && parameterIndexes.has(argument.key) ? [parameterIndexes.get(argument.key)!] : [];
      });
    }),
  ])]
    .sort((left, right) => left - right);
  const directMoves = flow.movedParameters ?? [];
  const directBorrows = flow.borrowedParameters ?? [];
  const mayThrowByOperator = effects.some(effect => ['binary', 'unary'].includes(effect.value.kind));
  const summary: FunctionSummary = { ...previous, completeness: 'complete', reasons: [],
    returnAtoms, returnParameters: sorted(returned.flatMap(v => v.parameters).filter(key => keys.has(key))),
    mayReturn: returned.some(v => v.atoms.length > 0), mayThrow: flow.throws.length > 0 || mayThrowByOperator,
    throwParameters: mayThrowByOperator ? [...keys] : sorted(flow.throws.flatMap(t => t.value.parameters).filter(key => keys.has(key))),
    effects: { heap, bindings: sorted([...bindings, ...calls.flatMap(call => call.effects.bindings)]),
      parameters: heap || bindings.length || calls.some(call => call.effects.bindings.length) ? [...keys] : [], unknown: false },
    ...(returnsResource ? { returnsResource } : {}),
    ...(returnsParameter !== undefined ? { returnsParameter } : {}),
    ...(releasesResource ? { releasesResource } : {}),
    ...((movesParameters.length || directMoves.length) ? { movesParameters: [...new Set([...movesParameters, ...directMoves])].sort((left, right) => left - right) } : {}),
    ...((borrowsParameters.length || directBorrows.length) ? { borrowsParameters: [...new Set([...borrowsParameters, ...directBorrows])].sort((left, right) => left - right) } : {}),
    ...(callbackParameters.length ? { callbackParameters } : {}),
    ...(callbackInvocations.length ? { callbackInvocations } : {}),
    ...(taintSanitizesParameters.length ? { taintSanitizesParameters } : {}),
    ...(taintSinkParameters.length ? { taintSinkParameters } : {}) };
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
      bindings: sorted([...left.effects.bindings, ...right.effects.bindings]), parameters: sorted([...left.effects.parameters, ...right.effects.parameters]) },
    ...(left.returnsResource && right.returnsResource && left.returnsResource.source === right.returnsResource.source
      && (left.returnsResource.source === 'fresh' || (left.returnsResource as { source: 'parameter'; parameter: number }).parameter
        === (right.returnsResource as { source: 'parameter'; parameter: number }).parameter)
      ? { returnsResource: left.returnsResource.source === 'fresh'
        ? { source: 'fresh' as const, ...(left.returnsResource.enter === right.returnsResource.enter && left.returnsResource.enter ? { enter: left.returnsResource.enter } : {}) }
        : { source: 'parameter' as const, parameter: (left.returnsResource as { source: 'parameter'; parameter: number }).parameter } } : {}),
    ...(left.releasesResource && right.releasesResource && left.releasesResource.parameter === right.releasesResource.parameter
      ? { releasesResource: { parameter: left.releasesResource.parameter } } : {}),
    ...(left.returnsParameter !== undefined && left.returnsParameter === right.returnsParameter
      ? { returnsParameter: left.returnsParameter } : {}),
    ...(left.movesParameters && right.movesParameters && JSON.stringify(left.movesParameters) === JSON.stringify(right.movesParameters)
      ? { movesParameters: left.movesParameters } : {}),
    ...(left.borrowsParameters && right.borrowsParameters && JSON.stringify(left.borrowsParameters) === JSON.stringify(right.borrowsParameters)
      ? { borrowsParameters: left.borrowsParameters } : {}),
    ...(left.callbackParameters && right.callbackParameters && JSON.stringify(left.callbackParameters) === JSON.stringify(right.callbackParameters)
      ? { callbackParameters: left.callbackParameters } : {}),
    ...(left.callbackInvocations && right.callbackInvocations && JSON.stringify(left.callbackInvocations) === JSON.stringify(right.callbackInvocations)
      ? { callbackInvocations: left.callbackInvocations } : {}),
    ...(left.taintSinkParameters && right.taintSinkParameters && JSON.stringify(left.taintSinkParameters) === JSON.stringify(right.taintSinkParameters)
      ? { taintSinkParameters: left.taintSinkParameters } : {}) };
}

export function analyzeSummaries(input: ControlFlowGraph[], sites: ResolvedCallSite[], options: { componentIterationBudget?: number; checkDeadline?: () => void; models?: LibraryModelCatalog;
  cache?: AnalysisCache; engineKey?: string; exceptionParents?: Record<string, string[]> } = {}): SummaryAnalysis {
  const limit = options.componentIterationBudget ?? 16;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('componentIterationBudget must be a positive safe integer');
  const graphs = linkSummaryCalls(input, sites, options.models).map(graph => {
    if (!options.exceptionParents || graph.dataflow?.exceptionParents === undefined && !Object.keys(options.exceptionParents).length) return graph;
    const local = graph.dataflow?.exceptionParents ?? {};
    const merged = Object.fromEntries(Object.entries(options.exceptionParents ?? {}).map(([name, parents]) => [name, [...new Set([...(local[name] ?? []), ...parents])]]));
    return graph.dataflow ? { ...graph, dataflow: { ...graph.dataflow, exceptionParents: merged } } : graph;
  }), byOwner = new Map(graphs.map(graph => [graph.owner, graph]));
  const components = summaryComponents(graphs), summaries = new Map<string, FunctionSummary>(), flows = new Map<string, DataflowResult>();
  const contexts = new Map<string, string>();
  const cache = { reusedComponents: 0, computedComponents: 0 };
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
    options.checkDeadline?.();
    const members = new Set(component);
    const dependencies = sorted(component.flatMap(owner => Object.values(byOwner.get(owner)!.dataflow?.effects ?? {})
      .flatMap(effect => effect.value.kind === 'call' && effect.value.target && !members.has(effect.value.target) ? [effect.value.target] : [])));
    const cacheKey = hashText(JSON.stringify(component));
    const inputHash = hashText(JSON.stringify({ engine: options.engineKey, limit, graphs: component.map(owner => byOwner.get(owner)),
      dependencies: dependencies.map(owner => {
        const summary = summaries.get(owner);
        return [owner, summary ? { ...summary, component: 0, iterations: 0 } : null];
      }), models: options.models?.manifest }));
    const cached = options.cache?.get('summary', cacheKey, inputHash) as CachedComponent | undefined;
    if (cached) {
      const id = summaries.get(component[0])!.component;
      for (const summary of cached.summaries) summaries.set(summary.owner, { ...summary, component: id });
      for (const flow of cached.flows) flows.set(flow.owner, flow);
      cache.reusedComponents++;
      options.cache!.set('summary', cacheKey, inputHash, cached);
      continue;
    }
    cache.computedComponents++;
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
    options.cache?.set('summary', cacheKey, inputHash, { flows: component.map(owner => flows.get(owner)!), summaries: component.map(owner => summaries.get(owner)!) });
  }
  return { graphs, flows: [...flows.values()], summaries: [...summaries.values()], components, cache };
}
