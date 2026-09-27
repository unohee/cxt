import type Parser from 'tree-sitter';
import type { ControlFlowGraph, CfgNode, SourceSpan } from '../analysis/cfg.js';
import type { SymbolFacts, SymbolBinding } from '../analysis/symbols.js';
import type { DataExpr, DataflowFacts, FlowLocation, FlowVariable, NodeEffect } from '../analysis/dataflowTypes.js';

type Node = Parser.SyntaxNode;
const field = (node: Node, name: string) => node.childForFieldName(name);
const unknown = (sources?: DataExpr[]): DataExpr => ({ kind: 'unknown', sources });
export const temporaryKey = (span: Pick<SourceSpan, 'startOffset' | 'endOffset'>) => `${span.startOffset}:${span.endOffset}`;
const keyOf = (node: Node) => `${node.startIndex}:${node.endIndex}`;
const temporary = (node: Node | null): DataExpr => node ? { kind: 'temporary', key: keyOf(node) } : unknown();

/** 파일별 AST index를 한 번 만들고 각 CFG에 scope를 반영한 effect를 붙인다. */
export function attachDataflowFacts(root: Node, symbols: SymbolFacts, graphs: ControlFlowGraph[]): void {
  const index = new Map<string, Node>();
  const typedIndex = new Map<string, Node>();
  const bindings = new Map<string, SymbolBinding[]>();
  for (const binding of symbols.bindings) {
    const key = `${binding.scope}:${binding.name}`;
    bindings.set(key, [...bindings.get(key) ?? [], binding]);
  }
  const nodes: Node[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!; nodes.push(node); index.set(keyOf(node), node); typedIndex.set(`${node.type}:${keyOf(node)}`, node);
    pending.push(...node.namedChildren.slice().reverse());
  }
  const scopesBySize = [...symbols.scopes].sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset) || b.id - a.id);
  const scopeAt = (node: Node) => scopesBySize.find(s => s.startOffset <= node.startIndex && s.endOffset >= node.endIndex)?.id ?? 0;
  function functionScope(scope: number): number {
    while (symbols.scopes[scope].kind !== 'function' && symbols.scopes[scope].parent !== null) scope = symbols.scopes[scope].parent!;
    return scope;
  }
  function bindingScope(node: Node, name: string, declaration = false): number {
    if (declaration) {
      const declared = symbols.bindings.find(b => b.name === name && b.offset === node.startIndex);
      if (declared) return declared.scope;
    }
    let scope = scopeAt(node);
    const origin = scope;
    while (true) {
      const frame = symbols.scopes[scope];
      if (frame.redirects?.[name] !== undefined) return frame.redirects[name];
      if ((scope === origin || frame.kind !== 'class') && bindings.has(`${scope}:${name}`)) return scope;
      if (frame.parent === null) return 0;
      scope = frame.parent;
    }
  }
  const variableKey = (scope: number, name: string) => `${symbols.filePath}#${scope}:${name}`;
  const captured = new Set<string>();
  for (const node of nodes.filter(n => ['identifier', 'self', 'this'].includes(n.type))) {
    const scope = bindingScope(node, node.text);
    if (functionScope(scopeAt(node)) !== functionScope(scope)) captured.add(variableKey(scope, node.text));
  }

  for (const graph of graphs) {
    const ownScope = symbols.scopes.find(s => s.owner === graph.owner && s.kind === 'function')?.id;
    if (ownScope === undefined) continue;
    const facts: DataflowFacts = { variables: [], effects: {}, diagnostics: [] };
    const variables = new Map<string, FlowVariable>();
    function variable(node: Node, name: string, declaration = false, forcedScope?: number): DataExpr & { kind: 'variable' } {
      const scope = forcedScope ?? bindingScope(node, name, declaration), key = variableKey(scope, name);
      if (!variables.has(key)) {
        const declared = bindings.get(`${scope}:${name}`) ?? [];
        const owned = functionScope(scope) === ownScope;
        const parameter = owned && scope === ownScope && declared.some(b => b.isParameter);
        let initial: DataExpr = owned && !parameter ? { kind: 'uninitialized' } : unknown();
        const hoisted = declared.find(b => b.hoisted && b.value.kind === 'entity');
        if (hoisted?.value.kind === 'entity') initial = { kind: 'entity', target: hoisted.value.qualifiedName };
        for (const binding of declared) {
          const syntax = nodes.find(n => n.startIndex === binding.offset && n.type === 'variable_declarator');
          if (syntax?.parent?.type === 'variable_declaration') initial = { kind: 'undefined' };
          const loop = nodes.find(n => n.startIndex === binding.offset && n.type === 'for_in_statement');
          if (loop?.children.some(child => child.type === 'var')) initial = { kind: 'undefined' };
        }
        variables.set(key, { key, name, scope, category: owned ? parameter ? 'parameter' : 'local' : 'external', initial, captured: captured.has(key) });
      }
      return { kind: 'variable', key };
    }
    for (const binding of symbols.bindings.filter(b => functionScope(b.scope) === ownScope)) {
      const source = nodes.find(n => n.startIndex === binding.offset) ?? root;
      // Parameter offsets are synthetic zero; use the owner node to retain its scope.
      const ownNode = nodes.find(n => n.startIndex === symbols.scopes[ownScope].startOffset && n.endIndex === symbols.scopes[ownScope].endOffset) ?? source;
      variable(binding.offset === 0 ? ownNode : source, binding.name, true, binding.scope);
    }
    const diagnose = (node: CfgNode, message: string) => {
      if (!facts.diagnostics.some(d => d.node === node.id && d.message === message)) facts.diagnostics.push({ code: 'unsupported-effect', node: node.id, message });
    };
    function property(node: Node | null): string {
      if (!node) return '*';
      if (['identifier', 'property_identifier', 'field_identifier', 'integer', 'number'].includes(node.type)) return node.text;
      if (node.type === 'string' && !node.text.includes('\\')) return node.text.slice(1, -1);
      return '*';
    }
    function location(node: Node, declarationNode?: Node): FlowLocation | undefined {
      if (['identifier', 'shorthand_property_identifier_pattern', 'self', 'this'].includes(node.type)) {
        return variable(declarationNode ?? node, node.text, !!declarationNode);
      }
      if (['member_expression', 'attribute', 'field_expression', 'subscript_expression', 'subscript'].includes(node.type)) {
        const object = field(node, 'object') ?? field(node, 'value');
        const member = field(node, 'property') ?? field(node, 'attribute') ?? field(node, 'field');
        const subscript = field(node, 'index') ?? field(node, 'subscript');
        // A computed identifier is not a literal field name.
        return { kind: 'member', object: temporary(object), property: member ? property(member)
          : subscript && ['string', 'number', 'integer'].includes(subscript.type) ? property(subscript) : '*' };
      }
      return undefined;
    }
    function atom(node: Node): DataExpr {
      if (['true', 'false', 'boolean_literal'].includes(node.type)) return { kind: 'literal', value: ['true', 'True'].includes(node.text) };
      if (node.type === 'null' || node.type === 'none') return { kind: 'null' };
      if (node.type === 'undefined') return { kind: 'undefined' };
      if (['number', 'integer', 'integer_literal', 'float', 'float_literal'].includes(node.type)) {
        const value = Number(node.text.replaceAll('_', ''));
        return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? { kind: 'literal', value } : { kind: 'non-null', type: 'number' };
      }
      if (['string', 'string_literal', 'raw_string_literal', 'template_string'].includes(node.type)) {
        const quoted = ['"', "'"].includes(node.text[0]) && node.text.at(-1) === node.text[0];
        return quoted && !node.text.includes('\\') && !node.text.startsWith(node.text[0].repeat(3))
          && !node.namedChildren.some(child => ['interpolation', 'template_substitution'].includes(child.type))
          ? { kind: 'literal', value: node.text.slice(1, -1) } : { kind: 'non-null', type: 'string', sources: node.namedChildren.map(temporary) };
      }
      if (['unit_expression', 'unit_type'].includes(node.type)) return { kind: 'unit' };
      if (['identifier', 'self', 'this'].includes(node.type)) return variable(node, node.text);
      return unknown(node.namedChildren.map(temporary));
    }
    function expression(node: Node, cfgNode: CfgNode): DataExpr {
      const member = location(node);
      if (member?.kind === 'member') return member;
      if (['call', 'call_expression'].includes(node.type)) return { kind: 'call', callee: temporary(field(node, 'function')),
        arguments: field(node, 'arguments')?.namedChildren.map(temporary) ?? [] };
      if (['object', 'dictionary', 'array', 'list', 'tuple', 'tuple_expression', 'array_expression', 'new_expression'].includes(node.type)) {
        const fields: Array<[string, DataExpr]> = [];
        let open = node.type === 'new_expression' || node.type === 'object' || node.type === 'array';
        const spread = node.namedChildren.some(child => ['spread_element', 'list_splat', 'dictionary_splat'].includes(child.type));
        if (spread) {
          diagnose(cfgNode, `Spread allocation shape is conservative: ${node.type}`);
          return { kind: 'allocation', id: `${graph.owner}@${keyOf(node)}`, fields: [['*', unknown(node.namedChildren.map(temporary))]], open: true };
        }
        let arrayIndex = 0;
        const arrayIndices = new Map<number, number>();
        for (const child of node.children) {
          if (child.type === ',') arrayIndex++;
          else if (child.isNamed) arrayIndices.set(child.id, arrayIndex);
        }
        for (const [index, item] of node.namedChildren.entries()) {
          if (item.type === 'pair') fields.push([property(field(item, 'key')), temporary(field(item, 'value'))]);
          else if (['shorthand_property_identifier', 'shorthand_property_identifier_pattern'].includes(item.type)) fields.push([item.text, variable(item, item.text)]);
          else if (['array', 'list', 'tuple', 'tuple_expression', 'array_expression'].includes(node.type)) fields.push([String(arrayIndices.get(item.id) ?? index), temporary(item)]);
          else open = true;
        }
        return { kind: 'allocation', id: `${graph.owner}@${keyOf(node)}`, fields, open };
      }
      if (['binary_expression', 'binary_operator', 'comparison_operator', 'boolean_operator'].includes(node.type)) {
        const operator = field(node, 'operator')?.text ?? node.children.find(n => !n.isNamed)?.text;
        const left = field(node, 'left') ?? node.namedChild(0), right = field(node, 'right') ?? node.namedChild(1);
        return operator && left && right ? { kind: 'binary', operator, left: temporary(left), right: temporary(right) } : unknown(node.namedChildren.map(temporary));
      }
      if (['unary_expression', 'unary_operator', 'not_operator'].includes(node.type)) return {
        kind: 'unary', operator: field(node, 'operator')?.text ?? node.children[0].text,
        value: temporary(field(node, 'argument') ?? node.namedChild(0)) };
      if (['parenthesized_expression', 'as_expression', 'non_null_expression', 'type_cast_expression'].includes(node.type)) return temporary(node.namedChild(0));
      if (['await_expression', 'await', 'try_expression'].includes(node.type)) return unknown(node.namedChildren.map(temporary));
      if (['function_declaration', 'function_expression', 'arrow_function', 'function_definition', 'lambda', 'function_item', 'closure_expression', 'class_declaration', 'class_definition'].includes(node.type)) {
        const entity = symbols.entities.find(e => symbols.scopes[e.bodyScope ?? -1]?.startOffset === node.startIndex);
        return entity ? { kind: 'entity', target: entity.qualifiedName } : { kind: 'non-null', type: 'function' };
      }
      if (node.type === 'assignment_expression' || node.type === 'assignment' || node.type === 'variable_declarator' || node.type === 'let_declaration') {
        return temporary(field(node, 'value') ?? field(node, 'right'));
      }
      if (node.type.endsWith('_pattern') && node.namedChildren.length) diagnose(cfgNode, `Pattern effect is not lowered: ${node.type}`);
      return atom(node);
    }
    function writePattern(pattern: Node | null, value: DataExpr, node: Node, cfgNode: CfgNode, effect: NodeEffect): void {
      if (!pattern) return;
      const target = location(pattern, pattern.type === 'identifier' ? node : undefined);
      if (target) { effect.writes.push({ target, value }); return; }
      if (['tuple_pattern', 'list_pattern', 'array_pattern', 'pattern_list'].includes(pattern.type)) {
        pattern.namedChildren.forEach((item, index) => writePattern(item, { kind: 'member', object: value, property: String(index) }, node, cfgNode, effect));
        return;
      }
      if (pattern.type === 'object_pattern') {
        for (const item of pattern.namedChildren) {
          const name = field(item, 'key') ?? item;
          writePattern(field(item, 'value') ?? item, { kind: 'member', object: value, property: property(name) }, node, cfgNode, effect);
        }
        return;
      }
      diagnose(cfgNode, `Binding pattern is not lowered: ${pattern.type}`);
    }
    for (const cfgNode of graph.nodes) {
      if (!['operation', 'condition', 'return', 'throw', 'suspend'].includes(cfgNode.kind)) continue;
      const syntax = typedIndex.get(`${cfgNode.astType}:${temporaryKey(cfgNode.span)}`) ?? index.get(temporaryKey(cfgNode.span));
      if (!syntax) { diagnose(cfgNode, 'AST node for CFG effect is absent'); continue; }
      const effect: NodeEffect = { resultKey: temporaryKey(cfgNode.span), value: unknown(), writes: [], deletes: [], mayCall: false };
      facts.effects[cfgNode.id] = effect;
      if (cfgNode.constantValue) { effect.value = { kind: cfgNode.constantValue }; continue; }
      if (cfgNode.valueSource && !cfgNode.binding) { effect.value = { kind: 'temporary', key: temporaryKey(cfgNode.valueSource) }; continue; }
      if (cfgNode.binding) {
        const pattern = cfgNode.binding === 'iteration' ? field(syntax, 'left') ?? field(syntax, 'pattern')
          : cfgNode.binding.startsWith('exception') ? field(syntax, 'parameter') ?? field(field(syntax, 'value') ?? syntax, 'alias')?.namedChild(0)
            : field(syntax, 'pattern') ?? field(syntax, 'name');
        const value: DataExpr = cfgNode.valueSource ? { kind: 'temporary', key: temporaryKey(cfgNode.valueSource) }
          : cfgNode.binding === 'iteration' ? unknown([temporary(field(syntax, 'right') ?? field(syntax, 'value'))])
            : cfgNode.binding === 'exception' ? { kind: 'exception' } : unknown();
        writePattern(pattern ?? null, value, syntax, cfgNode, effect);
        if (cfgNode.binding === 'exception-clear') {
          effect.deletes = effect.writes.flatMap(write => write.target.kind === 'variable' ? [write.target.key] : []); effect.writes = [];
        }
        effect.value = value; continue;
      }
      if (cfgNode.kind === 'condition') {
        if (['match_pattern', 'case_pattern', 'let_condition'].includes(syntax.type)) diagnose(cfgNode, `Pattern constraints and bindings are not lowered: ${syntax.type}`);
        effect.value = expression(syntax, cfgNode);
        if (cfgNode.text === 'receiver is nullish') effect.value = { kind: 'unary', operator: 'nullish', value: temporary(field(syntax, 'object') ?? field(syntax, 'function')) };
        else if (cfgNode.text === 'is nullish') effect.value = { kind: 'unary', operator: 'nullish', value: temporary(field(syntax, 'left')) };
        else if (cfgNode.text === 'parameter is undefined') {
          const name = field(syntax, 'pattern') ?? field(syntax, 'name');
          effect.value = name?.type === 'identifier' ? { kind: 'unary', operator: 'undefined', value: variable(syntax, name.text) } : unknown();
        } else if (['Try::branch', 'iterator has next', 'catch all'].includes(cfgNode.text) || ['match_pattern', 'case_pattern', 'switch_case', 'except_clause'].includes(syntax.type)) effect.value = unknown();
        else if (syntax.children.some(n => ['&&', '||', 'and', 'or', '&&=', '||=', '??='].includes(n.type)) && field(syntax, 'left')) effect.value = temporary(field(syntax, 'left'));
        effect.guard = effect.value; continue;
      }
      if (cfgNode.kind === 'return' || cfgNode.kind === 'throw') {
        if (cfgNode.kind === 'throw' && !syntax.namedChild(0)) diagnose(cfgNode, 'Dynamic rethrow context is not modeled');
        effect.value = syntax.namedChild(0) ? temporary(syntax.namedChild(0)) : cfgNode.kind === 'throw' ? { kind: 'exception' }
          : { kind: symbols.language === 'python' ? 'null' : symbols.language === 'rust' ? 'unit' : 'undefined' };
        continue;
      }
      if (cfgNode.kind === 'suspend') { effect.value = unknown(syntax.namedChildren.map(temporary)); effect.mayCall = true; continue; }
      effect.value = expression(syntax, cfgNode);
      if (['with_item', 'with_clause', 'let_condition'].includes(syntax.type)) diagnose(cfgNode, `Binding or lifecycle effect is not lowered: ${syntax.type}`);
      effect.mayCall = ['call', 'call_expression', 'new_expression'].includes(syntax.type);
      if (symbols.language === 'typescript' && syntax.type === 'call_expression' && field(syntax, 'function')?.text === 'eval') effect.mayMutateLocals = true;
      if (cfgNode.text === 'iterator next' || cfgNode.text.startsWith('__enter__') || cfgNode.text.startsWith('__exit__')) effect.mayCall = true;
      if (syntax.type === 'delete_statement' || (syntax.type === 'unary_expression' && syntax.children[0].type === 'delete')) {
        const targets = syntax.type === 'delete_statement' ? syntax.namedChildren : [field(syntax, 'argument') ?? syntax.namedChild(0)];
        for (const target of targets) {
          if (!target) continue;
          if (symbols.language === 'python' && target.type === 'identifier') effect.deletes.push(variable(target, target.text).key);
          else if (location(target)?.kind === 'member') effect.mayCall = true;
          else if (symbols.language === 'python') { diagnose(cfgNode, `Delete pattern is not lowered: ${target.type}`); effect.mayCall = true; }
        }
        effect.value = unknown();
      }
      if (['function_declaration', 'generator_function_declaration', 'class_declaration', 'class_definition', 'function_definition', 'function_item'].includes(syntax.type)) {
        writePattern(field(syntax, 'name'), effect.value, syntax, cfgNode, effect);
      }
      if (['variable_declarator', 'let_declaration', 'assignment', 'assignment_expression', 'augmented_assignment_expression', 'augmented_assignment', 'named_expression'].includes(syntax.type)) {
        const pattern = field(syntax, 'name') ?? field(syntax, 'pattern') ?? field(syntax, 'left');
        const value = field(syntax, 'value') ?? field(syntax, 'right');
        let result: DataExpr = value ? temporary(value) : symbols.language === 'typescript' ? { kind: 'undefined' } : { kind: 'uninitialized' };
        const operator = field(syntax, 'operator')?.text ?? syntax.children.find(n => n.type.endsWith('=') && n.type !== '=')?.type;
        if (operator?.endsWith('=') && !['=', '&&=', '||=', '??='].includes(operator)) {
          result = { kind: 'binary', operator: operator.slice(0, -1), left: temporary(pattern), right: result };
        }
        if (value || symbols.language !== 'python') writePattern(pattern, result, syntax, cfgNode, effect);
        effect.value = result;
      }
      if (syntax.type === 'update_expression') {
        const argument = field(syntax, 'argument');
        const operator = syntax.children.find(n => ['++', '--'].includes(n.type))?.type;
        const previous = temporary(argument);
        const value: DataExpr = { kind: 'binary', operator: operator === '--' ? '-' : '+', left: previous, right: { kind: 'literal', value: 1 } };
        writePattern(argument, value, syntax, cfgNode, effect);
        effect.value = ['++', '--'].includes(syntax.children[0].type) ? value : previous;
      }
      // 일반 대입의 LHS 이름은 값을 읽는 식이 아니라 쓰기 위치다.
      if (syntax.type === 'identifier' && syntax.parent && field(syntax.parent, 'left')?.id === syntax.id
        && ['assignment', 'assignment_expression'].includes(syntax.parent.type)) effect.value = unknown();
      if (syntax.type === 'identifier') {
        let parent = syntax.parent;
        while (parent && ['pattern_list', 'tuple_pattern', 'list_pattern', 'array_pattern', 'object_pattern', 'pair_pattern'].includes(parent.type)) parent = parent.parent;
        const left = parent && ['assignment', 'assignment_expression'].includes(parent.type) ? field(parent, 'left') : null;
        if (left && left.startIndex <= syntax.startIndex && syntax.endIndex <= left.endIndex) effect.value = unknown();
      }
      if (effect.value.kind === 'member' && syntax.parent && field(syntax.parent, 'left')?.id === syntax.id
        && ['assignment', 'assignment_expression'].includes(syntax.parent.type)) effect.value = effect.value.object;
    }
    facts.variables = [...variables.values()];
    graph.dataflow = facts;
  }
}
