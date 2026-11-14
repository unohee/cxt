import type Parser from 'tree-sitter';
import type { AstLanguage } from './types.js';
import type { CfgDiagnostic, CfgEdgeKind, CfgNode, ControlFlowGraph, SourceSpan } from '../analysis/cfg.js';
import { buildBasicBlocks } from '../analysis/cfg.js';

type Node = Parser.SyntaxNode;
type Port = { id: number; kind: CfgEdgeKind };
type Completion = { kind: 'return' | 'throw' | 'break' | 'continue'; port: Port; label?: string };
type Flow = { normal: Port[]; abrupt: Completion[] };
const field = (node: Node, name: string) => node.childForFieldName(name);
const span = (node: Node): SourceSpan => ({ line: node.startPosition.row + 1, column: node.startPosition.column + 1,
  endLine: node.endPosition.row + 1, endColumn: node.endPosition.column + 1, startOffset: node.startIndex, endOffset: node.endIndex });
const port = (id: number, kind: CfgEdgeKind = 'normal'): Port => ({ id, kind });
const plain = (normal: Port[]): Flow => ({ normal, abrupt: [] });
const functions = new Set(['function_declaration', 'generator_function_declaration', 'function_expression', 'generator_function',
  'arrow_function', 'method_definition', 'function_definition', 'lambda', 'function_item', 'closure_expression']);
const declarations = new Set([...functions, 'class_declaration', 'abstract_class_declaration', 'class_definition', 'class',
  'struct_item', 'enum_item', 'trait_item', 'impl_item', 'mod_item', 'type_alias_declaration', 'interface_declaration',
  'function_signature', 'function_signature_item', 'import_statement', 'import_from_statement', 'use_declaration']);

