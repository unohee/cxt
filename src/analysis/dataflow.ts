import type { CfgNode, ControlFlowGraph } from './cfg.js';
import type { DataExpr, DataflowDiagnostic, FlowLocation, NodeEffect } from './dataflowTypes.js';
import type { FunctionSummary } from './summaryTypes.js';
import { modelSummary, type ModelApplication, type ModelSelection } from './libraryModels.js';

export interface AbstractValue {
  atoms: string[];
  definitions: string[];
  parameters: string[];
  alternatives: Array<{ definition: string; atoms: string[]; parameters: string[] }>;
}
export interface FlowDefinition {
  id: string;
  location: string;
  node: number;
  dependencies: string[];
}
export interface FlowUse {
  node: number;
  variable: string;
  definitions: string[];
  mayBeUninitialized: boolean;
  /** Rust ownership state: a moved value may no longer be read. */
  mayBeMoved?: boolean;
  value: AbstractValue;
}
export interface OwnershipFinding {
  kind: 'use-after-move';
  node: number;
  variable: string;
  certainty: 'definite' | 'possible';
  /** Definition IDs that establish the moved state; resolve through FlowDefinition. */
  definitions: string[];
}
export interface FlowCall {
  node: number;
  target?: string;
  arguments: AbstractValue[];
  resolution: 'summary' | 'model' | 'unknown';
  model?: ModelApplication;
  /** Statically proven callback function targets passed to this call. */
  callbacks?: string[];
  taintFindings?: Array<{ parameter: number; atoms: string[]; sourceDefinitions?: string[] }>;
  /** Formal value provenance reaching a modeled sink, even before a caller supplies taint. */
  taintParameterFlows?: Array<{ parameter: number; sourceParameters: string[] }>;
  resource?: { action: 'acquire' | 'release'; identity: 'return' | 'receiver' | 'argument'; ids: string[] };
}
export interface ResourceEvent {
  node: number;
  action: 'acquire' | 'release';
  identity: 'return' | 'receiver' | 'argument';
  ids: string[];
  proven: boolean;
}
export interface ResourceFinding {
  kind: 'use-after-release' | 'leak';
  node: number;
  ids: string[];
  certainty: 'definite' | 'possible';
  /** Static CFG nodes that acquired or released the resource; this is not a runtime trace. */
  sourceNodes?: number[];
}
export interface DataflowResult {
  owner: string;
  completeness: 'complete' | 'partial';
  iterations: number;
  workUnits: number;
  unknownEffects: number[];
  diagnostics: DataflowDiagnostic[];
  definitions: FlowDefinition[];
  uses: FlowUse[];
  returns: Array<{ node: number; value: AbstractValue }>;
  throws: Array<{ node: number; value: AbstractValue }>;
  calls: FlowCall[];
  resourceEvents: ResourceEvent[];
  resourceFindings: ResourceFinding[];
  ownershipFindings: OwnershipFinding[];
  /** Rust formal parameters directly consumed by this function. */
  movedParameters: number[];
  /** Rust formal parameters directly borrowed by this function. */
  borrowedParameters: number[];
  taintFindings: Array<{ node: number; target?: string; parameter: number; atoms: string[]; sourceDefinitions?: string[] }>;
  reachableNodes: number[];
}
type State = Map<string, AbstractValue>;
const unknownAtoms = ['undefined', 'null', '*boolean', '*number', '*string', '*object', '*function', 'unit'];
const normalizedUnknownAtoms = [...unknownAtoms].sort();
const unique = (values: string[]) => [...new Set(values)].sort();
const atomType = (atom: string) => atom.startsWith('*') ? atom.slice(1) : atom.slice(0, atom.indexOf(':') < 0 ? atom.length : atom.indexOf(':'));
const wideningTypes = new Set(['number', 'string', 'boolean', 'object', 'function']);
/** Closed set of Python built-in exception inheritance used for safe handler matching. */
const pythonExceptionParents: Record<string, string | undefined> = {
  BaseException: undefined,
  Exception: 'BaseException', ArithmeticError: 'Exception', FloatingPointError: 'ArithmeticError', OverflowError: 'ArithmeticError', ZeroDivisionError: 'ArithmeticError',
  LookupError: 'Exception', IndexError: 'LookupError', KeyError: 'LookupError', OSError: 'Exception', FileNotFoundError: 'OSError', PermissionError: 'OSError',
  RuntimeError: 'Exception', NotImplementedError: 'RuntimeError', RecursionError: 'RuntimeError', StopIteration: 'Exception', StopAsyncIteration: 'Exception',
  SyntaxError: 'Exception', IndentationError: 'SyntaxError', TabError: 'IndentationError', SystemError: 'Exception', TypeError: 'Exception', ValueError: 'Exception',
  UnicodeError: 'ValueError', UnicodeDecodeError: 'UnicodeError', UnicodeEncodeError: 'UnicodeError', UnicodeTranslateError: 'UnicodeError', AssertionError: 'Exception',
  AttributeError: 'Exception', ImportError: 'Exception', ModuleNotFoundError: 'ImportError', NameError: 'Exception', UnboundLocalError: 'NameError', RuntimeWarning: 'Exception',
};
function pythonExceptionMatches(actual: string, expected: string, localParents: Record<string, string[]> = {}): boolean | undefined {
  if (actual === '*' || expected === '*') return undefined;
  if (actual === expected) return true;
  const known = (name: string) => name in localParents || name in pythonExceptionParents;
  if (!known(actual) || !known(expected)) return false;
  const parentsOf = (name: string) => localParents[name] ?? (name in pythonExceptionParents ? [pythonExceptionParents[name]].filter((parent): parent is string => parent !== undefined) : []);
  const pending = [...parentsOf(actual)], seen = new Set<string>();
  while (pending.length) {
    const parent = pending.shift()!;
    if (seen.has(parent)) continue;
    seen.add(parent);
    if (parent === expected) return true;
    pending.push(...parentsOf(parent));
  }
  return false;
}
function normalizeAtoms(atoms: string[]): string[] {
  if (atoms === unknownAtoms) return [...normalizedUnknownAtoms];
  if (atoms.length < 2) return [...atoms];
  const normalized = unique(atoms), counts = new Map<string, number>(), wildcards = new Set<string>();
  for (const atom of normalized) {
    const type = atomType(atom);
    if (!wideningTypes.has(type)) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (atom.startsWith('*')) wildcards.add(type);
  }
  const widened = new Set([...counts].filter(([type, count]) => count > (type === 'object' || type === 'function' ? 32 : 8)
    || wildcards.has(type) && count > 1).map(([type]) => type));
  return widened.size ? [...normalized.filter(atom => !widened.has(atomType(atom))), ...[...widened].map(type => `*${type}`)].sort() : normalized;
}
function value(atoms: string[], definitions: string[] = [], parameters: string[] = [], alternatives?: AbstractValue['alternatives']): AbstractValue {
  const normalized = normalizeAtoms(atoms);
  const normalizedDefinitions = unique(definitions), normalizedParameters = unique(parameters);
  // 모든 정의가 같은 값을 받는 일반 경로에서 정의마다 동일 정규화를 반복하지 않는다.
  if (!alternatives) return { atoms: normalized, definitions: normalizedDefinitions, parameters: normalizedParameters,
    alternatives: [...normalizedDefinitions].sort((a, b) => a.localeCompare(b)).map(definition => ({ definition, atoms: [...normalized], parameters: [...normalizedParameters] })) };
  const grouped = new Map<string, { atoms: string[]; parameters: string[] }>();
  for (const alternative of alternatives) {
    const old = grouped.get(alternative.definition);
    grouped.set(alternative.definition, { atoms: normalizeAtoms([...old?.atoms ?? [], ...alternative.atoms]), parameters: unique([...old?.parameters ?? [], ...alternative.parameters]) });
  }
  return { atoms: normalized, definitions: normalizedDefinitions, parameters: normalizedParameters,
    alternatives: [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([definition, choice]) => ({ definition, ...choice })) };
}
const taintAtoms = (sources: AbstractValue[]) => unique(sources.flatMap(v => v.atoms
  .filter(atom => atom === 'tainted' || atom.startsWith('tainted:'))));
/** Unknown values retain explicit taint so opaque expressions fail closed at modeled sinks. */
const unknown = (sources: AbstractValue[] = []) => value([...unknownAtoms, ...taintAtoms(sources)],
  sources.flatMap(v => v.definitions), sources.flatMap(v => v.parameters));
const sameList = (left: string[], right: string[]) => left === right || (left.length === right.length && left.every((item, i) => item === right[i]));
const sameValue = (left: AbstractValue, right: AbstractValue) => left === right || (sameList(left.atoms, right.atoms)
  && sameList(left.definitions, right.definitions) && sameList(left.parameters, right.parameters)
  && left.alternatives.length === right.alternatives.length && left.alternatives.every((choice, i) => {
    const other = right.alternatives[i];
    return choice.definition === other.definition && sameList(choice.atoms, other.atoms) && sameList(choice.parameters, other.parameters);
  }));
