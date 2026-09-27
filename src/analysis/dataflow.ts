import type { ControlFlowGraph } from './cfg.js';
import type { DataExpr, DataflowDiagnostic, FlowLocation, NodeEffect } from './dataflowTypes.js';
import type { FunctionSummary } from './summaryTypes.js';
import { modelSummary, type ModelApplication } from './libraryModels.js';

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
  value: AbstractValue;
}
export interface FlowCall {
  node: number;
  target?: string;
  arguments: AbstractValue[];
  resolution: 'summary' | 'model' | 'unknown';
  model?: ModelApplication;
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
  reachableNodes: number[];
}
type State = Map<string, AbstractValue>;
const unknownAtoms = ['undefined', 'null', '*boolean', '*number', '*string', '*object', '*function', 'unit'];
const unique = (values: string[]) => [...new Set(values)].sort();
const atomType = (atom: string) => atom.startsWith('*') ? atom.slice(1) : atom.split(':')[0];
function normalizeAtoms(atoms: string[]): string[] {
  let normalized = unique(atoms);
  for (const type of ['number', 'string', 'boolean', 'object', 'function']) {
    const group = normalized.filter(atom => atomType(atom) === type);
    if (group.includes(`*${type}`) || group.length > (type === 'object' || type === 'function' ? 32 : 8)) {
      normalized = [...normalized.filter(atom => atomType(atom) !== type), `*${type}`];
    }
  }
  return normalized.sort();
}
function value(atoms: string[], definitions: string[] = [], parameters: string[] = [], alternatives?: AbstractValue['alternatives']): AbstractValue {
  const normalized = normalizeAtoms(atoms);
  const grouped = new Map<string, { atoms: string[]; parameters: string[] }>();
  for (const alternative of alternatives ?? unique(definitions).map(definition => ({ definition, atoms: normalized, parameters }))) {
    const old = grouped.get(alternative.definition);
    grouped.set(alternative.definition, { atoms: normalizeAtoms([...old?.atoms ?? [], ...alternative.atoms]), parameters: unique([...old?.parameters ?? [], ...alternative.parameters]) });
  }
  return { atoms: normalized, definitions: unique(definitions), parameters: unique(parameters),
    alternatives: [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([definition, choice]) => ({ definition, ...choice })) };
}
const unknown = (sources: AbstractValue[] = []) => value(unknownAtoms, sources.flatMap(v => v.definitions), sources.flatMap(v => v.parameters));
const sameList = (left: string[], right: string[]) => left === right || (left.length === right.length && left.every((item, i) => item === right[i]));
const sameValue = (left: AbstractValue, right: AbstractValue) => left === right || (sameList(left.atoms, right.atoms)
  && sameList(left.definitions, right.definitions) && sameList(left.parameters, right.parameters)
  && left.alternatives.length === right.alternatives.length && left.alternatives.every((choice, i) => {
    const other = right.alternatives[i];
    return choice.definition === other.definition && sameList(choice.atoms, other.atoms) && sameList(choice.parameters, other.parameters);
  }));
export const mergeValue = (left: AbstractValue, right: AbstractValue) => sameValue(left, right) ? left
  : value([...left.atoms, ...right.atoms], [...left.definitions, ...right.definitions], [...left.parameters, ...right.parameters], [...left.alternatives, ...right.alternatives]);
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
  if (!summary || summary.completeness !== 'complete' || summary.parameters.some(p => p.receiver)
    || summary.parameters.length !== expr.arguments.length) return undefined;
  return summary;
}