/** 함수별 AST를 CFG로 변환한다. finally는 대기 중인 completion별로 복제한다. */
export function buildControlFlow(callable: Node, filePath: string, owner: string, language: AstLanguage, nodeBudget = 20_000): ControlFlowGraph {
  const graph: ControlFlowGraph = { version: 1, filePath, owner, language, entry: 0, exit: 1, exceptionExit: 2,
    nodes: [], edges: [], blocks: [], blockEdges: [], completeness: 'complete', diagnostics: [], structuralComplexity: 1 };
  const modifiers = callable.children.flatMap(child => child.type === 'function_modifiers' ? child.children : [child]);
  graph.executionKind = modifiers.some(child => child.type === 'async') ? 'async'
    : callable.type.includes('generator') || modifiers.some(child => child.type === '*') ? 'generator' : 'sync';
  const edgeKeys = new Set<string>();
  const decisions = new Set<string>();
  const diagnostics = new Set<string>();
  const budgetExceeded = new Error('CFG node budget exceeded');

  function diagnostic(node: Node, message: string, code: CfgDiagnostic['code'] = 'unsupported-control') {
    const key = `${node.startIndex}:${message}`;
    if (!diagnostics.has(key)) { diagnostics.add(key); graph.diagnostics.push({ code, message, span: span(node) }); }
    graph.completeness = 'partial';
  }
  function decision(node: Node, suffix = '') { decisions.add(`${node.startIndex}:${node.type}:${suffix}`); }
  function edge(from: Port, to: number) {
    const key = `${from.id}:${to}:${from.kind}`;
    if (!edgeKeys.has(key)) { edgeKeys.add(key); graph.edges.push({ from: from.id, to, kind: from.kind }); }
  }
  function emit(kind: CfgNode['kind'], node: Node, incoming: Port[], text = node.text): number {
    if (graph.nodes.length >= nodeBudget) throw budgetExceeded;
    const id = graph.nodes.length;
    graph.nodes.push({ id, kind, astType: node.type, text, span: span(node) });
    for (const source of incoming) edge(source, id);
    return id;
  }
  function operation(node: Node, incoming: Port[], mayThrow = false, kind: CfgNode['kind'] = 'operation', text?: string): Flow {
    const id = emit(kind, node, incoming, text);
    return { normal: [port(id)], abrupt: mayThrow ? [{ kind: 'throw', port: port(id, 'exception') }] : [] };
  }
  function selectedValue(node: Node, value: Node | null, incoming: Port[], role: string): Port[] {
    const id = emit('operation', node, incoming, role);
    if (value) graph.nodes[id].valueSource = span(value);
    else graph.nodes[id].constantValue = 'unit';
    return [port(id)];
  }
  function tailValue(node: Node | null): Node | null {
    if (!node) return null;
    if (node.type === 'else_clause') return tailValue(node.namedChild(0));
    if (node.type === 'block') {
      const last = node.namedChildren.at(-1);
      return last && !last.type.endsWith('_statement') && !last.type.endsWith('_declaration') ? last : null;
    }
    return node;
  }
  function sequence(nodes: Node[], incoming: Port[]): Flow {
    let flow = plain(incoming);
    for (const node of nodes) {
      const next = statement(node, flow.normal);
      flow = { normal: next.normal, abrupt: [...flow.abrupt, ...next.abrupt] };
    }
    return flow;
  }
  const chainTypes = new Set(['call_expression', 'member_expression', 'subscript_expression']);
  function chain(node: Node, incoming: Port[]): Flow & { skipped: Port[] } {
    const base = field(node, 'function') ?? field(node, 'object');
    const left = base && chainTypes.has(base.type) ? chain(base, incoming)
      : { ...expression(base, incoming), skipped: [] };
    let active = left.normal;
    const skipped = [...left.skipped];
    const abrupt = [...left.abrupt];
    if (node.children.some(child => child.type === 'optional_chain' || child.type === '?.')) {
      const test = emit('condition', node, active, 'receiver is nullish');
      decision(node, 'optional-chain');
      skipped.push(port(test, 'true')); active = [port(test, 'false')];
    }
    const children = node.type === 'call_expression' ? field(node, 'arguments')?.namedChildren ?? []
      : node.type === 'subscript_expression' && field(node, 'index') ? [field(node, 'index')!] : [];
    for (const child of children) {
      const next = expression(child, active); active = next.normal; abrupt.push(...next.abrupt);
    }
    const own = operation(node, active, true);
    return { normal: own.normal, skipped, abrupt: [...abrupt, ...own.abrupt] };
  }
  function expression(node: Node | null, incoming: Port[]): Flow {
    if (!node) return plain(incoming);
    if (declarations.has(node.type)) return operation(node, incoming);
    if (language === 'typescript' && chainTypes.has(node.type)) {
      const result = chain(node, incoming);
      let skipped: Port[] = [];
      if (result.skipped.length) {
        const id = emit('operation', node, result.skipped, 'optional chain undefined');
        graph.nodes[id].constantValue = 'undefined'; skipped = [port(id)];
      }
      return { normal: [...result.normal, ...skipped], abrupt: result.abrupt };
    }
    if (['if_expression', 'match_expression', 'block', 'unsafe_block', 'loop_expression', 'while_expression', 'for_expression',
      'return_expression', 'break_expression', 'continue_expression'].includes(node.type)) return statement(node, incoming);
    if (['ternary_expression', 'conditional_expression'].includes(node.type)) {
      const condition = field(node, 'condition') ?? node.namedChild(1);
      return branch(node, condition, field(node, 'consequence') ?? node.namedChild(0), field(node, 'alternative') ?? node.namedChild(2), incoming);
    }
    const operator = field(node, 'operator')?.text ?? node.children.find(child => ['&&', '||', '??', 'and', 'or'].includes(child.type))?.type;
    const logicalAssignment = node.children.find(child => ['&&=', '||=', '??='].includes(child.type))?.type;
    if (logicalAssignment) {
      const left = expression(field(node, 'left'), incoming);
      const test = emit('condition', node, left.normal, logicalAssignment === '??=' ? 'is nullish' : field(node, 'left')?.text);
      decision(node);
      const enterRight = logicalAssignment !== '||=';
      const right = expression(field(node, 'right'), [port(test, enterRight ? 'true' : 'false')]);
      const assigned = operation(node, right.normal);
      const retained = selectedValue(node, field(node, 'left'), [port(test, enterRight ? 'false' : 'true')], 'logical assignment retains left');
      return { normal: [...assigned.normal, ...retained], abrupt: [...left.abrupt, ...right.abrupt] };
    }
    if (['binary_expression', 'boolean_operator'].includes(node.type) && operator && ['&&', '||', '??', 'and', 'or'].includes(operator)) {
      const left = expression(field(node, 'left'), incoming);
      const test = emit('condition', node, left.normal, operator === '??' ? 'is nullish' : field(node, 'left')?.text);
      decision(node);
      const enterRight = operator === '&&' || operator === 'and' || operator === '??';
      const right = expression(field(node, 'right'), [port(test, enterRight ? 'true' : 'false')]);
      const selectedRight = selectedValue(node, field(node, 'right'), right.normal, 'short circuit right');
      const retained = selectedValue(node, field(node, 'left'), [port(test, enterRight ? 'false' : 'true')], 'short circuit left');
      return { normal: [...selectedRight, ...retained], abrupt: [...left.abrupt, ...right.abrupt] };
    }
    if (node.type === 'try_expression' && language === 'rust') {
      const value = expression(node.namedChild(0), incoming);
      const test = emit('condition', node, value.normal, 'Try::branch');
      decision(node);
      return { normal: [port(test, 'true')], abrupt: [...value.abrupt, { kind: 'return', port: port(test, 'false') }] };
    }
    if (node.type === 'await_expression' || node.type === 'await') {
      // 중단은 함수의 정상 반환이 아니다. resume/exception은 재개 시 가능한
      // 결과이며 실제 재개 여부나 스케줄러의 진행을 보장하지 않는다.
      let value = plain(incoming);
      for (const child of node.namedChildren) {
        const next = expression(child, value.normal);
        value = { normal: next.normal, abrupt: [...value.abrupt, ...next.abrupt] };
      }
      const suspended = emit('suspend', node, value.normal);
      graph.suspensionExit ??= emit('suspend-exit', callable, [], 'suspended');
      edge(port(suspended, 'suspend'), graph.suspensionExit);
      return { normal: [port(suspended, 'resume')], abrupt: [...value.abrupt, { kind: 'throw', port: port(suspended, 'exception') }] };
    }
    if (['yield_expression', 'yield', 'yield_statement'].includes(node.type)) {
      // Generator suspension has the same local CFG contract as await: the
      // yielded value is evaluated once, control leaves the function, and a
      // later resume continues at the successor. Injected exceptions are
      // represented as an abrupt edge so try/finally cleanup remains visible.
      let value = plain(incoming);
      for (const child of node.namedChildren) {
        const next = expression(child, value.normal);
        value = { normal: next.normal, abrupt: [...value.abrupt, ...next.abrupt] };
      }
      const suspended = emit('suspend', node, value.normal);
      graph.suspensionExit ??= emit('suspend-exit', callable, [], 'suspended');
      edge(port(suspended, 'suspend'), graph.suspensionExit);
      const delegated = language === 'python' && node.type === 'yield' && node.text.trimStart().startsWith('yield from ');
      if (delegated) {
        const exhausted = emit('condition', node, [port(suspended, 'resume')], 'yield from exhausted');
        decision(node, 'yield-from');
        const next = emit('suspend', node, [port(exhausted, 'false')], 'yield from resume');
        edge(port(next, 'suspend'), graph.suspensionExit);
        edge(port(next, 'resume'), exhausted);
        return { normal: [port(exhausted, 'true')], abrupt: [...value.abrupt,
          { kind: 'throw', port: port(suspended, 'exception') }, { kind: 'throw', port: port(next, 'exception') }] };
      }
      return { normal: [port(suspended, 'resume')], abrupt: [...value.abrupt, { kind: 'throw', port: port(suspended, 'exception') }] };
    }
    if (['async_block', 'gen_block', 'try_block'].includes(node.type)) {
      diagnostic(node, `Suspension or non-local expression requires a state model: ${node.type}`);
    }
    if (node.type === 'macro_invocation') diagnostic(node, 'Rust macro expansion is unavailable');
    if (['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression'].includes(node.type)) {
      const clauses = node.namedChildren.filter(child => child.type === 'for_in_clause');
      const filters = node.namedChildren.filter(child => child.type === 'if_clause');
      if (language === 'python' && node.type === 'generator_expression') {
        // Python evaluates only the outermost iterable when creating a
        // generator expression. Element/filter calls are deferred until the
        // iterator is consumed, so do not add eager call/throw effects here.
        diagnostic(node, 'Generator expression body is deferred until iteration');
        const outerIterable = field(clauses[0], 'right') ?? clauses[0]?.namedChild(1);
        const eager = expression(outerIterable, incoming);
        const lazy = operation(node, eager.normal, false, 'operation', 'lazy generator expression');
        return { normal: lazy.normal, abrupt: [...eager.abrupt] };
      }
      // A single synchronous for-clause without a filter has ordinary loop
      // semantics that fit this local CFG: iterator exhaustion exits, each
      // iteration binds the target, and the element expression loops back.
      // Generator expressions retain the conservative partial contract until
      // lazy evaluation and resume semantics are modeled separately. Filters
      // are assigned to the clause immediately preceding them below.
      if (language === 'python' && node.type !== 'generator_expression' && clauses.length >= 1
        ) {
        const comprehensionNode = node;
        const element = node.namedChildren.find(child => child.type !== 'for_in_clause') ?? node.namedChild(0);
        function nested(index: number, ports: Port[]): Flow {
          const clause = clauses[index];
          const iterable = field(clause, 'right') ?? clause.namedChild(1);
          const source = expression(iterable, ports);
          const header = emit('join', clause, source.normal, `comprehension iterator header ${index + 1}`);
          const next = operation(clause, [port(header)], true, 'operation', 'comprehension iterator next');
          const asyncIteration = language === 'python' && clause.text.trimStart().startsWith('async for ');
          let iteratorValue = next;
          if (asyncIteration) {
            const suspended = emit('suspend', clause, next.normal, 'async comprehension iterator next');
            graph.suspensionExit ??= emit('suspend-exit', callable, [], 'suspended');
            edge(port(suspended, 'suspend'), graph.suspensionExit);
            iteratorValue = {
              normal: [port(suspended, 'resume')],
              abrupt: [...next.abrupt, { kind: 'throw', port: port(suspended, 'exception') }],
            };
          }
          const test = emit('condition', clause, iteratorValue.normal, 'iterator has next');
          decision(clause, `comprehension-iteration-${index}`);
          const binding = emit('operation', clause, [port(test, 'true')], 'comprehension iteration binding');
          graph.nodes[binding].binding = 'iteration';
          const clausePosition = comprehensionNode.namedChildren.indexOf(clause);
          const nextClausePosition = index + 1 < clauses.length
            ? comprehensionNode.namedChildren.indexOf(clauses[index + 1])
            : Number.POSITIVE_INFINITY;
          const localFilters = filters.filter(filter => {
            const position = comprehensionNode.namedChildren.indexOf(filter);
            return position > clausePosition && position < nextClausePosition;
          });
          function applyFilters(filterPorts: Port[]): { normal: Port[]; abrupt: Completion[] } {
            let current = filterPorts;
            const abrupt: Completion[] = [];
            for (const filter of localFilters) {
              const checked = expression(filter.namedChild(0), current);
              abrupt.push(...checked.abrupt);
              const filterTest = emit('condition', filter, checked.normal, 'comprehension filter');
              decision(filter, 'comprehension-filter');
              edge(port(filterTest, 'back'), header);
              current = [port(filterTest, 'true')];
            }
            return { normal: current, abrupt };
          }
          let body: Flow;
          const filtered = applyFilters([port(binding)]);
          if (index + 1 < clauses.length) {
            body = nested(index + 1, filtered.normal);
            body.abrupt.push(...filtered.abrupt);
          }
          else {
            const evaluated = expression(element, filtered.normal);
            for (const sourcePort of evaluated.normal) edge(port(sourcePort.id, 'back'), header);
            body = { normal: [port(test, 'false')], abrupt: [...filtered.abrupt, ...evaluated.abrupt] };
          }
          // Exhausting an inner iterator advances the enclosing iterator.
          if (index + 1 < clauses.length) for (const sourcePort of body.normal) edge(port(sourcePort.id, 'back'), header);
          return { normal: [port(test, 'false')], abrupt: [...source.abrupt, ...iteratorValue.abrupt, ...body.abrupt] };
        }
        const loops = nested(0, incoming);
        const result = operation(node, loops.normal, true);
        return { normal: result.normal, abrupt: [...loops.abrupt, ...result.abrupt] };
      }
      diagnostic(node, `Comprehension/generator control is not lowered: ${node.type}`);
      // Preserve evaluation effects of calls and member reads nested inside
      // the comprehension before recording the result as partial. Iteration
      // binding and zero/many-iteration control remain intentionally unknown.
      let nested = plain(incoming);
      for (const child of node.namedChildren) {
        const next = expression(child, nested.normal);
        nested = { normal: next.normal, abrupt: [...nested.abrupt, ...next.abrupt] };
      }
      return operation(node, nested.normal, true);
    }
    // 타입·패턴·property 이름은 평가식이 아니다. 자식의 부수 효과를 순서대로 보존한다.
    const skippedFields = ['type', 'return_type', 'name', 'pattern', 'property', 'attribute', 'field', 'label'];
    const skipped = new Set(skippedFields.map(name => field(node, name)?.id));
    let flow = plain(incoming);
    for (const child of node.namedChildren.filter(child => !skipped.has(child.id) && child.type !== 'comment')) {
      const next = expression(child, flow.normal);
      flow = { normal: next.normal, abrupt: [...flow.abrupt, ...next.abrupt] };
    }
    const mayThrow = ['call', 'call_expression', 'new_expression', 'member_expression', 'attribute', 'subscript_expression',
      'subscript', 'await_expression', 'await', 'macro_invocation'].includes(node.type);
    const own = operation(node, flow.normal, mayThrow);
    return { normal: own.normal, abrupt: [...flow.abrupt, ...own.abrupt] };
  }
  function branch(node: Node, condition: Node | null, yes: Node | null, no: Node | null, incoming: Port[]): Flow {
    const value = expression(condition, incoming);
    const test = emit('condition', condition ?? node, value.normal);
    decision(node);
    const consequent = yes ? statement(yes, [port(test, 'true')]) : plain([port(test, 'true')]);
    const alternative = no ? statement(no, [port(test, 'false')]) : plain([port(test, 'false')]);
    if (['ternary_expression', 'conditional_expression', 'if_expression'].includes(node.type)) {
      consequent.normal = selectedValue(node, tailValue(yes), consequent.normal, 'conditional consequence value');
      alternative.normal = selectedValue(node, tailValue(no), alternative.normal, 'conditional alternative value');
    }
    return { normal: [...consequent.normal, ...alternative.normal], abrupt: [...value.abrupt, ...consequent.abrupt, ...alternative.abrupt] };
  }
  function alternatives(nodes: Node[], incoming: Port[]): Flow {
    if (!nodes.length) return plain(incoming);
    const [first, ...rest] = nodes;
    if (first.type !== 'elif_clause') return statement(first, incoming);
    const value = expression(field(first, 'condition'), incoming);
    const test = emit('condition', field(first, 'condition') ?? first, value.normal);
    decision(first);
    const yes = statement(field(first, 'consequence')!, [port(test, 'true')]);
    const no = alternatives(rest, [port(test, 'false')]);
    return { normal: [...yes.normal, ...no.normal], abrupt: [...value.abrupt, ...yes.abrupt, ...no.abrupt] };
  }
  const jumpLabel = (node: Node) => (field(node, 'label') ?? node.namedChildren.find(n => n.type === 'label'))?.text.replace(/^'/, '');
  const consumes = (completion: Completion, kind: Completion['kind'], label?: string) =>
    completion.kind === kind && (completion.label === undefined || completion.label === label);

  function loop(node: Node, incoming: Port[], label?: string): Flow {
    const isDo = node.type === 'do_statement';
    const isForEach = ['for_in_statement', 'for_expression'].includes(node.type) || (language === 'python' && node.type === 'for_statement');
    const asyncIteration = isForEach && node.children.some(child => child.type === 'async' || child.type === 'await');
    const initNode = isForEach ? field(node, 'right') ?? field(node, 'value') : field(node, 'initializer');
    const init = initNode ? statement(initNode, incoming) : plain(incoming);
    const header = emit('join', node, init.normal, 'loop header');
    const condition = field(node, 'condition');
    const unconditional = node.type === 'loop_expression' || (node.type === 'for_statement' && !isForEach && (!condition || condition.type === 'empty_statement'));
    const conditionEntry = isDo ? emit('join', node, [], 'do condition') : header;
    const conditionIncoming = [port(conditionEntry)];
    let value: Flow;
    if (!isForEach) value = expression(condition, conditionIncoming);
    else {
      const next = operation(node, conditionIncoming, true, 'operation', 'iterator next');
      if (!asyncIteration) value = next;
      else {
        const suspended = emit('suspend', node, next.normal, 'async iterator next');
        graph.suspensionExit ??= emit('suspend-exit', callable, [], 'suspended');
        edge(port(suspended, 'suspend'), graph.suspensionExit);
        value = { normal: [port(suspended, 'resume')], abrupt: [...next.abrupt, { kind: 'throw', port: port(suspended, 'exception') }] };
      }
    }
    const test = emit('condition', condition ?? node, value.normal, unconditional ? 'true' : isForEach ? 'iterator has next' : condition?.text);
    if (!unconditional) decision(node);
    let bodyIncoming = isDo ? [port(header)] : [port(test, 'true')];
    if (isForEach) {
      const binding = emit('operation', node, bodyIncoming, 'iteration binding');
      graph.nodes[binding].binding = 'iteration'; bodyIncoming = [port(binding)];
    }
    const body = statement(field(node, 'body')!, bodyIncoming);
    const continuePorts = body.abrupt.filter(c => consumes(c, 'continue', label)).map(c => c.port);
    const increment = field(node, 'increment');
    const update = expression(increment, [...body.normal, ...continuePorts]);
    if (isDo) for (const source of update.normal) edge(source, conditionEntry);
    else for (const source of update.normal) edge(port(source.id, 'back'), header);
    if (isDo) edge(port(test, 'true'), header);
    const exhausted = unconditional ? [] : [port(test, 'false')];
    const alternative = field(node, 'alternative');
    const after = alternative ? statement(alternative, exhausted) : plain(exhausted);
    return { normal: [...after.normal, ...body.abrupt.filter(c => consumes(c, 'break', label)).map(c => c.port)],
      abrupt: [...init.abrupt, ...value.abrupt, ...update.abrupt, ...after.abrupt,
        ...body.abrupt.filter(c => !consumes(c, 'break', label) && !consumes(c, 'continue', label))] };
  }

  function applyFinally(node: Node, flow: Flow, cleanup: (incoming: Port[]) => Flow): Flow {
    const groups = new Map<string, { normal: boolean; kind?: Completion['kind']; label?: string; incoming: Port[] }>();
    if (flow.normal.length) groups.set('normal', { normal: true, incoming: flow.normal });
    for (const completion of flow.abrupt) {
      const key = `${completion.kind}:${completion.label ?? ''}`;
      const group = groups.get(key) ?? { normal: false, kind: completion.kind, label: completion.label, incoming: [] };
      group.incoming.push(completion.port); groups.set(key, group);
    }
    const result: Flow = { normal: [], abrupt: [] };
    for (const group of groups.values()) {
      const entry = emit('cleanup', node, group.incoming, `cleanup for ${group.normal ? 'normal' : group.kind}`);
      const after = cleanup([port(entry)]);
      result.abrupt.push(...after.abrupt);
      if (group.normal) result.normal.push(...after.normal);
      else for (const source of after.normal) result.abrupt.push({ kind: group.kind!, label: group.label, port: source });
    }
    return result;
  }
  function tryStatement(node: Node, incoming: Port[]): Flow {
    const body = statement(field(node, 'body')!, incoming);
    const catches = node.namedChildren.filter(n => ['catch_clause', 'except_clause', 'except_group_clause'].includes(n.type));
    const alternative = node.namedChildren.find(n => n.type === 'else_clause');
    const succeeded = alternative ? statement(alternative, body.normal) : plain(body.normal);
    const result: Flow = { normal: succeeded.normal, abrupt: [...succeeded.abrupt, ...body.abrupt.filter(c => c.kind !== 'throw')] };
    let pending = body.abrupt.filter(c => c.kind === 'throw').map(c => c.port);
    for (const handler of catches) {
      // tree-sitter-python represents both `except` and `except*` as
      // `except_clause`; the literal `*` child is the only reliable local
      // discriminator.  Model each except* arm as consuming only the
      // matching subgroup while carrying the unmatched subgroup to the next
      // arm.  This keeps the normal continuation and unhandled remainder
      // separate instead of treating an exception group as an ordinary
      // first-match catch.
      const exceptionGroup = language === 'python' && handler.type === 'except_clause'
        && handler.children.some(child => child.type === '*');
      const rawType = field(handler, 'value');
      // Python's `except T as name` stores the whole `as_pattern` in the
      // value field.  The exception matcher must evaluate only T; the alias
      // is handled by the separate exception-binding operation.
      const type = rawType?.type === 'as_pattern' ? rawType.namedChild(0) : rawType;
      decision(handler, exceptionGroup ? 'exception-group-split' : 'exception-match');
      const checked = expression(type, pending);
      result.abrupt.push(...checked.abrupt);
      const dispatch = emit('condition', handler, checked.normal,
        exceptionGroup ? `exception group matches ${type?.text ?? 'catch all'}` : type ? `exception matches ${type.text}` : 'catch all');
      const bind = emit('operation', handler, [port(dispatch, 'true')], 'exception binding');
      graph.nodes[bind].binding = 'exception';
      let caught = statement(field(handler, 'body') ?? handler.namedChildren.find(n => n.type === 'block')!, [port(bind)]);
      if (language === 'python' && rawType?.type === 'as_pattern') {
        caught = applyFinally(handler, caught, sources => {
          const clear = operation(handler, sources, false, 'operation', 'clear exception binding');
          graph.nodes[clear.normal[0].id].binding = 'exception-clear'; return clear;
        });
      }
      result.normal.push(...caught.normal); result.abrupt.push(...caught.abrupt);
      // For except* the false branch is the remainder of the group and must
      // be tested by subsequent arms. Ordinary except retains first-match
      // semantics and also clears the pending remainder after a catch-all.
      pending = type ? [port(dispatch, 'false')] : [];
    }
    result.abrupt.push(...pending.map(source => ({ kind: 'throw' as const, port: source })));
    const finalizer = field(node, 'finalizer') ?? node.namedChildren.find(n => n.type === 'finally_clause');
    return finalizer ? applyFinally(finalizer, result, ports => statement(finalizer, ports)) : result;
  }
  function withStatement(node: Node, incoming: Port[]): Flow {
    const items = node.namedChildren.find(n => n.type === 'with_clause')?.namedChildren ?? [];
    const asyncWith = node.children.some(child => child.type === 'async');
    function suspend(operationFlow: Flow, item: Node, text: string): Flow {
      if (!asyncWith) return operationFlow;
      const suspended = emit('suspend', item, operationFlow.normal, text);
      graph.suspensionExit ??= emit('suspend-exit', callable, [], 'suspended');
      edge(port(suspended, 'suspend'), graph.suspensionExit);
      return { normal: [port(suspended, 'resume')], abrupt: [...operationFlow.abrupt, { kind: 'throw', port: port(suspended, 'exception') }] };
    }
    function resource(index: number, ports: Port[]): Flow {
      if (index === items.length) return statement(field(node, 'body')!, ports);
      const item = items[index];
      const context = field(item, 'value');
      const manager = context?.type === 'as_pattern' ? field(context, 'value') ?? context.namedChild(0) : context;
      const value = expression(manager, ports);
      const enteredOperation = operation(item, value.normal, true, 'operation', asyncWith ? '__aenter__' : '__enter__');
      graph.nodes[enteredOperation.normal[0].id].resourceSource = manager ? span(manager) : undefined;
      if (field(field(item, 'value') ?? item, 'alias')) graph.nodes[enteredOperation.normal[0].id].binding = 'resource-enter';
      const entered = suspend(enteredOperation, item, 'async context enter');
      const inner = resource(index + 1, entered.normal);
      const after: Flow = { normal: [], abrupt: [...value.abrupt, ...entered.abrupt] };
      const clean = applyFinally(item, inner, sources => {
        const exitOperation = operation(item, sources, true, 'cleanup', asyncWith ? '__aexit__' : '__exit__');
        graph.nodes[exitOperation.normal[0].id].resourceSource = manager ? span(manager) : undefined;
        return suspend(exitOperation, item, 'async context exit');
      });
      // Only an exceptional completion may be suppressed by the context exit protocol.
      after.normal.push(...clean.normal);
      for (const completion of clean.abrupt) {
        if (completion.kind === 'throw' && completion.port.kind !== 'exception') {
          const test = emit('condition', item, [completion.port], `${asyncWith ? '__aexit__' : '__exit__'} suppresses exception`);
          graph.nodes[test].resourceSource = manager ? span(manager) : undefined;
          decision(item, 'suppression');
          after.normal.push(port(test, 'true')); after.abrupt.push({ kind: 'throw', port: port(test, 'false') });
        } else after.abrupt.push(completion);
      }
      return after;
    }
    return resource(0, incoming);
  }

  function switchStatement(node: Node, incoming: Port[], label?: string): Flow {
    const value = expression(field(node, 'value'), incoming);
    const cases = field(node, 'body')?.namedChildren ?? [];
    const entries = cases.map(item => emit('join', item, [], item.type));
    let unmatched = value.normal;
    const abrupt = [...value.abrupt];
    let defaultIndex = -1;
    for (let index = 0; index < cases.length; index++) {
      const item = cases[index];
      if (item.type === 'switch_default') { defaultIndex = index; continue; }
      const selector = expression(field(item, 'value'), unmatched);
      const test = emit('condition', item, selector.normal, `case ${field(item, 'value')?.text ?? ''}`);
      decision(item); abrupt.push(...selector.abrupt);
      edge(port(test, 'true'), entries[index]); unmatched = [port(test, 'false')];
    }
    if (defaultIndex >= 0) { for (const source of unmatched) edge(source, entries[defaultIndex]); unmatched = []; }
    let fallthrough: Port[] = [];
    for (let index = 0; index < cases.length; index++) {
      for (const source of fallthrough) edge(source, entries[index]);
      const valueId = field(cases[index], 'value')?.id;
      const result = sequence(cases[index].namedChildren.filter(child => child.id !== valueId), [port(entries[index])]);
      fallthrough = result.normal; abrupt.push(...result.abrupt);
    }
    return { normal: [...unmatched, ...fallthrough, ...abrupt.filter(c => consumes(c, 'break', label)).map(c => c.port)],
      abrupt: abrupt.filter(c => !consumes(c, 'break', label)) };
  }
  function matchStatement(node: Node, incoming: Port[]): Flow {
    const value = expression(field(node, 'value') ?? field(node, 'subject'), incoming);
    const arms = (field(node, 'body')?.namedChildren ?? node.namedChildren).filter(n => ['match_arm', 'case_clause'].includes(n.type));
    let unmatched = value.normal;
    const result: Flow = { normal: [], abrupt: [...value.abrupt] };
    for (const arm of arms) {
      const pattern = field(arm, 'pattern') ?? arm.namedChildren.find(n => n.type === 'case_pattern');
      const guard = pattern ? field(pattern, 'condition') ?? field(arm, 'guard') : field(arm, 'guard');
      const wildcard = pattern?.text === '_';
      const test = emit('condition', pattern ?? arm, unmatched, `pattern ${pattern?.text ?? '?'}`);
      if (!wildcard) decision(arm);
      let matched = [port(test, 'true')];
      unmatched = wildcard ? [] : [port(test, 'false')];
      if (guard) {
        const checked = expression(guard, matched);
        const guardTest = emit('condition', guard, checked.normal);
        decision(guard); result.abrupt.push(...checked.abrupt);
        matched = [port(guardTest, 'true')]; unmatched.push(port(guardTest, 'false'));
      }
      const body = field(arm, 'value') ?? field(arm, 'consequence') ?? field(arm, 'body') ?? arm.namedChildren.find(n => n.type === 'block');
      const next = body ? statement(body, matched) : plain(matched);
      result.normal.push(...next.normal); result.abrupt.push(...next.abrupt);
    }
    if (language === 'python') result.normal.push(...unmatched);
    else if (unmatched.length) diagnostic(node, 'Rust exhaustiveness cannot be proved without type information');
    return result;
  }

  function statement(node: Node, incoming: Port[], label?: string): Flow {
    if (node.type === 'comment' || node.type === 'empty_statement') return plain(incoming);
    if (['statement_block', 'block', 'else_clause', 'finally_clause', 'unsafe_block'].includes(node.type)) return sequence(node.namedChildren, incoming);
    if (node.type === 'expression_statement') return expression(node.namedChild(0), incoming);
    if (node.type === 'labeled_statement') {
      const name = field(node, 'label')!.text;
      const body = statement(field(node, 'body')!, incoming, name);
      return { normal: [...body.normal, ...body.abrupt.filter(c => c.kind === 'break' && c.label === name).map(c => c.port)],
        abrupt: body.abrupt.filter(c => c.kind !== 'break' || c.label !== name) };
    }
    if (node.type === 'if_statement' && language === 'python') {
      const value = expression(field(node, 'condition'), incoming);
      const test = emit('condition', field(node, 'condition')!, value.normal);
      decision(node);
      const yes = statement(field(node, 'consequence')!, [port(test, 'true')]);
      const no = alternatives(node.namedChildren.filter(n => ['elif_clause', 'else_clause'].includes(n.type)), [port(test, 'false')]);
      return { normal: [...yes.normal, ...no.normal], abrupt: [...value.abrupt, ...yes.abrupt, ...no.abrupt] };
    }
    if (node.type === 'if_statement' || node.type === 'if_expression') return branch(node, field(node, 'condition'), field(node, 'consequence'), field(node, 'alternative'), incoming);
    if (['while_statement', 'do_statement', 'for_statement', 'for_in_statement', 'while_expression', 'loop_expression', 'for_expression'].includes(node.type)) {
      return loop(node, incoming, label ?? jumpLabel(node));
    }
    if (node.type === 'try_statement') return tryStatement(node, incoming);
    if (node.type === 'with_statement' && language === 'python') return withStatement(node, incoming);
    if (node.type === 'switch_statement') return switchStatement(node, incoming, label);
    if (node.type === 'match_expression' || node.type === 'match_statement') return matchStatement(node, incoming);
    const abruptKind = new Map<string, Completion['kind']>([
      ['return_statement', 'return'], ['return_expression', 'return'], ['throw_statement', 'throw'], ['raise_statement', 'throw'],
      ['break_statement', 'break'], ['break_expression', 'break'], ['continue_statement', 'continue'], ['continue_expression', 'continue'],
    ]).get(node.type);
    if (abruptKind) {
      const operand = node.namedChildren.filter(n => !['label', 'statement_identifier'].includes(n.type));
      const value = sequence(operand, incoming);
      const id = emit(abruptKind, node, value.normal);
      return { normal: [], abrupt: [...value.abrupt, { kind: abruptKind, port: port(id, abruptKind), label: jumpLabel(node) }] };
    }
    if (node.type === 'assert_statement') {
      const value = expression(node.namedChild(0), incoming);
      const test = emit('condition', node, value.normal);
      decision(node);
      const message = expression(node.namedChild(1), [port(test, 'false')]);
      return { normal: [port(test, 'true')], abrupt: [...value.abrupt, ...message.abrupt,
        ...message.normal.map(source => ({ kind: 'throw' as const, port: source }))] };
    }
    if (node.type.endsWith('_statement') && !['global_statement', 'nonlocal_statement', 'pass_statement', 'delete_statement',
      'import_statement', 'import_from_statement', 'export_statement', 'debugger_statement'].includes(node.type)) {
      diagnostic(node, `Statement is not lowered: ${node.type}`);
    }
    return expression(node, incoming);
  }

  try {
    emit('entry', callable, [], 'entry'); emit('exit', callable, [], 'normal exit'); emit('exception-exit', callable, [], 'exception exit');
    const body = field(callable, 'body');
    if (!body) diagnostic(callable, 'Function body is absent');
    if (body && ((callable.type === 'arrow_function' && body.type !== 'statement_block') || callable.type === 'lambda' || language === 'rust')) {
      const implicit = tailValue(body);
      if (implicit) graph.implicitReturnSource = span(implicit);
    }
    let start = plain([port(graph.entry)]);
    if (language === 'typescript') for (const parameter of field(callable, 'parameters')?.namedChildren ?? []) {
      const value = field(parameter, 'value');
      if (!value) continue;
      const test = emit('condition', parameter, start.normal, 'parameter is undefined');
      decision(parameter);
      const initialized = expression(value, [port(test, 'true')]);
      const bound = emit('operation', parameter, initialized.normal, 'default parameter binding');
      graph.nodes[bound].binding = 'parameter-default'; graph.nodes[bound].valueSource = span(value);
      start = { normal: [port(test, 'false'), port(bound)], abrupt: [...start.abrupt, ...initialized.abrupt] };
    }
    const bodyFlow = body ? statement(body, start.normal) : plain([]);
    const flow: Flow = { normal: bodyFlow.normal, abrupt: [...start.abrupt, ...bodyFlow.abrupt] };
    for (const source of flow.normal) edge(source, graph.exit);
    for (const completion of flow.abrupt) {
      const conditional = completion.port.kind === 'true' || completion.port.kind === 'false';
      if (completion.kind === 'return') edge(port(completion.port.id, conditional ? completion.port.kind : 'return'), graph.exit);
      else if (completion.kind === 'throw') edge(port(completion.port.id, conditional || completion.port.kind === 'exception' ? completion.port.kind : 'throw'), graph.exceptionExit);
      else diagnostic(callable, `Unmatched ${completion.kind} ${completion.label ?? ''}`, 'invalid-jump');
    }
  } catch (error) {
    if (error !== budgetExceeded) throw error;
    diagnostic(callable, `CFG exceeds ${nodeBudget} nodes`, 'budget-exceeded');
  }
  graph.structuralComplexity = 1 + decisions.size;
  if (graph.nodes.some(node => ['yield', 'yield_expression'].includes(node.astType))) graph.executionKind = 'generator';
  Object.assign(graph, buildBasicBlocks(graph));
  return graph;
}