export function mergeValue(left: AbstractValue, right: AbstractValue): AbstractValue {
  if (sameValue(left, right)) return left;
  const mergeList = (a: string[], b: string[]) => sameList(a, b) ? a : unique([...a, ...b]);
  const mergeAtoms = (a: string[], b: string[]) => sameList(a, b) ? a : normalizeAtoms([...a, ...b]);
  // 이미 정규화된 choice를 보존하고 겹치는 정의의 값만 합친다.
  // localeCompare가 같아도 Unicode bytes가 다른 정의는 별개로 유지한다.
  const alternatives = new Map(left.alternatives.map(choice => [choice.definition, choice]));
  for (const choice of right.alternatives) {
    const previous = alternatives.get(choice.definition);
    alternatives.set(choice.definition, previous ? { definition: choice.definition,
      atoms: mergeAtoms(previous.atoms, choice.atoms), parameters: mergeList(previous.parameters, choice.parameters) } : choice);
  }
  return { atoms: mergeAtoms(left.atoms, right.atoms), definitions: mergeList(left.definitions, right.definitions),
    parameters: mergeList(left.parameters, right.parameters), alternatives: [...alternatives.values()].sort((a, b) => a.definition.localeCompare(b.definition)) };
}
function joinState(existing: State | undefined, incoming: State): { state: State; changed: boolean } {
  if (!existing) return { state: new Map(incoming), changed: true };
  const state = new Map(existing);
  let changed = false;
  for (const [key, incomingValue] of incoming) {
    const old = state.get(key), next = old ? mergeValue(old, incomingValue) : incomingValue;
    if (!old || !sameValue(old, next)) { state.set(key, next); changed = true; }
  }
  return { state, changed };
}
const scalarAtom = (input: string | number | boolean) => `${typeof input}:${JSON.stringify(input)}`;
function concrete(atom: string): string | number | boolean | null | undefined {
  if (atom === 'null') return null;
  if (atom === 'undefined') return undefined;
  const separator = atom.indexOf(':');
  return JSON.parse(atom.slice(separator + 1)) as string | number | boolean;
}
const isConcrete = (atom: string) => ['null', 'undefined'].includes(atom) || /^(number|string|boolean):/.test(atom);

export function applicableCallSummary(expr: DataExpr, summaries?: ReadonlyMap<string, FunctionSummary>): FunctionSummary | undefined {
  if (expr.kind !== 'call' || !expr.target || expr.argumentsKnown === false) return undefined;
  const summary = summaries?.get(expr.target);
  // An opaque sink may intentionally make a wrapper partial because its
  // side-effects are unknown. Keep that uncertainty for heap/value results,
  // but still consume an explicit taint contract at the caller. Without this
  // exception, `wrapper(source()) -> sink` disappears merely because the sink
  // is correctly modeled as effectful.
  const usableTaintContract = !!summary && (summary.taintSource === true
    || summary.taintSinkParameters?.length
    || summary.taintReturnParameters?.length
    || summary.taintSanitizesParameters?.length);
  // Internal summaries do not yet carry a keyword-signature contract. Keep
  // named calls partial rather than silently treating keyword order as
  // positional; external model contracts opt in through parameterNames.
  if (expr.keywordArguments?.some(Boolean) && !summary?.models?.length) return undefined;
  if (!summary || summary.completeness !== 'complete' && !usableTaintContract || summary.parameters.some(p => p.receiver)
    || summary.parameters.length !== expr.arguments.length) return undefined;
  return summary;
}