/** CFG의 유한 추상값에 worklist를 적용한다. 진단은 수렴 후 상태에서 만든다. */
export function analyzeDataflow(graph: ControlFlowGraph, options: { iterationBudget?: number; stateBudget?: number; workBudget?: number;
  summaries?: ReadonlyMap<string, FunctionSummary> } = {}): DataflowResult {
  const result: DataflowResult = { owner: graph.owner, completeness: 'complete', iterations: 0, workUnits: 0,
    diagnostics: [], definitions: [], uses: [], returns: [], throws: [], calls: [], reachableNodes: [], unknownEffects: [] };
  const facts = graph.dataflow;
  if (!facts) {
    result.completeness = 'partial'; result.diagnostics.push({ code: 'unsupported-effect', message: 'Dataflow facts are absent; rescan source' }); return result;
  }
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
    if (target.property === '*' || object.atoms.includes('*object')) {
      const cells = [...state.keys()].filter(key => key.startsWith('heap:')
        && (object.atoms.includes('*object') || objects.some(id => key.startsWith(`heap:[${JSON.stringify(id)},`))));
      return unique([...cells, ...objects.map(id => fieldCell(id, '*'))]);
    }
    return objects.map(id => fieldCell(id, target.property));
  }
  function member(object: AbstractValue, property: string, state: State): AbstractValue {
    let found: AbstractValue | undefined;
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
      } else next = unknown([object]);
      found = found ? mergeValue(found, next) : next;
    }
    return found ?? unknown([object]);
  }
  function evaluate(expr: DataExpr, state: State): AbstractValue {
    switch (expr.kind) {
      case 'exception': return state.get('pending:exception') ?? unknown();
      case 'undefined': case 'null': case 'unit': case 'uninitialized': return value([expr.kind]);
      case 'literal': return value([scalarAtom(expr.value)]);
      case 'non-null': {
        const sources = expr.sources?.map(source => evaluate(source, state)) ?? [];
        return value([`*${['number', 'string', 'boolean', 'function'].includes(expr.type) ? expr.type : 'object'}`],
          sources.flatMap(source => source.definitions), sources.flatMap(source => source.parameters));
      }
      case 'unknown': return unknown(expr.sources?.map(source => evaluate(source, state)));
      case 'entity': return value([`function:${expr.target}`]);
      case 'variable': {
        const found = state.get(variableCell(expr.key)) ?? unknown();
        if (recording) result.uses.push({ node: currentNode, variable: expr.key, definitions: found.definitions,
          mayBeUninitialized: found.atoms.includes('uninitialized'), value: found });
        return found;
      }
      case 'temporary': return state.get(temporaryCell(expr.key)) ?? unknown();
      case 'member': return member(evaluate(expr.object, state), expr.property, state);
      case 'allocation': {
        heapOpen.set(expr.id, expr.open);
        const fields = expr.fields.map(([key, expression]) => [key, evaluate(expression, state)] as const);
        for (const [key, source] of fields) {
          const cell = fieldCell(expr.id, key);
          const next = value(source.atoms, [recordDefinition(cell, source)], source.parameters);
          const old = state.get(cell);
          state.set(cell, old && repeatedAllocation ? mergeValue(old, next) : next);
          state.set(`shape:${cell}`, value(['boolean:true']));
        }
        return value([`object:${expr.id}`], [], fields.flatMap(([, v]) => v.parameters));
      }
      case 'call': {
        const arguments_ = expr.arguments.map(argument => evaluate(argument, state));
        const summary = applicableSummary(expr, state);
        const application = modelApplication(expr, state);
        if (recording) result.calls.push({ node: currentNode, target: expr.target, arguments: arguments_, resolution: summary ? application?.status === 'applied' ? 'model' : 'summary' : 'unknown',
          ...(application ? { model: application } : {}) });
        if (!summary) {
          const result = unknown([evaluate(expr.callee, state), ...arguments_]);
          // unknown 호출은 closure/heap을 통해 명시적 인자 밖의 입력도 읽을 수 있다.
          return value(result.atoms, [recordDefinition(`call:${expr.target ?? 'unknown'}`, result)], [...result.parameters, ...allParameters]);
        }
        const sources = summary.parameters.filter(p => summary.returnParameters.includes(p.key)).map(p => arguments_[p.index]);
        const source = value(summary.returnAtoms, sources.flatMap(v => v.definitions), [...sources.flatMap(v => v.parameters), ...summary.effects.unknown ? allParameters : []]);
        return value(source.atoms, [recordDefinition(`call:${expr.target}`, source)], source.parameters);
      }
      case 'unary': {
        const source = evaluate(expr.value, state);
        if (expr.operator === 'nullish' || expr.operator === 'undefined') {
          return value(source.atoms.flatMap(atom => atom === 'uninitialized' ? ['boolean:true', 'boolean:false']
            : [scalarAtom(expr.operator === 'nullish' ? ['null', 'undefined'].includes(atom) : atom === 'undefined')]), source.definitions, source.parameters);
        }
        if (['!', 'not'].includes(expr.operator)) return value(truth(source).map(v => scalarAtom(!v)), source.definitions, source.parameters);
        return unknown([source]);
      }
      case 'binary': {
        const left = evaluate(expr.left, state), right = evaluate(expr.right, state);
        const abstractResult = () => {
          const sources = [left, right], defs = sources.flatMap(v => v.definitions), params = sources.flatMap(v => v.parameters);
          if (['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'is', 'is not'].includes(expr.operator)) return value(['*boolean'], defs, params);
          if (['+', '-', '*', '/', '%'].includes(expr.operator) && sources.every(v => v.atoms.every(atom => atomType(atom) === 'number'))) return value(['*number'], defs, params);
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
        }
        return value(atoms, [...left.definitions, ...right.definitions], [...left.parameters, ...right.parameters]);
      }
    }
  }
  function modelApplication(expr: DataExpr, state: State): ModelApplication | undefined {
    if (expr.kind !== 'call' || !expr.model) return undefined;
    const { status, reference, contract } = expr.model;
    if (status !== 'candidate' || !contract) return { status, ...(reference ? { reference } : {}) };
    if (expr.argumentsKnown === false || expr.arguments.length !== contract.parameters.length) return { status: 'argument-mapping', reference };
    const callee = evaluate(expr.callee, state);
    if (callee.atoms.length !== 1 || callee.atoms[0] !== `function:${expr.target}`) return { status: 'callee-not-proven', reference };
    const valid = contract.parameters.every((domain, i) => {
      if (domain === 'any') return true;
      const atoms = evaluate(expr.arguments[i], state).atoms;
      return atoms.length > 0 && atoms.every(atom => domain === 'primitive'
        ? ['string', 'number', 'boolean', 'null', 'undefined', 'unit'].includes(atomType(atom)) : atomType(atom) === domain);
    });
    return { status: valid ? 'applied' : 'argument-domain', reference };
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
  function havoc(state: State, mutateLocals = false): void {
    for (const [cell, old] of state) {
      const variable = cell.startsWith('var:') ? variables.get(cell.slice(4)) : undefined;
      if (cell.startsWith('heap:') || variable?.captured || variable?.category === 'external' || (mutateLocals && variable)) {
        state.set(cell, value(unknownAtoms, [recordDefinition(cell, old)], [...old.parameters, ...allParameters]));
      }
      if (cell.startsWith('shape:')) state.set(cell, value(['*boolean']));
    }
  }
  function knownDataProperty(object: DataExpr, property: string, state: State): boolean {
    const atoms = evaluate(object, state).atoms;
    return property !== '*' && atoms.length > 0 && atoms.every(atom => atom.startsWith('object:')
      && state.get(`shape:${fieldCell(atom.slice(7), property)}`)?.atoms.join(',') === 'boolean:true');
  }
  function transfer(input: State, effect: NodeEffect | undefined, exceptional = false): State {
    const state = new Map(input);
    if (exceptional || ['throw', 'break', 'continue'].includes(graph.nodes[currentNode].kind)) state.delete('pending:return');
    if (!effect) return state;
    const evaluated = exceptional ? undefined : evaluate(effect.value, state);
    const writes = exceptional ? [] : effect.writes.map(write => ({ target: write.target, value: evaluate(write.value, state), cells: getLocation(write.target, state),
      uncertainSetter: write.target.kind === 'member' && !knownDataProperty(write.target.object, write.target.property, state) }));
    const uncertainGetter = effect.value.kind === 'member' && !knownDataProperty(effect.value.object, effect.value.property, state);
    const uncertainSetter = effect.writes.some(write => write.target.kind === 'member' && !knownDataProperty(write.target.object, write.target.property, state));
    const summary = applicableSummary(effect.value, input);
    const knownCallEffects = !!summary && (summary.effects.heap || summary.effects.bindings.length > 0 || summary.effects.unknown);
    const unknownCallEffects = effect.mayCall && (!summary || summary.effects.unknown) || effect.mayMutateLocals;
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
      havoc(state, effect.mayMutateLocals);
    }
    if (exceptional) {
      const arguments_ = summary && effect.value.kind === 'call' ? effect.value.arguments : undefined;
      const sources = summary && arguments_ ? summary.parameters.filter(p => summary.throwParameters.includes(p.key))
        .map(p => evaluate(arguments_[p.index], new Map(input))) : [evaluate(effect.value, new Map(input))];
      state.set('pending:exception', unknown(sources));
      return state;
    }
    if (evaluated) state.set(temporaryCell(effect.resultKey), evaluated);
    if (evaluated && graph.nodes[currentNode].kind === 'return') state.set('pending:return', evaluated);
    if (evaluated && graph.nodes[currentNode].kind === 'throw') state.set('pending:exception', evaluated);
    for (const write of writes) for (const cell of write.cells) {
      const source = write.uncertainSetter ? unknown([write.value]) : write.value;
      const next = value(source.atoms, [recordDefinition(cell, source)], source.parameters);
      const old = state.get(cell);
      const strong = write.target.kind === 'variable' || (write.cells.length === 1 && write.target.property !== '*' && !repeatedAllocation && !write.uncertainSetter);
      state.set(cell, !strong && old ? mergeValue(old, next) : next);
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
    initial.set(cell, value(source.atoms, [recordDefinition(cell, source)], variable.category === 'parameter' ? [variable.key] : source.parameters));
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
      if (edge.to === graph.exceptionExit) {
        const thrown = transfer(input, effect, edge.kind === 'exception');
        result.throws.push({ node, value: thrown.get('pending:exception') ?? unknown() });
      }
      if (edge.to !== graph.exit) continue;
      if (effect && applicableSummary(effect.value, input)?.mayReturn === false) continue;
      if ((edge.kind === 'true' || edge.kind === 'false') && effect?.guard && !truth(evaluate(effect.guard, new Map(input))).includes(edge.kind === 'true')) continue;
      const output = transfer(input, effect);
      const fallback = graph.implicitReturnSource ? output.get(temporaryCell(`${graph.implicitReturnSource.startOffset}:${graph.implicitReturnSource.endOffset}`)) ?? unknown()
        : value([graph.language === 'python' ? 'null' : graph.language === 'rust' ? 'unit' : 'undefined']);
      result.returns.push({ node, value: output.get('pending:return') ?? (graph.nodes[node].text === 'Try::branch' ? unknown() : fallback) });
    }
  }
  result.definitions = [...definitions.values()].sort((a, b) => a.node - b.node || a.location.localeCompare(b.location));
  const uses = new Map<string, FlowUse>();
  for (const use of result.uses) {
    const key = `${use.node}:${use.variable}`;
    const existing = uses.get(key);
    uses.set(key, existing ? { ...use, definitions: unique([...existing.definitions, ...use.definitions]),
      mayBeUninitialized: existing.mayBeUninitialized || use.mayBeUninitialized, value: mergeValue(existing.value, use.value) } : use);
  }
  result.uses = [...uses.values()].sort((a, b) => a.node - b.node || a.variable.localeCompare(b.variable));
  result.unknownEffects = [...unknownEffects].sort((a, b) => a - b);
  const calls = new Map<number, FlowCall>();
  for (const call of result.calls) {
    const existing = calls.get(call.node);
    calls.set(call.node, existing ? { ...call, arguments: call.arguments.map((argument, i) => mergeValue(existing.arguments[i], argument)) } : call);
  }
  result.calls = [...calls.values()].sort((a, b) => a.node - b.node);
  return result;
}