/** CFG의 유한 추상값에 worklist를 적용한다. 진단은 수렴 후 상태에서 만든다. */
export function analyzeDataflow(graph: ControlFlowGraph, options: { iterationBudget?: number; stateBudget?: number; workBudget?: number;
  summaries?: ReadonlyMap<string, FunctionSummary> } = {}): DataflowResult {
  const result: DataflowResult = { owner: graph.owner, completeness: 'complete', iterations: 0, workUnits: 0,
    diagnostics: [], definitions: [], uses: [], returns: [], throws: [], calls: [], resourceEvents: [], resourceFindings: [], ownershipFindings: [], movedParameters: [], borrowedParameters: [], taintFindings: [], reachableNodes: [], unknownEffects: [] };
  const facts = graph.dataflow;
  if (!facts) {
    result.completeness = 'partial'; result.diagnostics.push({ code: 'unsupported-effect', message: 'Dataflow facts are absent; rescan source' }); return result;
  }
  const localExceptionParents = facts.exceptionParents ?? {};
  result.diagnostics.push(...facts.diagnostics);
  if (graph.completeness === 'partial') result.diagnostics.push({ code: 'partial-cfg', message: 'CFG contains unsupported control or exceeded its budget' });
  if (result.diagnostics.length) result.completeness = 'partial';
  const budget = options.iterationBudget ?? Math.max(1024, graph.nodes.length * 64);
  const stateBudget = options.stateBudget ?? 100_000;
  const workBudget = options.workBudget ?? 250_000;
  if (!Number.isSafeInteger(budget) || budget < 1) throw new RangeError('iterationBudget must be a positive safe integer');
  if (!Number.isSafeInteger(stateBudget) || stateBudget < 1) throw new RangeError('stateBudget must be a positive safe integer');
  if (!Number.isSafeInteger(workBudget) || workBudget < 1) throw new RangeError('workBudget must be a positive safe integer');
  const variables = new Map(facts.variables.map(v => [v.key, v]));
  const allParameters = facts.variables.filter(v => v.category === 'parameter').map(v => v.key);
  const outgoing = new Map<number, typeof graph.edges>();
  for (const edge of graph.edges) outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge]);
  const definitions = new Map<string, FlowDefinition>();
  const modeledTaintDefinitions = new Set<string>();
  const unknownEffects = new Set<number>();
  const heapOpen = new Map<string, boolean>();
  // 루프의 allocation은 여러 실제 객체를 나타낼 수 있어 strong field update를 피한다.
  const repeatedAllocation = graph.edges.some(e => e.kind === 'back'
    || (e.kind === 'true' && graph.nodes[e.to].kind === 'join' && graph.nodes[e.to].text === 'loop header'));
  let recording = false;
  let currentNode = graph.entry;
  const variableCell = (key: string) => `var:${key}`;
  const temporaryCell = (key: string) => `temp:${key}`;
  const fieldCell = (object: string, property: string) => `heap:${JSON.stringify([object, property])}`;
  const callbackEventCell = (receiver: string, event: string) => `callback-event:${JSON.stringify([receiver, event])}`;
  // A parameter/unknown object has no concrete allocation id. Keep fields
  // keyed by its reaching definition so same-object writes and reads can
  // still meet without merging unrelated receivers.
  const symbolicFieldCell = (definition: string, property: string) => fieldCell(`unknown:${definition}`, property);
  const resourceCell = (id: string) => `resource-state:${id}`;
  const resourceEnterCell = (id: string) => `resource-enter:${id}`;
  const resourceAtom = (id: string) => `resource:${id}`;
  const resourceIdsFromValue = (input: AbstractValue) => input.atoms.filter(atom => atom.startsWith('resource:')).map(atom => atom.slice('resource:'.length));
  const resourceOriginNodes = new Map<string, number>();
  const resourceReleaseNodes = new Map<string, number>();
  // Filled only when a modeled acquire contract actually produced the same
  // resource identity at __enter__/__aenter__. Candidate contracts with bad
  // arguments must keep the lifecycle diagnostic and remain partial.
  const modeledResourceEntries = new Set<number>();
  // A context-manager lowering has separate CFG nodes for enter, cleanup, and
  // exit. Keep the source span so a proven model can clear the lifecycle
  // diagnostic emitted on any of those nodes, including async variants.
  const modeledResourceSources = new Set<string>();
  const copyHeapObjects = new Set<string>();
  const resourceSourceNodes = (ids: string[]) => [...new Set(ids.flatMap(id => [resourceOriginNodes.get(id), resourceReleaseNodes.get(id)]))]
    .filter((node): node is number => node !== undefined).sort((a, b) => a - b);
  const resourceFinding = (finding: ResourceFinding) => { if (recording) result.resourceFindings.push(finding); };
  const ownershipFinding = (finding: OwnershipFinding) => { if (recording) result.ownershipFindings.push(finding); };

  // 이후 effect에서 읽는 지역 변수와 임시 값만 보존한다. 루프와 finally 복제도 CFG edge를 따른다.
  const liveTemporaries = graph.nodes.map(() => new Set<string>());
  const directReads = graph.nodes.map(() => new Set<string>());
  function collectTemporaries(expression: DataExpr, reads: Set<string>): void {
    if (expression.kind === 'temporary') reads.add(temporaryCell(expression.key));
    else if (expression.kind === 'variable') reads.add(variableCell(expression.key));
    else if (expression.kind === 'unknown' || expression.kind === 'non-null') expression.sources?.forEach(e => collectTemporaries(e, reads));
    else if (expression.kind === 'member') collectTemporaries(expression.object, reads);
    else if (expression.kind === 'unary') collectTemporaries(expression.value, reads);
    else if (expression.kind === 'binary') { collectTemporaries(expression.left, reads); collectTemporaries(expression.right, reads); }
    else if (expression.kind === 'call') {
      collectTemporaries(expression.callee, reads); expression.arguments.forEach(e => collectTemporaries(e, reads));
      if (expression.receiver) collectTemporaries(expression.receiver, reads);
    }
    else if (expression.kind === 'allocation') expression.fields.forEach(([, e]) => collectTemporaries(e, reads));
  }
  for (const [id, effect] of Object.entries(facts.effects)) {
    const reads = directReads[Number(id)];
    collectTemporaries(effect.value, reads);
    if (effect.guard) collectTemporaries(effect.guard, reads);
    for (const write of effect.writes) {
      collectTemporaries(write.value, reads);
      if (write.target.kind === 'member') collectTemporaries(write.target.object, reads);
    }
  }
  if (graph.implicitReturnSource) directReads[graph.exit].add(temporaryCell(`${graph.implicitReturnSource.startOffset}:${graph.implicitReturnSource.endOffset}`));
  const predecessors = graph.nodes.map(() => new Set<number>());
  graph.edges.forEach(edge => predecessors[edge.to].add(edge.from));
  const liveQueue = graph.nodes.map(n => n.id), liveQueued = new Set(liveQueue);
  for (let i = 0; i < liveQueue.length; i++) {
    const id = liveQueue[i]; liveQueued.delete(id);
    const next = new Set(directReads[id]);
    const effect = facts.effects[id];
    const written = new Set(effect ? [temporaryCell(effect.resultKey), ...effect.deletes.map(variableCell),
      ...effect.writes.flatMap(write => write.target.kind === 'variable' ? [variableCell(write.target.key)] : [])] : []);
    for (const edge of outgoing.get(id) ?? []) for (const key of liveTemporaries[edge.to]) {
      if (!written.has(key) || edge.kind === 'exception' || edge.kind === 'suspend') next.add(key);
    }
    if (next.size !== liveTemporaries[id].size || [...next].some(key => !liveTemporaries[id].has(key))) {
      liveTemporaries[id] = next;
      for (const previous of predecessors[id]) if (!liveQueued.has(previous)) { liveQueue.push(previous); liveQueued.add(previous); }
    }
  }

  function recordDefinition(location: string, source: AbstractValue, node = currentNode): string {
    const id = `${node}:${location}`;
    if (recording) {
      const previous = definitions.get(id);
      definitions.set(id, { id, location, node, dependencies: unique([...previous?.dependencies ?? [], ...source.definitions]) });
    }
    return id;
  }
  function getLocation(target: FlowLocation, state: State): string[] {
    if (target.kind === 'variable') return [variableCell(target.key)];
    const object = evaluate(target.object, state);
    const objects = object.atoms.filter(atom => atom.startsWith('object:')).map(atom => atom.slice(7));
    if (target.property === '*' || object.atoms.includes('*object') && objects.length) {
      const cells = [...state.keys()].filter(key => key.startsWith('heap:')
        && (object.atoms.includes('*object') || objects.some(id => key.startsWith(`heap:[${JSON.stringify(id)},`))));
      return unique([...cells, ...objects.map(id => fieldCell(id, '*'))]);
    }
    if (objects.length) return objects.map(id => fieldCell(id, target.property));
    if (target.property === '*') return object.definitions.map(definition => symbolicFieldCell(definition, '*'));
    return object.definitions.map(definition => symbolicFieldCell(definition, target.property));
  }
  function member(object: AbstractValue, property: string, state: State, expression?: DataExpr): AbstractValue {
    // Node's process.env is a taint source.  Treat only an unresolved external
    // binding named `process` as the Node global; a local declaration with the
    // same name is represented as local/parameter and therefore cannot reach
    // this branch.  This is an intrinsic member source rather than a callable
    // library model, so computed/unknown properties remain conservative.
    if ((graph.language === 'typescript' && property === 'env') || (graph.language === 'python' && property === 'environ')) {
      const expectedName = graph.language === 'typescript' ? 'process' : 'os';
      const directBinding = expression?.kind === 'variable' ? variables.get(expression.key) : undefined;
      const definitionBinding = object.definitions.map(definition => definition.split('var:')[1])
        .map(key => key ? variables.get(key) : undefined).find(binding => binding?.name === expectedName);
      const binding = directBinding ?? definitionBinding;
      if (binding?.category === 'external' && binding.name === expectedName) {
        return graph.language === 'typescript'
          ? value(['tainted:node-process-env'], ['external:node:process.env'])
          : value(['tainted:python-os-environ'], ['external:python:os.environ']);
      }
    }
    let found: AbstractValue | undefined;
    const symbolicReceiver = property !== '*' && object.definitions.length > 0
      && !object.atoms.some(atom => atom.startsWith('object:'));
    for (const atom of object.atoms) {
      let next: AbstractValue;
      if (atom.startsWith('object:')) {
        const id = atom.slice(7);
        if (property === '*') {
          const fields = [...state].filter(([key]) => key.startsWith(`heap:[${JSON.stringify(id)},`)).map(([, v]) => v);
          next = fields.reduce(mergeValue, unknown([object]));
        } else {
          next = state.get(fieldCell(id, property)) ?? (heapOpen.get(id) ? unknown([object]) : value(['undefined'], object.definitions, object.parameters));
          const wildcard = state.get(fieldCell(id, '*'));
          if (wildcard) next = mergeValue(next, wildcard);
        }
      } else if (symbolicReceiver) continue;
      else next = unknown([object]);
      found = found ? mergeValue(found, next) : next;
    }
    if (!found && property !== '*') {
      for (const definition of object.definitions) {
        const next = state.get(symbolicFieldCell(definition, property)) ?? state.get(symbolicFieldCell(definition, '*'));
        if (next) found = found ? mergeValue(found, next) : next;
      }
    }
    return found ?? unknown([object]);
  }
  function evaluate(expr: DataExpr, state: State): AbstractValue {
    switch (expr.kind) {
      case 'exception': {
        const pending = state.get('pending:exception');
        const source = expr.source ? evaluate(expr.source, state) : unknown();
        if (pending) return expr.source ? mergeValue(pending, source) : pending;
        const sourceParameters = expr.source?.kind === 'variable' ? [...source.parameters, expr.source.key] : source.parameters;
        const group = expr.groupTypes?.length ? [`exception-group:${expr.groupTypes.join('|')}`] : [];
        return value([...(expr.type ? [`exception:${expr.type}`] : ['exception:*']), ...group, ...source.atoms], source.definitions, sourceParameters);
      }
      case 'rethrow': return state.get('pending:exception') ?? unknown();
      case 'exception-match': {
        const pending = state.get('pending:exception');
        if (!pending) return unknown();
        const types = pending.atoms.filter(atom => atom.startsWith('exception:')).map(atom => atom.slice('exception:'.length));
        const groups = pending.atoms.filter(atom => atom.startsWith('exception-group:')).map(atom => atom.slice('exception-group:'.length).split('|'));
        if ((!types.length || types.includes('*')) && !groups.length) return value(['boolean:true', 'boolean:false'], pending.definitions, pending.parameters);
        // Python permits a tuple of exception classes in one handler. The
        // frontend keeps the condition text intact, so split only the
        // syntactic outer tuple here; nested/dynamic expressions stay
        // conservative through the existing unknown result.
        const expectedTypes = expr.type.trim().replace(/^\((.*)\)$/, '$1').split(',').map(type => type.trim()).filter(Boolean);
        if (expectedTypes.length === 0) return value(['boolean:true', 'boolean:false'], pending.definitions, pending.parameters);
        // The wrapper ExceptionGroup type describes the container, while
        // except* dispatches on its members. Do not let the container's
        // negative match manufacture an unmatched branch when member types
        // are known.
        const dispatchTypes = groups.length ? types.filter(type => !['ExceptionGroup', 'BaseExceptionGroup'].includes(type)) : types;
        const matches = dispatchTypes.map(type => expectedTypes.map(expected => pythonExceptionMatches(type, expected, localExceptionParents)));
        const groupOutcomes = groups.flatMap(group => {
          const memberMatches = group.map(actual => expectedTypes.map(expected => pythonExceptionMatches(actual, expected, localExceptionParents)));
          const flat = memberMatches.flat();
          const hasTrue = flat.some(match => match === true), hasFalse = flat.some(match => match === false), hasUnknown = flat.some(match => match === undefined);
          return hasUnknown || (hasTrue && hasFalse) ? [true, false] : hasTrue ? [true] : [false];
        });
        const outcomes = matches.flatMap(candidates => candidates.some(match => match === true)
          ? [true] : candidates.some(match => match === undefined) ? [true, false] : [false]);
        outcomes.push(...groupOutcomes);
        return value([...new Set(outcomes.map(match => scalarAtom(match)))], pending.definitions, pending.parameters);
      }
      case 'undefined': case 'null': case 'unit': case 'uninitialized': return value([expr.kind]);
      case 'literal': return value([scalarAtom(expr.value)]);
      case 'non-null': {
        const sources = expr.sources?.map(source => evaluate(source, state)) ?? [];
        return value([`*${['number', 'string', 'boolean', 'function'].includes(expr.type) ? expr.type : 'object'}`,
          ...taintAtoms(sources)], sources.flatMap(source => source.definitions), sources.flatMap(source => source.parameters));
      }
      case 'unknown': return unknown(expr.sources?.map(source => evaluate(source, state)));
      case 'entity': return value([`function:${expr.target}`]);
      case 'variable': {
        const found = state.get(variableCell(expr.key)) ?? unknown();
        if (recording) result.uses.push({ node: currentNode, variable: expr.key, definitions: found.definitions,
          mayBeUninitialized: found.atoms.includes('uninitialized'), mayBeMoved: found.atoms.includes('moved'), value: found });
        if (found.atoms.includes('moved')) ownershipFinding({ kind: 'use-after-move', node: currentNode, variable: expr.key,
          certainty: 'possible', definitions: found.definitions });
        return found;
      }
      case 'temporary': return state.get(temporaryCell(expr.key)) ?? unknown();
      case 'member': return member(evaluate(expr.object, state), expr.property, state, expr.object);
      case 'allocation': {
        heapOpen.set(expr.id, expr.open);
        if (expr.copy) copyHeapObjects.add(expr.id);
        const fields = expr.fields.map(([key, expression]) => [key, evaluate(expression, state)] as const);
        for (const [key, source] of fields) {
          const cell = fieldCell(expr.id, key);
          const next = value(source.atoms, [recordDefinition(cell, source)], source.parameters);
          const old = state.get(cell);
          state.set(cell, old && repeatedAllocation ? mergeValue(old, next) : next);
          state.set(`shape:${cell}`, value(['boolean:true']));
        }
        return value([`object:${expr.id}`, ...taintAtoms(fields.map(([, v]) => v))], fields.flatMap(([, v]) => v.definitions), fields.flatMap(([, v]) => v.parameters));
      }
      case 'call': {
        const arguments_ = expr.arguments.map(argument => evaluate(argument, state));
        let summary = applicableSummary(expr, state);
        const application = modelApplication(expr, state);
        const modelContract = application?.status === 'applied' ? expr.model?.contract : undefined;
        if (!summary && modelContract && expr.target) summary = modelSummary(expr.target, modelContract);
        const argumentAt = (parameter: number): AbstractValue | undefined => {
          const actual = modelContract ? modelArgumentIndex(expr, modelContract, parameter) : parameter;
          return actual === undefined ? undefined : arguments_[actual];
        };
        const contract = application?.status === 'applied' ? expr.model?.contract?.resource : undefined;
        const receiverExpr = expr.receiver ?? (expr.callee.kind === 'member' ? expr.callee.object : undefined);
        const receiverValue = receiverExpr ? evaluate(receiverExpr, state) : undefined;
        const receiverKeys = (input: AbstractValue | undefined) => input ? [...new Set([
          ...input.atoms.filter(atom => atom.startsWith('object:')).map(atom => atom.slice('object:'.length)),
          ...input.definitions.map(definition => `unknown:${definition}`),
        ])] : [];
        const eventNames = (input: AbstractValue | undefined) => input ? [...new Set(input.atoms
          .filter(atom => atom.startsWith('string:')).map(atom => concrete(atom)).filter((event): event is string => typeof event === 'string'))] : [];
        const summaryFresh = summary?.returnsResource?.source === 'fresh';
        const summaryBorrowed = summary?.returnsResource?.source === 'parameter' ? summary.returnsResource : undefined;
        const summaryParameter = summary?.returnsParameter;
        const summaryAcquires = summaryFresh;
        const summaryReleases = summary?.releasesResource;
        const summaryMoves = summary?.movesParameters ?? [];
        const taintReturnParameters = summary?.taintReturnParameters ?? [];
        const taintReturnVariadic = summary?.taintReturnVariadic === true;
        const taintSanitizesParameters = new Set(summary?.taintSanitizesParameters ?? []);
        const callbackTargets = [...new Set((summary?.callbackParameters ?? []).flatMap(parameter => {
          const position = parameter === 'last' ? arguments_.length - 1
            : modelContract ? modelArgumentIndex(expr, modelContract, parameter) : parameter;
          return (position !== undefined && position >= 0 ? arguments_[position]?.atoms ?? [] : []).filter(atom => atom.startsWith('function:')).map(atom => atom.slice('function:'.length));
        }))];
        const callbackTargetsFromDefinitions = (input: AbstractValue | undefined) => [...new Set((input?.definitions ?? []).flatMap(definition => {
          const marker = definition.indexOf('var:');
          if (marker < 0) return [];
          const variable = variables.get(definition.slice(marker + 4));
          return variable?.initial.kind === 'entity' ? [variable.initial.target] : [];
        }))];
        const eventRegistrations = modelContract?.callbacks.flatMap(callback => {
          if (callback.eventParameter === undefined) return [];
          const callbackPosition = callback.parameter === 'last' ? arguments_.length - 1
            : modelArgumentIndex(expr, modelContract, callback.parameter);
          const eventPosition = modelArgumentIndex(expr, modelContract, callback.eventParameter);
          const callbackValue = callbackPosition !== undefined && callbackPosition >= 0 ? arguments_[callbackPosition] : undefined;
          const eventValue = eventPosition !== undefined && eventPosition >= 0 ? arguments_[eventPosition] : undefined;
          return receiverKeys(receiverValue).flatMap(receiver => eventNames(eventValue).map(event => ({ receiver, event, callbackValue, once: callback.once })));
        }) ?? [];
        for (const registration of eventRegistrations) {
          if (!registration.callbackValue) continue;
          const cell = callbackEventCell(registration.receiver, registration.event);
          const callbackAtoms = registration.callbackValue.atoms.filter(atom => atom.startsWith('function:'));
          const definitionTargets = callbackTargetsFromDefinitions(registration.callbackValue);
          const callbackState = value((callbackAtoms.length ? callbackAtoms
            : [...new Set([...callbackTargets, ...definitionTargets])].map(target => `function:${target}`))
            .map(atom => `${registration.once ? 'callback-once:' : 'callback:'}${atom}`), registration.callbackValue.definitions, registration.callbackValue.parameters);
          const old = state.get(cell);
          state.set(cell, old ? mergeValue(old, callbackState) : callbackState);
        }
        const eventRemovals: Array<{ receiver: string; event: string | undefined; callbackTargets: string[] }> = modelContract?.removes && receiverValue
          ? receiverKeys(receiverValue).flatMap((receiver): Array<{ receiver: string; event: string | undefined; callbackTargets: string[] }> => {
            const eventPosition = modelContract.removes!.eventParameter === undefined ? undefined
              : modelArgumentIndex(expr, modelContract, modelContract.removes!.eventParameter);
            const eventValue = eventPosition !== undefined && eventPosition >= 0 ? arguments_[eventPosition] : undefined;
            const callbackPosition = modelContract.removes!.callbackParameter === undefined ? undefined
              : modelArgumentIndex(expr, modelContract, modelContract.removes!.callbackParameter);
            const callbackValue = callbackPosition !== undefined && callbackPosition >= 0 ? arguments_[callbackPosition] : undefined;
            const callbackTargets = callbackValue?.atoms.filter(atom => atom.startsWith('function:'))
              .map(atom => `callback:${atom}`) ?? [];
            if (modelContract.removes!.all && eventPosition === undefined) return [{ receiver, event: undefined, callbackTargets }];
            return eventNames(eventValue).map(event => ({ receiver, event, callbackTargets }));
          })
          : [];
        for (const removal of eventRemovals) {
          if (removal.event === undefined) {
            const prefix = `callback-event:${JSON.stringify([removal.receiver, '']).slice(0, -2)}`;
            for (const cell of [...state.keys()].filter(key => key.startsWith(prefix))) state.delete(cell);
            continue;
          }
          const cell = callbackEventCell(removal.receiver, removal.event);
          if (modelContract?.removes?.callbackParameter === undefined) {
            state.delete(cell);
            continue;
          }
          const current = state.get(cell);
          if (!current) continue;
          const remaining = current.atoms.filter(atom => !removal.callbackTargets.includes(atom));
          if (remaining.length) state.set(cell, value(remaining, current.definitions, current.parameters));
          else state.delete(cell);
        }
        const emittedCallbackFindings = modelContract?.emits && receiverValue
          ? receiverKeys(receiverValue).flatMap(receiver => {
            const eventPosition = modelArgumentIndex(expr, modelContract, modelContract.emits!.eventParameter);
            const eventValue = eventPosition !== undefined && eventPosition >= 0 ? arguments_[eventPosition] : undefined;
            return eventNames(eventValue).flatMap(event => {
              const cell = callbackEventCell(receiver, event);
              const callbacks = state.get(cell);
              const targets = (callbacks?.atoms ?? []).filter(atom => atom.startsWith('callback:function:') || atom.startsWith('callback-once:function:'))
                .map(atom => atom.replace(/^callback(?:-once)?:function:/, ''));
              const payload = modelContract!.emits!.argumentParameters.map(parameter => {
                const input = argumentAt(parameter) ?? unknown();
                return input.definitions.some(definition => [...modeledTaintDefinitions].some(target => definition.includes(`call:${target}`)))
                  ? value([...input.atoms, 'tainted'], input.definitions, input.parameters) : input;
              });
              const actualPayloadStart = (eventPosition ?? 0) + 1;
              if (modelContract!.variadic) payload.push(...arguments_.slice(actualPayloadStart));
              const findings = [...new Set(targets)].flatMap(target => {
                const callbackSummary = options.summaries?.get(target);
                return (callbackSummary?.taintSinkParameters ?? []).flatMap(parameter => {
                  const input = payload[parameter];
                  const atoms = (input?.atoms ?? []).filter(atom => atom === 'tainted' || atom.startsWith('tainted:'));
                  return atoms.length ? [{ target, parameter, atoms, sourceDefinitions: input?.definitions ?? [] }] : [];
                });
              });
              if (callbacks?.atoms.some(atom => atom.startsWith('callback-once:function:'))) {
                const remaining = callbacks.atoms.filter(atom => !atom.startsWith('callback-once:function:'));
                if (remaining.length) state.set(cell, value(remaining, callbacks.definitions, callbacks.parameters));
                else state.delete(cell);
              }
              return findings;
            });
          }) : [];
        const callbackInvocationFindings = (summary?.callbackInvocations ?? []).flatMap(invocation => {
          const callbackPosition = invocation.callbackParameter === 'last' ? arguments_.length - 1
            : modelContract ? modelArgumentIndex(expr, modelContract, invocation.callbackParameter) : invocation.callbackParameter;
          const targets = (callbackPosition !== undefined && callbackPosition >= 0 ? arguments_[callbackPosition]?.atoms ?? [] : []).filter(atom => atom.startsWith('function:')).map(atom => atom.slice('function:'.length));
          return targets.flatMap(target => {
            const callbackSummary = options.summaries?.get(target);
            return (callbackSummary?.taintSinkParameters ?? []).flatMap(parameter => {
              const callbackArguments = [...invocation.argumentParameters.map(index => argumentAt(index) ?? unknown()),
                ...(invocation.variadicArgumentParameters?.map(index => argumentAt(index) ?? unknown()) ?? []),
                ...(invocation.variadicArgumentParameters || invocation.variadicArgumentFrom === undefined ? [] : arguments_.slice(invocation.variadicArgumentFrom))];
              const callbackSource = expr.model?.reference?.model ?? expr.target ?? 'external-callback';
              for (const position of invocation.taintArgumentPositions ?? []) {
                callbackArguments[position] = value([`tainted:${callbackSource}`], [`external:callback:${callbackSource}`]);
              }
              const input = callbackArguments[parameter];
              const atoms = (input?.atoms ?? []).filter(atom => atom === 'tainted' || atom.startsWith('tainted:'));
              return atoms.length ? [{ target, parameter, atoms, sourceDefinitions: input.definitions }] : [];
            });
          });
        });
        const taintFindings = (summary?.taintSinkParameters ?? []).flatMap(parameter => {
          const input = argumentAt(parameter);
          const atoms = (input?.atoms ?? []).filter(atom => atom === 'tainted' || atom.startsWith('tainted:'));
          return atoms.length ? [{ parameter, atoms, sourceDefinitions: input?.definitions ?? [] }] : [];
        });
        const allTaintFindings = [...taintFindings,
          ...callbackInvocationFindings.map(finding => ({ parameter: finding.parameter, atoms: finding.atoms, sourceDefinitions: finding.sourceDefinitions })),
          ...emittedCallbackFindings.map(finding => ({ parameter: finding.parameter, atoms: finding.atoms, sourceDefinitions: finding.sourceDefinitions }))];
        const taintParameterFlows = (summary?.taintSinkParameters ?? []).flatMap(parameter => {
          const sourceParameters = (argumentAt(parameter)?.parameters ?? []).filter(key => allParameters.includes(key));
          return sourceParameters.length ? [{ parameter, sourceParameters }] : [];
        });
        for (const finding of taintFindings) if (recording) result.taintFindings.push({ node: currentNode, target: expr.target, ...finding });
        for (const finding of callbackInvocationFindings) if (recording) result.taintFindings.push({ node: currentNode, target: finding.target, parameter: finding.parameter, atoms: finding.atoms, sourceDefinitions: finding.sourceDefinitions });
        for (const finding of emittedCallbackFindings) if (recording) result.taintFindings.push({ node: currentNode, target: finding.target, parameter: finding.parameter, atoms: finding.atoms, sourceDefinitions: finding.sourceDefinitions });
        const resourceIds = (contract && contract.action === 'acquire' && contract.identity === 'return') || summaryAcquires
          ? [`${graph.owner}:${currentNode}:${expr.target ?? 'unknown'}`]
          : contract && contract.action === 'release'
            ? (contract.identity === 'receiver' ? (receiverValue ?? unknown())
              : contract.identity === 'argument' && contract.parameter !== undefined ? (argumentAt(contract.parameter) ?? unknown()) : unknown()).atoms
                .filter(atom => atom.startsWith('resource:')).map(atom => atom.slice('resource:'.length))
            : summaryReleases ? resourceIdsFromValue(argumentAt(summaryReleases.parameter) ?? unknown())
            : summaryBorrowed ? resourceIdsFromValue(argumentAt(summaryBorrowed.parameter) ?? unknown())
            : [];
        if (receiverValue) {
          const closed = resourceIdsFromValue(receiverValue).filter(id => state.get(resourceCell(id))?.atoms.includes('resource-closed'));
          if (closed.length) resourceFinding({ kind: 'use-after-release', node: currentNode, ids: closed, certainty: 'definite', sourceNodes: resourceSourceNodes(closed) });
        }
        if ((contract?.action === 'acquire' && contract.identity === 'return') || summaryAcquires) {
          for (const id of resourceIds) resourceOriginNodes.set(id, currentNode);
          state.set(resourceCell(resourceIds[0]), value(['resource-open']));
          state.set(resourceEnterCell(resourceIds[0]), value([(contract?.enter ?? (summaryFresh ? summary?.returnsResource?.enter : undefined)) === 'same' ? 'resource-self' : 'resource-unknown']));
        } else if (contract?.action === 'release' || summaryReleases) {
          for (const id of resourceIds) {
            state.set(resourceCell(id), value(['resource-closed']));
            resourceReleaseNodes.set(id, currentNode);
          }
        }
        if (graph.language === 'rust' && summaryMoves.length) {
          for (const parameter of summaryMoves) {
            const actual = modelContract ? modelArgumentIndex(expr, modelContract, parameter) : parameter;
            const argument = actual === undefined ? undefined : expr.arguments[actual];
            const source = argument ? underlying(argument) : undefined;
            const argumentValue = argumentAt(parameter);
            const moveable = argumentValue?.atoms.some(atom => atom.startsWith('resource:')
              || atom.startsWith('object:') && !copyHeapObjects.has(atom.slice('object:'.length)));
            if (source?.kind === 'variable' && moveable) {
              state.set(variableCell(source.key), value(['moved'], [recordDefinition(variableCell(source.key), argumentValue!)]));
            }
          }
        }
        const resourceInfo = contract ? { action: contract.action, identity: contract.identity, ids: resourceIds }
          : summaryReleases ? { action: 'release' as const, identity: 'argument' as const, ids: resourceIds } : undefined;
        if (recording) result.calls.push({ node: currentNode, target: expr.target, arguments: arguments_, resolution: summary ? application?.status === 'applied' ? 'model' : 'summary' : 'unknown',
          ...(application ? { model: application } : {}),
          ...(callbackTargets.length ? { callbacks: callbackTargets } : {}),
          ...(allTaintFindings.length ? { taintFindings: allTaintFindings } : {}),
          ...(taintParameterFlows.length ? { taintParameterFlows } : {}),
          ...(resourceInfo ? { resource: resourceInfo } : {}) });
        if (recording && contract?.action === 'release') result.resourceEvents.push({ node: currentNode, action: 'release', identity: contract.identity,
          ids: resourceIds, proven: resourceIds.length > 0 });
        else if (recording && summaryReleases) result.resourceEvents.push({ node: currentNode, action: 'release', identity: 'argument',
          ids: resourceIds, proven: resourceIds.length > 0 });
        else if (recording && (contract?.action === 'acquire' || summaryAcquires)) result.resourceEvents.push({ node: currentNode, action: 'acquire', identity: 'return',
          ids: resourceIds, proven: true });
        if (!summary) {
          const result = unknown([evaluate(expr.callee, state), ...arguments_]);
          // unknown 호출은 closure/heap을 통해 명시적 인자 밖의 입력도 읽을 수 있다.
          return value(result.atoms, [recordDefinition(`call:${expr.target ?? 'unknown'}`, result)], [...result.parameters, ...allParameters]);
        }
        const sources = summary.parameters.filter(p => summary.returnParameters.includes(p.key)).map(p => argumentAt(p.index))
          .filter((source): source is AbstractValue => !!source);
        const acquiredAtom = ((contract?.action === 'acquire' && contract.identity === 'return') || summaryAcquires) ? resourceAtom(resourceIds[0]) : undefined;
        const borrowedAtoms = summaryBorrowed ? resourceIdsFromValue(argumentAt(summaryBorrowed.parameter) ?? unknown()).map(resourceAtom) : [];
        const aliasAtoms = summaryParameter !== undefined ? (argumentAt(summaryParameter) ?? unknown()).atoms
          .filter(atom => !atom.startsWith('parameter:') && !atom.startsWith('resource-param:')) : [];
        const returnedAtoms = summaryParameter !== undefined ? []
          : summaryAcquires ? summary.returnAtoms.filter(atom => !atom.startsWith('resource:'))
            : summaryBorrowed ? summary.returnAtoms.filter(atom => !atom.startsWith('resource-param:')) : summary.returnAtoms;
        const propagatedTaint = taintReturnParameters.flatMap(parameter => taintSanitizesParameters.has(parameter) ? []
          : (argumentAt(parameter)?.atoms ?? []).filter(atom => atom === 'tainted' || atom.startsWith('tainted:')));
        if (taintReturnVariadic) {
          const variadicStart = modelContract?.parameters.length ?? summary.parameters.length;
          propagatedTaint.push(...arguments_.slice(variadicStart).flatMap(argument =>
            argument.atoms.filter(atom => atom === 'tainted' || atom.startsWith('tainted:'))));
        }
        const modeledTaintSource = modelContract?.taint?.source ? ['tainted'] : [];
        const source = value([...returnedAtoms, ...propagatedTaint, ...modeledTaintSource, ...(acquiredAtom ? [acquiredAtom] : []), ...borrowedAtoms, ...aliasAtoms],
          sources.flatMap(v => v.definitions), [...sources.flatMap(v => v.parameters), ...summary.effects.unknown ? allParameters : []]);
        const definition = `call:${expr.target}`;
        if (modelContract?.taint?.source && expr.target) modeledTaintDefinitions.add(expr.target);
        return value(source.atoms, [recordDefinition(definition, source)], source.parameters);
      }
      case 'unary': {
        const source = evaluate(expr.value, state);
        if (expr.operator === 'borrow') return source;
        if (expr.operator === 'nullish' || expr.operator === 'undefined') {
          return value([...source.atoms.flatMap(atom => atom === 'uninitialized' ? ['boolean:true', 'boolean:false']
            : [scalarAtom(expr.operator === 'nullish' ? ['null', 'undefined'].includes(atom) : atom === 'undefined')]),
          ...(expr.operator === 'nullish' ? taintAtoms([source]) : [])], source.definitions, source.parameters);
        }
        if (['!', 'not'].includes(expr.operator)) return value(truth(source).map(v => scalarAtom(!v)), source.definitions, source.parameters);
        return unknown([source]);
      }
      case 'binary': {
        const left = evaluate(expr.left, state), right = evaluate(expr.right, state);
        const abstractResult = () => {
          const sources = [left, right], defs = sources.flatMap(v => v.definitions), params = sources.flatMap(v => v.parameters);
          if (['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'is', 'is not'].includes(expr.operator)) return value(['*boolean'], defs, params);
          if (['+', '-', '*', '/', '%'].includes(expr.operator) && sources.every(v => v.atoms.every(atom => atomType(atom) === 'number')))
            return value(['*number', ...taintAtoms(sources)], defs, params);
          return unknown(sources);
        };
        if (graph.language === 'rust' && ['+', '-', '*', '/', '%'].includes(expr.operator)) return abstractResult();
        const atoms: string[] = [];
        for (const a of left.atoms) for (const b of right.atoms) {
          if (!isConcrete(a) || !isConcrete(b)) return abstractResult();
          const l = concrete(a), r = concrete(b);
          let computed: string | number | boolean | undefined;
          switch (expr.operator) {
            case '===': computed = l === r; break;
            case '!==': computed = l !== r; break;
            case 'is': case 'is not':
              if (!((l === null || typeof l === 'boolean') && (r === null || typeof r === 'boolean'))) return abstractResult();
              computed = expr.operator === 'is' ? l === r : l !== r; break;
            case '==': case '!=': {
              // JS loose equality is exact here only for equal primitive types or null/undefined.
              if (graph.language === 'typescript' && typeof l !== typeof r && !(l == null && r == null)) return abstractResult();
              computed = l === r || (graph.language === 'typescript' && l == null && r == null);
              if (graph.language === 'python' && ['number', 'boolean'].includes(typeof l) && ['number', 'boolean'].includes(typeof r)) computed = Number(l) === Number(r);
              if (expr.operator === '!=') computed = !computed;
              break;
            }
            case '+': if (typeof l === 'number' && typeof r === 'number') computed = l + r;
              else if (typeof l === 'string' && typeof r === 'string') computed = l + r;
              else return abstractResult(); break;
            case '-': case '*': case '/': case '%': case '<': case '>': case '<=': case '>=':
              if (typeof l !== 'number' || typeof r !== 'number' || ((expr.operator === '/' || expr.operator === '%') && r === 0)) return abstractResult();
              computed = expr.operator === '-' ? l - r : expr.operator === '*' ? l * r : expr.operator === '/' ? l / r : expr.operator === '%' ? graph.language === 'python' ? ((l % r) + r) % r : l % r
                : expr.operator === '<' ? l < r : expr.operator === '>' ? l > r : expr.operator === '<=' ? l <= r : l >= r; break;
            default: return abstractResult();
          }
          if (typeof computed === 'number' && !Number.isFinite(computed)) return abstractResult();
          if (graph.language === 'python' && typeof computed === 'number' && Number.isInteger(computed) && !Number.isSafeInteger(computed)) return abstractResult();
          atoms.push(scalarAtom(computed!));
          if (['+', '-', '*', '/', '%'].includes(expr.operator)) atoms.push(...taintAtoms([left, right]));
        }
        return value(atoms, [...left.definitions, ...right.definitions], [...left.parameters, ...right.parameters]);
      }
    }
  }
  function modelArgumentIndex(expr: Extract<DataExpr, { kind: 'call' }>, contract: NonNullable<ModelSelection['contract']>, parameter: number): number | undefined {
    if (!contract.parameterNames?.length || !expr.keywordArguments?.some(Boolean)) return parameter < expr.arguments.length ? parameter : undefined;
    const assigned = new Map<number, number>(), used = new Set<number>();
    let nextPositional = 0;
    for (let actual = 0; actual < expr.arguments.length; actual++) {
      const named = expr.keywordArguments?.[actual] ? expr.argumentNames?.[actual] : undefined;
      let target: number | undefined;
      if (named) {
        const namedIndex = contract.parameterNames.indexOf(named);
        if (namedIndex >= 0) target = namedIndex;
      } else {
        while (used.has(nextPositional)) nextPositional++;
        if (nextPositional < contract.parameters.length) target = nextPositional++;
      }
      if (target !== undefined && !used.has(target)) { assigned.set(target, actual); used.add(target); }
    }
    return assigned.get(parameter);
  }
  function modelApplication(expr: DataExpr, state: State): ModelApplication | undefined {
    if (expr.kind !== 'call' || !expr.model) return undefined;
    const { status, reference, contract } = expr.model;
    if (status !== 'candidate' || !contract) return { status, ...(reference ? { reference } : {}) };
    const optionalParameters = contract.optionalParameters ?? [];
    const requiredCount = contract.parameters.length - optionalParameters.length;
    if (expr.argumentsKnown === false || expr.arguments.length < requiredCount
      || !contract.variadic && expr.arguments.length > contract.parameters.length) return { status: 'argument-mapping', reference };
    const callee = evaluate(expr.callee, state);
    const exactCallable = callee.atoms.length === 1 && callee.atoms[0] === `function:${expr.target}`;
    // Symbol resolution has already proven an external module identity for
    // typed receivers (for example EventEmitter parameters). Their runtime
    // callable atom is not materialized by the local value lattice, so use
    // that resolver proof without weakening local-shadowing checks.
    if (!exactCallable && !(expr.external && expr.callee.kind === 'member')) return { status: 'callee-not-proven', reference };
    const valid = contract.parameters.every((domain, i) => {
      if (domain === 'any') return true;
      const actual = modelArgumentIndex(expr, contract, i);
      if (actual === undefined) return optionalParameters.includes(i);
      // Taint labels are orthogonal metadata, not runtime value types. A
      // modeled sanitizer must still apply to a tainted string/number.
      const atoms = evaluate(expr.arguments[actual], state).atoms.filter(atom => atom !== 'tainted' && !atom.startsWith('tainted:'));
      return atoms.length > 0 && atoms.every(atom => domain === 'primitive'
        ? ['string', 'number', 'boolean', 'null', 'undefined', 'unit'].includes(atomType(atom)) : atomType(atom) === domain);
    });
    return { status: valid ? 'applied' : 'argument-domain', reference };
  }
  function suppressionOutcome(node: CfgNode, state: State): 'never' | 'always' | undefined {
    if (!node.resourceSource || !node.text.includes('suppresses exception')) return undefined;
    const key = `${node.resourceSource.startOffset}:${node.resourceSource.endOffset}`;
    const managerEntry = Object.entries(graph.dataflow?.effects ?? {}).find(([, effect]) => effect.resultKey === key);
    const manager = managerEntry?.[1].value;
    if (!manager || manager.kind !== 'call' || !manager.model?.contract?.resource) return undefined;
    // The manager call may have been followed by __exit__'s unknown protocol,
    // which can havoc the imported callable binding. The resource-self marker
    // is the stronger proof that the earlier model application succeeded.
    const managerPrefix = `${graph.owner}:${managerEntry![0]}:`;
    const hasModeledResource = [...state].some(([cell, value]) => cell.startsWith(`resource-enter:${managerPrefix}`)
      && value.atoms.some(atom => atom === 'resource-self' || atom === 'resource-unknown'));
    if (!hasModeledResource) return undefined;
    const suppress = manager.model.contract.resource.suppress;
    if (suppress === 'never' || suppress === 'always') return suppress;
    if (suppress !== 'possible' || manager.kind !== 'call' || !manager.argumentNames?.length) return undefined;
    const pending = state.get('pending:exception');
    if (!pending) return undefined;
    const types = pending.atoms.filter(atom => atom.startsWith('exception:')).map(atom => atom.slice('exception:'.length));
    const expected = manager.argumentNames.filter((name): name is string => !!name);
    if (!types.length || types.includes('*') || !expected.length) return undefined;
    const matches = types.flatMap(type => expected.map(candidate => pythonExceptionMatches(type, candidate, localExceptionParents)));
    return matches.length > 0 && matches.every(match => match === true) ? 'always'
      : matches.length > 0 && matches.every(match => match === false) ? 'never' : undefined;
  }
  function applicableSummary(expr: DataExpr, state: State): FunctionSummary | undefined {
    if (expr.kind === 'call' && expr.model?.contract && modelApplication(expr, state)?.status === 'applied') return modelSummary(expr.target!, expr.model.contract);
    const summary = applicableCallSummary(expr, options.summaries);
    if (!summary || expr.kind !== 'call') return undefined;
    const callee = evaluate(expr.callee, state);
    return callee.atoms.length === 1 && callee.atoms[0] === `function:${summary.owner}` ? summary : undefined;
  }
  function truth(input: AbstractValue): boolean[] {
    const outcomes = new Set<boolean>();
    for (const atom of input.atoms) {
      if (isConcrete(atom)) outcomes.add(Boolean(concrete(atom)));
      else if (graph.language === 'typescript' && (atom.startsWith('object:') || atom.startsWith('function:') || ['*object', '*function'].includes(atom))) outcomes.add(true);
      else { outcomes.add(true); outcomes.add(false); }
    }
    return [...outcomes];
  }
  function havoc(state: State, mutateLocals = false, preserveExternalCallables = false): void {
    for (const [cell, old] of state) {
      const variable = cell.startsWith('var:') ? variables.get(cell.slice(4)) : undefined;
      // The library-model catalog is selected under the
      // `unmodified-external-bindings` assumption. Preserve proven external
      // callable identities across an effectful call so a second call to the
      // same imported function is not downgraded to callee-not-proven.
      if (preserveExternalCallables && variable?.category === 'external'
        && old.atoms.some(atom => atom.startsWith('function:external:'))) continue;
      // Registration APIs retain local callback identity across their own
      // effectful call. The callback may be captured in the enclosing scope,
      // but passing it to an external API does not reassign the local binding.
      if (preserveExternalCallables && variable?.captured
        && old.atoms.some(atom => atom.startsWith('function:'))) continue;
      if (cell.startsWith('heap:') || variable?.captured || variable?.category === 'external' || (mutateLocals && variable)) {
        state.set(cell, value(unknownAtoms, [recordDefinition(cell, old)], [...old.parameters, ...allParameters]));
      }
      if (cell.startsWith('shape:')) state.set(cell, value(['*boolean']));
      if (cell.startsWith('resource-state:')) state.set(cell, value(['resource-open', 'resource-closed']));
    }
  }
  function knownDataProperty(object: DataExpr, property: string, state: State): boolean {
    const atoms = evaluate(object, state).atoms;
    if (property === '*') return false;
    const concrete = atoms.length > 0 && atoms.every(atom => atom.startsWith('object:')
      && state.get(`shape:${fieldCell(atom.slice(7), property)}`)?.atoms.join(',') === 'boolean:true');
    if (concrete) return true;
    // A stable parameter definition is a symbolic receiver identity. This
    // permits `obj.x = value; return obj.x` without claiming that arbitrary
    // computed properties or unrelated unknown objects alias.
    return !atoms.some(atom => atom.startsWith('object:')) && evaluate(object, state).definitions.length > 0;
  }
  function transfer(input: State, effect: NodeEffect | undefined, exceptional = false): State {
    const state = new Map(input);
    if (exceptional || ['throw', 'break', 'continue'].includes(graph.nodes[currentNode].kind)) state.delete('pending:return');
    if (!effect) return state;
    const evaluated = exceptional ? undefined : evaluate(effect.value, state);
    let writes = exceptional ? [] : effect.writes.map(write => ({ target: write.target, value: evaluate(write.value, state), cells: getLocation(write.target, state),
      uncertainSetter: write.target.kind === 'member' && !knownDataProperty(write.target.object, write.target.property, state) }));
    if (!exceptional && graph.nodes[currentNode].binding === 'resource-enter' && evaluated) {
      const sameIds = resourceIdsFromValue(evaluated).filter(id => state.get(resourceEnterCell(id))?.atoms.includes('resource-self'));
      if (sameIds.length) {
        modeledResourceEntries.add(currentNode);
        const source = graph.nodes[currentNode].resourceSource;
        if (source) modeledResourceSources.add(`${source.startOffset}:${source.endOffset}`);
      }
      if (sameIds.length) writes = writes.map(write => write.target.kind === 'variable'
        ? { ...write, value: value(sameIds.map(resourceAtom)) } : write);
    }
    const uncertainGetter = effect.value.kind === 'member' && !knownDataProperty(effect.value.object, effect.value.property, state);
    const uncertainSetter = effect.writes.some(write => write.target.kind === 'member' && !knownDataProperty(write.target.object, write.target.property, state));
    const summary = applicableSummary(effect.value, input);
    const knownCallEffects = !!summary && (summary.effects.heap || summary.effects.bindings.length > 0 || summary.effects.unknown);
    const allocationEffect = effect.value.kind === 'allocation';
    const unknownCallEffects = !allocationEffect && (effect.mayCall && (!summary || summary.effects.unknown) || effect.mayMutateLocals);
    // 동적 연산자와 truth protocol도 사용자 코드를 실행할 수 있다.
    const mayHaveProtocol = (expression: DataExpr) => evaluate(expression, new Map(input)).atoms.some(atom => ['object', 'function'].includes(atomType(atom)));
    const operation = effect.value;
    const uncertainOperator = operation.kind === 'binary' && !['===', '!==', 'is', 'is not'].includes(operation.operator)
      && (mayHaveProtocol(operation.left) || mayHaveProtocol(operation.right))
      || operation.kind === 'unary' && !['nullish', 'undefined'].includes(operation.operator)
        && !(graph.language === 'typescript' && operation.operator === '!') && mayHaveProtocol(operation.value)
      || graph.language === 'python' && !!effect.guard && mayHaveProtocol(effect.guard);
    const uncertainFormatting = operation.kind === 'non-null' && operation.type === 'string' && operation.sources?.some(mayHaveProtocol);
        if (unknownCallEffects || knownCallEffects || uncertainGetter || uncertainSetter || uncertainOperator || uncertainFormatting) {
      if (recording && (unknownCallEffects || uncertainGetter || uncertainSetter || uncertainOperator || uncertainFormatting)) unknownEffects.add(currentNode);
      const preserveExternalCallables = effect.value.kind === 'call' && !!effect.value.model
        && effect.value.model.status === 'candidate' && !!summary;
          havoc(state, effect.mayMutateLocals, preserveExternalCallables);
        }
    if (exceptional) {
      const arguments_ = summary && effect.value.kind === 'call' ? effect.value.arguments : undefined;
      const sources = summary && arguments_ ? summary.parameters.filter(p => summary.throwParameters.includes(p.key))
        .map(p => arguments_[p.index] ? evaluate(arguments_[p.index], new Map(input)) : unknown()) : [evaluate(effect.value, new Map(input))];
      state.set('pending:exception', unknown(sources));
      return state;
    }
    if (evaluated) state.set(temporaryCell(effect.resultKey), evaluated);
    if (evaluated && graph.nodes[currentNode].kind === 'return') state.set('pending:return', evaluated);
    if (evaluated && graph.nodes[currentNode].kind === 'throw') state.set('pending:exception', evaluated);
    if (evaluated && graph.nodes[currentNode].kind === 'cleanup' && effect.value.kind === 'temporary') {
      const ids = resourceIdsFromValue(evaluated);
      for (const id of ids) state.set(resourceCell(id), value(['resource-closed']));
      for (const id of ids) resourceReleaseNodes.set(id, currentNode);
      if (recording && ids.length) result.resourceEvents.push({ node: currentNode, action: 'release', identity: 'receiver', ids, proven: true });
    }
    for (const write of writes) for (const cell of write.cells) {
      const source = write.uncertainSetter ? unknown([write.value]) : write.value;
      const next = value(source.atoms, [recordDefinition(cell, source)], source.parameters);
      const old = state.get(cell);
      const strong = write.target.kind === 'variable' || (write.cells.length === 1 && write.target.property !== '*' && !repeatedAllocation && !write.uncertainSetter);
      state.set(cell, !strong && old ? mergeValue(old, next) : next);
    }
    // Rust ownership: move only values whose abstract identity proves a heap
    // object or resource. Primitive values are Copy; unknown scalar types stay
    // conservative and do not become fabricated move findings.
    if (graph.language === 'rust' && !exceptional && evaluated) {
      const source = underlying(effect.value);
      const borrowed = source.kind === 'unary' && source.operator === 'borrow';
      const borrowedSource = borrowed ? underlying(source.value) : undefined;
      const consumed = !effect.borrowedPattern && (writes.length > 0 || ['return', 'throw'].includes(graph.nodes[currentNode].kind) || effect.value.kind === 'call');
      const variableInfo = source.kind === 'variable' ? variables.get(source.key) : undefined;
      const rustType = variableInfo?.typeName?.replace(/\s+/g, '');
      const primitiveRustType = !!rustType && /^(bool|char|f(?:32|64)|i(?:8|16|32|64|size)|u(?:8|16|32|64|size)|isize|usize)$/.test(rustType);
      const referenceRustType = !!rustType && (rustType.startsWith('&') || rustType.startsWith('*'));
      const typedRustParameter = graph.language === 'rust' && variableInfo?.category === 'parameter'
        && !!variableInfo.typeName && !variableInfo.copy && !primitiveRustType && !referenceRustType;
      const moveable = typedRustParameter || evaluated.atoms.some(atom => atom.startsWith('resource:')
        || atom.startsWith('object:') && !copyHeapObjects.has(atom.slice('object:'.length)));
      if (consumed && source.kind === 'variable' && !borrowed && moveable) {
        state.set(variableCell(source.key), value(['moved'], [recordDefinition(variableCell(source.key), evaluated)]));
        const parameter = graph.dataflow?.parameters?.find(p => p.key === source.key)?.index;
        if (parameter !== undefined && !result.movedParameters.includes(parameter)) result.movedParameters.push(parameter);
      }
      if (borrowed && borrowedSource?.kind === 'variable') {
        const parameter = graph.dataflow?.parameters?.find(p => p.key === borrowedSource.key)?.index;
        if (parameter !== undefined && !result.borrowedParameters.includes(parameter)) result.borrowedParameters.push(parameter);
      }
    }
    for (const key of effect.deletes) {
      const cell = variableCell(key);
      state.set(cell, value(['uninitialized'], [recordDefinition(cell, value(['uninitialized']))]));
    }
    return state;
  }
  const producers = new Map<string, DataExpr[]>();
  for (const [node, effect] of Object.entries(facts.effects)) {
    if (graph.nodes[Number(node)].kind === 'condition') continue;
    producers.set(effect.resultKey, [...producers.get(effect.resultKey) ?? [], effect.value]);
  }
  function underlying(expression: DataExpr, seen = new Set<string>()): DataExpr {
    if (expression.kind !== 'temporary' || seen.has(expression.key)) return expression;
    const choices = producers.get(expression.key) ?? [];
    if (!choices.length || choices.some(choice => JSON.stringify(choice) !== JSON.stringify(choices[0]))) return expression;
    return underlying(choices[0], new Set(seen).add(expression.key));
  }
  function refine(expression: DataExpr, expected: boolean, input: State): State | undefined {
    const expr = underlying(expression);
    if (expr.kind === 'unary' && ['!', 'not'].includes(expr.operator)) return refine(expr.value, !expected, input);
    let target: DataExpr | undefined;
    let accepts: ((atom: string) => boolean) | undefined;
    if (expr.kind === 'unary' && ['nullish', 'undefined'].includes(expr.operator)) {
      target = underlying(expr.value);
      accepts = atom => atom === 'uninitialized' || (expr.operator === 'nullish' ? ['undefined', 'null'].includes(atom) : atom === 'undefined') === expected;
    } else if (expr.kind === 'binary' && ['===', '!==', '==', '!=', 'is', 'is not'].includes(expr.operator)) {
      const left = underlying(expr.left), right = underlying(expr.right);
      const literal = left.kind === 'null' || left.kind === 'undefined' ? left : right.kind === 'null' || right.kind === 'undefined' ? right : undefined;
      if (literal) {
        target = literal === left ? right : left;
        const equals = ['===', '==', 'is'].includes(expr.operator) === expected;
        const looseNull = graph.language === 'typescript' && ['==', '!='].includes(expr.operator);
        accepts = atom => atom === 'uninitialized' || (looseNull ? ['null', 'undefined'].includes(atom) : atom === literal.kind) === equals;
      }
    } else if (expr.kind === 'binary' && ['<', '>', '<=', '>='].includes(expr.operator)) {
      const left = underlying(expr.left), right = underlying(expr.right);
      if (left.kind === 'variable' && right.kind === 'literal' && typeof right.value === 'number') {
        target = left;
        const boundary = right.value;
        accepts = atom => {
          if (!atom.startsWith('number:')) return true;
          const n = concrete(atom) as number;
          return (expr.operator === '<' ? n < boundary : expr.operator === '>' ? n > boundary : expr.operator === '<=' ? n <= boundary : n >= boundary) === expected;
        };
      }
    } else if (expr.kind === 'variable') {
      target = expr; accepts = atom => truth(value([atom])).includes(expected);
    }
    if (target?.kind !== 'variable' || !accepts) return input;
    const old = input.get(variableCell(target.key));
    if (!old) return input;
    // A previously evaluated temporary must not constrain a reassigned variable.
    const tested = evaluate(expression, new Map(input));
    if (tested.definitions.length && old.definitions.some(id => !tested.definitions.includes(id))) return input;
    const atoms = old.atoms.filter(accepts);
    if (!atoms.length) return undefined;
    const alternatives = old.alternatives.map(choice => ({ ...choice, atoms: choice.atoms.filter(accepts!) })).filter(choice => choice.atoms.length);
    const filtered = value(atoms, alternatives.map(choice => choice.definition), alternatives.length ? alternatives.flatMap(choice => choice.parameters) : old.parameters, alternatives);
    const state = new Map(input); state.set(variableCell(target.key), filtered); return state;
  }
  const initial: State = new Map();
  recording = true;
  for (const variable of facts.variables) {
    const source = evaluate(variable.initial, initial), cell = variableCell(variable.key);
    const parameterAtoms = variable.category === 'parameter' ? [`parameter:${variable.key}`, `resource-param:${variable.key}`] : [];
    initial.set(cell, value([...source.atoms, ...parameterAtoms], [recordDefinition(cell, source)], variable.category === 'parameter' ? [variable.key] : source.parameters));
  }
  recording = false;
  const inputs = new Map<number, State>([[graph.entry, initial]]);
  const queue = [graph.entry], queued = new Set(queue);
  let cursor = 0, storedCells = initial.size, stateExhausted = false;
  while (cursor < queue.length && result.iterations < budget && result.workUnits < workBudget) {
    currentNode = queue[cursor++]; queued.delete(currentNode); result.iterations++;
    const input = inputs.get(currentNode)!;
    result.workUnits += [...input.values()].reduce((sum, value) => sum + 1 + value.atoms.length + value.alternatives.length, 0);
    const effect = facts.effects[currentNode];
    const normal = transfer(input, effect);
    let exception: State | undefined;
    for (const edge of outgoing.get(currentNode) ?? []) {
      if (edge.kind === 'exception' && effect && applicableSummary(effect.value, input)?.mayThrow === false) continue;
      if (!['exception', 'throw'].includes(edge.kind) && effect && applicableSummary(effect.value, input)?.mayReturn === false) continue;
      const suppression = suppressionOutcome(graph.nodes[currentNode], input);
      if (suppression === 'never' && edge.kind === 'true') continue;
      if (suppression === 'always' && edge.kind === 'false') continue;
      if ((edge.kind === 'true' || edge.kind === 'false') && effect?.guard && !truth(evaluate(effect.guard, new Map(input))).includes(edge.kind === 'true')) continue;
      let propagated: State | undefined = edge.kind === 'suspend' ? input : edge.kind === 'exception' ? (exception ??= transfer(input, effect, true)) : normal;
      if ((edge.kind === 'true' || edge.kind === 'false') && effect?.guard) propagated = refine(effect.guard, edge.kind === 'true', propagated);
      if (!propagated) continue;
      // 종료 노드는 도달 여부만 필요하다. 반환값은 원래 edge의 source에서
      // 수집하므로 모든 throw/call의 heap을 terminal 하나에 합칠 필요가 없다.
      propagated = [graph.exit, graph.exceptionExit, graph.suspensionExit].includes(edge.to) ? new Map()
        : new Map([...propagated].filter(([key]) => (!key.startsWith('temp:') && !key.startsWith('var:')) || liveTemporaries[edge.to].has(key)));
      const joined = joinState(inputs.get(edge.to), propagated);
      if (joined.changed) {
        const nextSize = storedCells - (inputs.get(edge.to)?.size ?? 0) + joined.state.size;
        if (nextSize > stateBudget) { stateExhausted = true; break; }
        storedCells = nextSize;
        inputs.set(edge.to, joined.state);
        if (!queued.has(edge.to)) { queue.push(edge.to); queued.add(edge.to); }
      }
    }
    if (stateExhausted) break;
  }
  if (result.workUnits >= workBudget) {
    result.completeness = 'partial'; result.diagnostics.push({ code: 'work-budget', message: `Dataflow exceeded ${workBudget} abstract value work units` });
  } else if (stateExhausted) {
    result.completeness = 'partial'; result.diagnostics.push({ code: 'state-budget', message: `Dataflow exceeded ${stateBudget} stored abstract cells` });
  } else if (cursor < queue.length) {
    result.completeness = 'partial'; result.diagnostics.push({ code: 'iteration-budget', message: `Dataflow exceeded ${budget} node transfers` });
  }
  result.reachableNodes = [...inputs.keys()].sort((a, b) => a - b);
  recording = true;
  for (const [node, input] of inputs) {
    currentNode = node;
    const effect = facts.effects[node];
    transfer(input, effect);
    for (const edge of outgoing.get(node) ?? []) {
      if (edge.kind === 'exception' && effect && applicableSummary(effect.value, input)?.mayThrow === false) continue;
      const suppression = suppressionOutcome(graph.nodes[node], input);
      if (suppression === 'never' && edge.kind === 'true') continue;
      if (suppression === 'always' && edge.kind === 'false') continue;
      if (edge.to === graph.exceptionExit) {
        const thrown = transfer(input, effect, edge.kind === 'exception');
        for (const [cell, status] of thrown) if (cell.startsWith('resource-state:') && status.atoms.includes('resource-open')) {
          const id = cell.slice('resource-state:'.length);
          resourceFinding({ kind: 'leak', node, ids: [id], certainty: status.atoms.includes('resource-closed') ? 'possible' : 'definite', sourceNodes: resourceSourceNodes([id]) });
        }
        result.throws.push({ node, value: thrown.get('pending:exception') ?? unknown() });
      }
      if (edge.to !== graph.exit) continue;
      if (effect && applicableSummary(effect.value, input)?.mayReturn === false) continue;
      if ((edge.kind === 'true' || edge.kind === 'false') && effect?.guard && !truth(evaluate(effect.guard, new Map(input))).includes(edge.kind === 'true')) continue;
      const output = transfer(input, effect);
      const returned = output.get('pending:return') ?? (graph.implicitReturnSource ? output.get(temporaryCell(`${graph.implicitReturnSource.startOffset}:${graph.implicitReturnSource.endOffset}`)) ?? unknown()
        : value([graph.language === 'python' ? 'null' : graph.language === 'rust' ? 'unit' : 'undefined']));
      const returnValue = graph.nodes[node].text === 'Try::branch' ? unknown() : returned;
      for (const [cell, status] of output) if (cell.startsWith('resource-state:') && status.atoms.includes('resource-open')) {
        const id = cell.slice('resource-state:'.length);
        if (returnValue.atoms.includes(resourceAtom(id))) continue; // ownership is transferred to the caller
        resourceFinding({ kind: 'leak', node, ids: [id], certainty: status.atoms.includes('resource-closed') ? 'possible' : 'definite', sourceNodes: resourceSourceNodes([id]) });
      }
      result.returns.push({ node, value: returnValue });
    }
  }
  result.definitions = [...definitions.values()].sort((a, b) => a.node - b.node || a.location.localeCompare(b.location));
  const uses = new Map<string, FlowUse>();
  for (const use of result.uses) {
    const key = `${use.node}:${use.variable}`;
    const existing = uses.get(key);
    uses.set(key, existing ? { ...use, definitions: unique([...existing.definitions, ...use.definitions]),
      mayBeUninitialized: existing.mayBeUninitialized || use.mayBeUninitialized,
      mayBeMoved: existing.mayBeMoved || use.mayBeMoved, value: mergeValue(existing.value, use.value) } : use);
  }
  result.uses = [...uses.values()].sort((a, b) => a.node - b.node || a.variable.localeCompare(b.variable));
  result.unknownEffects = [...unknownEffects].sort((a, b) => a - b);
  const calls = new Map<number, FlowCall>();
  for (const call of result.calls) {
    const existing = calls.get(call.node);
    calls.set(call.node, existing ? { ...call, arguments: call.arguments.map((argument, i) => mergeValue(existing.arguments[i], argument)),
      ...(existing.taintFindings || call.taintFindings ? { taintFindings: [...new Map([...(existing.taintFindings ?? []), ...(call.taintFindings ?? [])].map(finding => [`${finding.parameter}:${finding.atoms.join(',')}:${finding.sourceDefinitions?.join(',') ?? ''}`, finding])).values()] } : {}),
      ...(existing.taintParameterFlows || call.taintParameterFlows ? { taintParameterFlows: [...new Map([...(existing.taintParameterFlows ?? []), ...(call.taintParameterFlows ?? [])].map(flow => [`${flow.parameter}:${flow.sourceParameters.join(',')}`, flow])).values()] } : {}) } : call);
  }
  result.calls = [...calls.values()].sort((a, b) => a.node - b.node);
  const taints = new Map<string, DataflowResult['taintFindings'][number]>();
  for (const finding of result.taintFindings) taints.set(`${finding.node}:${finding.target ?? ''}:${finding.parameter}:${finding.atoms.join(',')}:${finding.sourceDefinitions?.join(',') ?? ''}`, finding);
  result.taintFindings = [...taints.values()].sort((a, b) => a.node - b.node || a.parameter - b.parameter);
  const events = new Map<string, ResourceEvent>();
  for (const event of result.resourceEvents) events.set(`${event.node}:${event.action}:${event.identity}:${event.ids.join(',')}`, event);
  result.resourceEvents = [...events.values()].sort((a, b) => a.node - b.node || a.action.localeCompare(b.action));
  const findings = new Map<string, ResourceFinding>();
  for (const finding of result.resourceFindings) findings.set(`${finding.kind}:${finding.node}:${finding.certainty}:${finding.ids.join(',')}:${finding.sourceNodes?.join(',') ?? ''}`, finding);
  result.resourceFindings = [...findings.values()].sort((a, b) => a.node - b.node || a.kind.localeCompare(b.kind));
  const ownership = new Map<string, OwnershipFinding>();
  for (const finding of result.ownershipFindings) ownership.set(`${finding.kind}:${finding.node}:${finding.variable}:${finding.certainty}:${finding.definitions.join(',')}`, finding);
  result.ownershipFindings = [...ownership.values()].sort((a, b) => a.node - b.node || a.variable.localeCompare(b.variable));
  if (modeledResourceEntries.size) {
    result.diagnostics = result.diagnostics.filter(diagnostic =>
      (!modeledResourceEntries.has(diagnostic.node ?? -1)
        && !modeledResourceSources.has((diagnostic.node === undefined ? undefined : graph.nodes[diagnostic.node]?.resourceSource)
          ? `${graph.nodes[diagnostic.node!]!.resourceSource!.startOffset}:${graph.nodes[diagnostic.node!]!.resourceSource!.endOffset}` : ''))
      || !diagnostic.message.includes('Context-manager return value and ownership lifecycle are not modeled'));
    if (!result.diagnostics.length && graph.completeness === 'complete') result.completeness = 'complete';
  }
  return result;
}
