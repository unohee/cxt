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
  const firstAtOffset = new Map<number, Node>();
  const typedAtOffset = new Map<string, Node>();
  const declarationScopes = new Map<string, number>();
  const bindings = new Map<string, SymbolBinding[]>();
  for (const binding of symbols.bindings) {
    const key = `${binding.scope}:${binding.name}`;
    bindings.set(key, [...bindings.get(key) ?? [], binding]);
    const declarationKey = `${binding.offset}:${binding.name}`;
    if (!declarationScopes.has(declarationKey)) declarationScopes.set(declarationKey, binding.scope);
  }
  const nodes: Node[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!; nodes.push(node); index.set(keyOf(node), node); typedIndex.set(`${node.type}:${keyOf(node)}`, node);
    if (!firstAtOffset.has(node.startIndex)) firstAtOffset.set(node.startIndex, node);
    const typedKey = `${node.type}:${node.startIndex}`;
    if (!typedAtOffset.has(typedKey)) typedAtOffset.set(typedKey, node);
    pending.push(...node.namedChildren.slice().reverse());
  }
  const rustCopyTypes = new Set<string>(symbols.copyTypes ?? []);
  if (symbols.language === 'rust') {
    for (const node of nodes.filter(node => node.type === 'impl_item')) {
      const trait = field(node, 'trait'), type = field(node, 'type');
      if (trait?.text === 'Copy' && type?.text) rustCopyTypes.add(type.text);
    }
  }
  const scopesBySize = [...symbols.scopes].sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset) || b.id - a.id);
  const nodeScopes = new Map<number, number>();
  const scopeAt = (node: Node) => {
    const existing = nodeScopes.get(node.id);
    if (existing !== undefined) return existing;
    const start = node.startIndex, end = node.endIndex;
    const scope = scopesBySize.find(s => s.startOffset <= start && s.endOffset >= end)?.id ?? 0;
    nodeScopes.set(node.id, scope); return scope;
  };
  const functionScopes = new Map<number, number>();
  function functionScope(scope: number): number {
    const existing = functionScopes.get(scope);
    if (existing !== undefined) return existing;
    const initial = scope;
    while (symbols.scopes[scope].kind !== 'function' && symbols.scopes[scope].parent !== null) scope = symbols.scopes[scope].parent!;
    functionScopes.set(initial, scope);
    return scope;
  }
  function bindingScope(node: Node, name: string, declaration = false): number {
    if (declaration) {
      const declared = declarationScopes.get(`${node.startIndex}:${name}`);
      if (declared !== undefined) return declared;
    }
    let scope = scopeAt(node);
    const origin = scope;
    while (true) {
      const frame = symbols.scopes[scope];
      if (frame.redirects?.[name] !== undefined) return frame.redirects[name];
      if (!frame.memberOnly && (scope === origin || frame.kind !== 'class') && bindings.has(`${scope}:${name}`)) return scope;
      if (frame.parent === null) return 0;
      scope = frame.parent;
    }
  }
  const variableKey = (scope: number, name: string) => `${symbols.filePath}#${scope}:${name}`;
  const ownedBindings = new Map<number, SymbolBinding[]>();
  for (const binding of symbols.bindings) {
    const owner = functionScope(binding.scope);
    ownedBindings.set(owner, [...ownedBindings.get(owner) ?? [], binding]);
  }
  const ownerScopes = new Map(symbols.scopes.filter(s => s.kind === 'function' && s.owner).map(s => [s.owner, s.id]));
  const entitiesAtOffset = new Map(symbols.entities.filter(e => e.bodyScope !== undefined).map(e => [symbols.scopes[e.bodyScope!].startOffset, e]));
  const captured = new Set<string>();
  for (const node of nodes.filter(n => ['identifier', 'self', 'this'].includes(n.type))) {
    const scope = bindingScope(node, node.text);
    if (functionScope(scopeAt(node)) !== functionScope(scope)) captured.add(variableKey(scope, node.text));
  }

  for (const graph of graphs) {
    const ownScope = ownerScopes.get(graph.owner);
    if (ownScope === undefined) continue;
    const facts: DataflowFacts = { variables: [], effects: {}, diagnostics: [],
      parameters: symbols.scopes[ownScope].parameters?.map(p => ({ ...p, key: p.name ? variableKey(ownScope, p.name) : undefined })) };
    if (symbols.language === 'python') {
      const exceptionParents: Record<string, string[]> = {};
      for (const base of symbols.bases) {
        const child = base.entity.split('::').at(-1);
        const parent = base.type.kind === 'name' ? base.type.name : base.type.kind === 'type' ? base.type.name : undefined;
        if (child && parent) exceptionParents[child] = [...new Set([...(exceptionParents[child] ?? []), parent])];
      }
      if (Object.keys(exceptionParents).length) facts.exceptionParents = exceptionParents;
    }
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
          const syntax = typedAtOffset.get(`variable_declarator:${binding.offset}`);
          if (syntax?.parent?.type === 'variable_declaration') initial = { kind: 'undefined' };
          const loop = typedAtOffset.get(`for_in_statement:${binding.offset}`);
          if (loop?.children.some(child => child.type === 'var')) initial = { kind: 'undefined' };
        }
        const parameterInfo = parameter ? facts.parameters?.find(item => item.name === name) : undefined;
        variables.set(key, { key, name, scope, category: owned ? parameter ? 'parameter' : 'local' : 'external', initial,
          captured: captured.has(key), ...(parameterInfo?.typeName ? { typeName: parameterInfo.typeName } : {}),
          ...(parameterInfo?.copy || parameterInfo?.typeName && symbols.copyTypes?.includes(parameterInfo.typeName) ? { copy: true } : {}) });
      }
      return { kind: 'variable', key };
    }
    for (const binding of ownedBindings.get(ownScope) ?? []) {
      const source = firstAtOffset.get(binding.offset) ?? root;
      // synthetic parameter/handler offset도 명시적 binding scope를 따른다.
      variable(source, binding.name, true, binding.scope);
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
      if (['identifier', 'as_pattern_target', 'shorthand_property_identifier_pattern', 'self', 'this'].includes(node.type)) {
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
          ? { kind: 'literal', value: node.text.slice(1, -1) } : { kind: 'non-null', type: 'string',
            sources: node.namedChildren.filter(child => ['interpolation', 'template_substitution'].includes(child.type)).map(temporary) };
      }
      if (['unit_expression', 'unit_type'].includes(node.type)) return { kind: 'unit' };
      if (['identifier', 'self', 'this'].includes(node.type)) return variable(node, node.text);
      return unknown(node.namedChildren.map(temporary));
    }
    function rustCopyLiteral(node: Node): boolean {
      if (['true', 'false', 'boolean_literal', 'integer', 'integer_literal', 'float', 'float_literal', 'char_literal'].includes(node.type)) return true;
      if (node.type === 'reference_expression') return true;
      if (['parenthesized_expression', 'as_expression', 'type_cast_expression'].includes(node.type)) {
        const child = node.namedChild(0); return !!child && rustCopyLiteral(child);
      }
      if (['tuple_expression', 'array_expression'].includes(node.type)) return node.namedChildren.every(rustCopyLiteral);
      if (node.type === 'struct_expression') {
        const type = field(node, 'type') ?? node.namedChild(0); return !!type && rustCopyTypes.has(type.text);
      }
      return false;
    }
    function expression(node: Node, cfgNode: CfgNode): DataExpr {
      const member = location(node);
      if (member?.kind === 'member') return member;
      if (['call', 'call_expression'].includes(node.type)) {
        const callee = field(node, 'function');
        const arguments_ = field(node, 'arguments')?.namedChildren ?? [];
        const argumentValue = (argument: Node) => argument.type === 'keyword_argument'
          ? field(argument, 'value') ?? argument.namedChild(1) ?? argument : argument;
        const member = callee && location(callee);
        return { kind: 'call', callee: temporary(callee), arguments: arguments_.map(argument => temporary(argumentValue(argument))),
          argumentNames: arguments_.map(argument => argument.type === 'keyword_argument'
            ? field(argument, 'name')?.text ?? argument.namedChild(0)?.text
            : ['identifier', 'type_identifier', 'constant'].includes(argument.type) ? argument.text : undefined),
          keywordArguments: arguments_.map(argument => argument.type === 'keyword_argument'),
          argumentsKnown: !arguments_.some(n => ['spread_element', 'list_splat', 'dictionary_splat'].includes(n.type)),
          // Keep the receiver as a real expression. The member location uses a
          // temporary for assignment lowering, but a call's receiver must be
          // evaluable at the call site for framework state tracking.
          receiver: member?.kind === 'member' && callee ? atom(field(callee, 'object') ?? callee) : undefined };
      }
      // `new Function(...)` is a dynamic-code sink just like the callable
      // global. Lower this one constructor shape to a call so the regular
      // external model and taint provenance machinery can apply. Other
      // constructors retain their allocation semantics below.
      if (node.type === 'new_expression') {
        const callee = field(node, 'constructor') ?? field(node, 'function') ?? node.namedChild(0);
        const arguments_ = field(node, 'arguments')?.namedChildren ?? [];
        if (callee?.type === 'identifier' && ['Function', 'URL'].includes(callee.text)) {
          return { kind: 'call', callee: temporary(callee), arguments: arguments_.map(temporary),
            argumentNames: arguments_.map(argument => ['identifier', 'type_identifier', 'constant'].includes(argument.type) ? argument.text : undefined),
            keywordArguments: arguments_.map(argument => argument.type === 'keyword_argument'),
            argumentsKnown: !arguments_.some(n => ['spread_element', 'keyword_argument', 'list_splat', 'dictionary_splat'].includes(n.type)) };
        }
      }
      if (['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression'].includes(node.type)) {
        const sources: Node[] = [];
        // Preserve value dependence from the iterable, element, and filter
        // expressions even when the comprehension result itself is abstract.
        // The CFG owns execution order; these source temporaries carry the
        // parameter/taint provenance into the result value.
        for (const child of node.namedChildren) {
          if (child.type === 'for_in_clause') sources.push(field(child, 'right') ?? child.namedChild(1) ?? child);
          else if (child.type === 'if_clause') sources.push(child.namedChild(0) ?? child);
          else sources.push(child);
        }
        const pending = [...node.namedChildren];
        while (pending.length) {
          const child = pending.pop()!;
          if (['call', 'call_expression', 'new_expression', 'member_expression', 'attribute', 'subscript', 'subscript_expression'].includes(child.type)) sources.push(child);
          pending.push(...child.namedChildren);
        }
        return unknown(sources.map(temporary));
      }
      if (['object', 'dictionary', 'array', 'list', 'tuple', 'tuple_expression', 'array_expression', 'new_expression', 'struct_expression'].includes(node.type)) {
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
          else if (item.type === 'field_initializer') fields.push([property(field(item, 'field') ?? item.namedChild(0)), temporary(field(item, 'value') ?? item.namedChild(1))]);
          else if (['shorthand_property_identifier', 'shorthand_property_identifier_pattern'].includes(item.type)) fields.push([item.text, variable(item, item.text)]);
          else if (['array', 'list', 'tuple', 'tuple_expression', 'array_expression'].includes(node.type)) fields.push([String(arrayIndices.get(item.id) ?? index), temporary(item)]);
          else open = true;
        }
        return { kind: 'allocation', id: `${graph.owner}@${keyOf(node)}`, fields, open,
          ...(symbols.language === 'rust' ? {
            copy: rustCopyLiteral(node),
            ...(node.type === 'struct_expression' ? { typeName: (field(node, 'type') ?? node.namedChild(0))?.text } : {}),
          } : {}) };
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
      if (['template_substitution', 'interpolation'].includes(node.type) && node.namedChildren.length === 1) return temporary(node.namedChild(0));
      if (['await_expression', 'await', 'try_expression'].includes(node.type)) return unknown(node.namedChildren.map(temporary));
      if (node.type === 'reference_expression') return { kind: 'unary', operator: 'borrow', value: temporary(field(node, 'value') ?? node.namedChild(0)) };
      if (['function_declaration', 'function_expression', 'arrow_function', 'function_definition', 'lambda', 'function_item', 'closure_expression', 'class_declaration', 'class_definition'].includes(node.type)) {
        const entity = entitiesAtOffset.get(node.startIndex);
        return entity ? { kind: 'entity', target: entity.qualifiedName } : { kind: 'non-null', type: 'function' };
      }
      if (node.type === 'assignment_expression' || node.type === 'assignment' || node.type === 'variable_declarator' || node.type === 'let_declaration') {
        return temporary(field(node, 'value') ?? field(node, 'right'));
      }
      if (node.type.endsWith('_pattern') && node.namedChildren.length) diagnose(cfgNode, `Pattern effect is not lowered: ${node.type}`);
      return atom(node);
    }
    let captureFilter: Set<string> | undefined;
    function captureNames(pattern: Node | null): Set<string> {
      if (!pattern) return new Set();
      if (pattern.type === 'identifier') return pattern.text === '_' ? new Set() : new Set([pattern.text]);
      if (pattern.type === 'union_pattern') {
        const alternatives = pattern.namedChildren.map(captureNames);
        return alternatives.slice(1).reduce((common, names) => new Set([...common].filter(name => names.has(name))), alternatives[0] ?? new Set());
      }
      if (pattern.type === 'dict_pattern') return new Set(pattern.namedChildren.flatMap((child, index) => index % 2 ? [...captureNames(child)] : []));
      return new Set(pattern.namedChildren.flatMap(child => [...captureNames(child)]));
    }
    function writePattern(pattern: Node | null, value: DataExpr, node: Node, cfgNode: CfgNode, effect: NodeEffect): void {
      if (!pattern) return;
      if (pattern.type === 'match_pattern') {
        writePattern(pattern.namedChild(0), value, node, cfgNode, effect);
        return;
      }
      if (pattern.type === 'union_pattern') {
        const common = captureNames(pattern);
        if (common.size) {
          const previous = captureFilter;
          captureFilter = common;
          writePattern(pattern.namedChild(0), value, node, cfgNode, effect);
          captureFilter = previous;
        }
        return;
      }
      if (pattern.type === 'case_pattern') {
        if (pattern.namedChildren.length === 1) writePattern(pattern.namedChild(0), value, node, cfgNode, effect);
        return;
      }
      if (pattern.type === 'dotted_name' && pattern.namedChildren.length === 1) {
        writePattern(pattern.namedChild(0), value, node, cfgNode, effect);
        return;
      }
      if (pattern.type === 'splat_pattern') {
        writePattern(pattern.namedChild(0), value, node, cfgNode, effect);
        return;
      }
      if (pattern.type === 'ref_pattern' || pattern.type === 'reference_pattern') {
        effect.borrowedPattern = true;
        writePattern(pattern.namedChild(0), { kind: 'unary', operator: 'borrow', value }, node, cfgNode, effect);
        return;
      }
      if (pattern.type === 'rest_pattern') {
        // Rest destructuring preserves dependence on the source object/array,
        // but its exact residual shape requires runtime property knowledge.
        writePattern(pattern.namedChild(0), { kind: 'unknown', sources: [value] }, node, cfgNode, effect);
        return;
      }
      if (pattern.type === 'class_pattern') {
        // Positional captures depend on the matched instance. The type's
        // __match_args__ order is not available here, so retain a symbolic
        // positional member while preserving the subject provenance.
        pattern.namedChildren.slice(1).forEach((child, index) => {
          writePattern(child, { kind: 'member', object: value, property: String(index) }, node, cfgNode, effect);
        });
        return;
      }
      if (pattern.type === 'keyword_pattern') {
        const name = pattern.namedChild(0), target = pattern.namedChild(1);
        writePattern(target, { kind: 'member', object: value, property: name?.text ?? '*' }, node, cfgNode, effect);
        return;
      }
      if (pattern.type === 'tuple_struct_pattern') {
        pattern.namedChildren.slice(1).forEach((child, index) => {
          writePattern(child, { kind: 'member', object: value, property: String(index) }, node, cfgNode, effect);
        });
        return;
      }
      if (pattern.type === 'struct_pattern') {
        for (const fieldPattern of pattern.namedChildren.slice(1)) {
          if (fieldPattern.type === 'field_pattern') {
            const fieldName = fieldPattern.namedChild(0), target = fieldPattern.namedChild(1);
            writePattern(target, { kind: 'member', object: value, property: fieldName?.text ?? '*' }, node, cfgNode, effect);
          } else if (fieldPattern.type === 'shorthand_field_identifier') {
            writePattern(fieldPattern, { kind: 'member', object: value, property: fieldPattern.text }, node, cfgNode, effect);
          }
        }
        return;
      }
      if (pattern.type === 'as_pattern') {
        const alias = field(pattern, 'alias') ?? pattern.namedChildren.at(-1);
        writePattern(alias ?? null, value, node, cfgNode, effect);
        return;
      }
      if (pattern.type === 'identifier' && (pattern.text === '_' || symbols.language === 'rust' && /^[A-Z]/.test(pattern.text)
        || captureFilter && !captureFilter.has(pattern.text))) return;
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
      if (pattern.type === 'dict_pattern') {
        const children = pattern.namedChildren;
        for (let index = 0; index + 1 < children.length; index += 2) {
          const key = children[index];
          const target = children[index + 1];
          const propertyName = key.text.replace(/^['\"]|['\"]$/g, '');
          writePattern(target, { kind: 'member', object: value, property: propertyName }, node, cfgNode, effect);
        }
        return;
      }
      diagnose(cfgNode, `Binding pattern is not lowered: ${pattern.type}`);
    }
    for (const cfgNode of graph.nodes) {
      if (!['operation', 'condition', 'return', 'throw', 'suspend', 'cleanup'].includes(cfgNode.kind)) continue;
      const syntax = typedIndex.get(`${cfgNode.astType}:${temporaryKey(cfgNode.span)}`) ?? index.get(temporaryKey(cfgNode.span));
      if (!syntax) { diagnose(cfgNode, 'AST node for CFG effect is absent'); continue; }
      const effect: NodeEffect = { resultKey: temporaryKey(cfgNode.span), value: unknown(), writes: [], deletes: [], mayCall: false };
      facts.effects[cfgNode.id] = effect;
      if (cfgNode.constantValue) { effect.value = { kind: cfgNode.constantValue }; continue; }
      if (cfgNode.kind === 'cleanup' && cfgNode.resourceSource) {
        effect.value = { kind: 'temporary', key: temporaryKey(cfgNode.resourceSource) };
        effect.mayCall = true;
        continue;
      }
      if (cfgNode.valueSource && !cfgNode.binding) { effect.value = { kind: 'temporary', key: temporaryKey(cfgNode.valueSource) }; continue; }
      if (cfgNode.binding) {
        const pattern = cfgNode.binding === 'iteration' ? field(syntax, 'left') ?? field(syntax, 'pattern')
          : cfgNode.binding === 'resource-enter' ? field(field(syntax, 'value') ?? syntax, 'alias')?.namedChild(0)
            : cfgNode.binding.startsWith('exception') ? field(syntax, 'parameter') ?? field(field(syntax, 'value') ?? syntax, 'alias')?.namedChild(0)
            : field(syntax, 'pattern') ?? field(syntax, 'name');
        const value: DataExpr = cfgNode.valueSource ? { kind: 'temporary', key: temporaryKey(cfgNode.valueSource) }
          : cfgNode.binding === 'iteration' ? unknown([temporary(field(syntax, 'right') ?? field(syntax, 'value'))])
            : cfgNode.binding === 'exception' ? { kind: 'exception' } : unknown();
        writePattern(pattern ?? null, value, syntax, cfgNode, effect);
        if (cfgNode.binding === 'resource-enter') diagnose(cfgNode, 'Context-manager return value and ownership lifecycle are not modeled');
        if (cfgNode.binding === 'exception-clear') {
          effect.deletes = effect.writes.flatMap(write => write.target.kind === 'variable' ? [write.target.key] : []); effect.writes = [];
        }
        if (cfgNode.binding === 'resource-enter') {
          const context = field(syntax, 'value') ?? syntax;
          const manager = context.type === 'as_pattern' ? field(context, 'value') ?? context.namedChild(0) : context;
          // The manager expression already has its own CFG nodes. Reuse that
          // temporary here so __enter__ does not execute the factory twice;
          // the `as` target still gets the conservative unknown enter result.
          effect.value = cfgNode.resourceSource ? { kind: 'temporary', key: temporaryKey(cfgNode.resourceSource) } : manager ? expression(manager, cfgNode) : value;
        } else effect.value = value;
        continue;
      }
      if (cfgNode.kind === 'condition') {
        if (syntax.type === 'case_pattern' || syntax.type === 'match_pattern') {
          let predecessor = graph.edges.find(edge => edge.to === cfgNode.id)?.from;
          while (predecessor !== undefined && graph.nodes[predecessor].kind === 'condition') {
            predecessor = graph.edges.find(edge => edge.to === predecessor)?.from;
          }
          const predecessorSyntax = predecessor === undefined ? undefined
            : typedIndex.get(`${graph.nodes[predecessor].astType}:${temporaryKey(graph.nodes[predecessor].span)}`)
              ?? index.get(temporaryKey(graph.nodes[predecessor].span));
          const subject = predecessorSyntax?.type === 'identifier' ? variable(predecessorSyntax, predecessorSyntax.text)
            : predecessor === undefined ? unknown() : { kind: 'temporary' as const, key: temporaryKey(graph.nodes[predecessor].span) };
          effect.value = subject;
          writePattern(syntax.namedChild(0), subject, syntax, cfgNode, effect);
        } else if (syntax.type === 'let_condition') {
          const pattern = syntax.namedChild(0), valueNode = syntax.namedChild(1);
          const subject = valueNode ? expression(valueNode, cfgNode) : unknown();
          effect.value = subject;
          writePattern(pattern, subject, syntax, cfgNode, effect);
        } else effect.value = expression(syntax, cfgNode);
        if (cfgNode.text === 'receiver is nullish') effect.value = { kind: 'unary', operator: 'nullish', value: temporary(field(syntax, 'object') ?? field(syntax, 'function')) };
        else if (cfgNode.text === 'is nullish') effect.value = { kind: 'unary', operator: 'nullish', value: temporary(field(syntax, 'left')) };
        else if (cfgNode.text === 'parameter is undefined') {
          const name = field(syntax, 'pattern') ?? field(syntax, 'name');
          effect.value = name?.type === 'identifier' ? { kind: 'unary', operator: 'undefined', value: variable(syntax, name.text) } : unknown();
        } else if (cfgNode.text.startsWith('exception matches ') || cfgNode.text.startsWith('exception group matches ')) {
          const prefix = cfgNode.text.startsWith('exception group matches ') ? 'exception group matches ' : 'exception matches ';
          effect.value = { kind: 'exception-match', type: cfgNode.text.slice(prefix.length).trim().split(/\s+as\s+/i, 1)[0] };
        }
        else if (['Try::branch', 'iterator has next', 'catch all'].includes(cfgNode.text) || ['switch_case', 'except_clause'].includes(syntax.type)) effect.value = unknown();
        else if (syntax.children.some(n => ['&&', '||', 'and', 'or', '&&=', '||=', '??='].includes(n.type)) && field(syntax, 'left')) effect.value = temporary(field(syntax, 'left'));
        effect.guard = effect.value; continue;
      }
      if (cfgNode.kind === 'return' || cfgNode.kind === 'throw') {
        if (cfgNode.kind === 'throw') {
          const operand = syntax.namedChild(0);
          if (!operand) {
            effect.value = { kind: 'rethrow' };
            continue;
          }
          const isConstructed = !!operand && ['call', 'call_expression', 'new_expression'].includes(operand.type);
          const constructor = isConstructed ? field(operand, 'function') ?? field(operand, 'constructor') ?? operand.namedChild(0) : operand;
          const type = constructor && ['identifier', 'type_identifier', 'constant'].includes(constructor.type) && /^[A-Z]/.test(constructor.text) ? constructor.text : undefined;
          const source = operand && ['identifier', 'self', 'this'].includes(operand.type) ? variable(operand, operand.text) : operand ? temporary(operand) : undefined;
          const groupArgument = isConstructed && constructor?.text && ['ExceptionGroup', 'BaseExceptionGroup'].includes(constructor.text)
            ? field(operand, 'arguments')?.namedChildren.at(1) : undefined;
          const exceptionGroupTypes = (member: Node): string[] => {
            if (['list', 'tuple', 'array'].includes(member.type)) return member.namedChildren.flatMap(exceptionGroupTypes);
            if (['call', 'call_expression', 'new_expression'].includes(member.type)) {
              const memberConstructor = field(member, 'function') ?? field(member, 'constructor') ?? member.namedChild(0);
              if (!memberConstructor) return [];
              if (['ExceptionGroup', 'BaseExceptionGroup'].includes(memberConstructor.text)) {
                const nested = field(member, 'arguments')?.namedChildren.at(1);
                return nested ? exceptionGroupTypes(nested) : [];
              }
              return ['identifier', 'type_identifier', 'constant'].includes(memberConstructor.type) && /^[A-Z]/.test(memberConstructor.text)
                ? [memberConstructor.text] : [];
            }
            return ['identifier', 'type_identifier', 'constant'].includes(member.type) && /^[A-Z]/.test(member.text)
              ? [member.text] : [];
          };
          const groupTypes = groupArgument ? [...new Set(exceptionGroupTypes(groupArgument))] : [];
          effect.value = { kind: 'exception', ...(type ? { type } : {}), ...(groupTypes.length ? { groupTypes } : {}), ...(source ? { source } : {}) };
        } else effect.value = syntax.namedChild(0) ? temporary(syntax.namedChild(0))
          : { kind: symbols.language === 'python' ? 'null' : symbols.language === 'rust' ? 'unit' : 'undefined' };
        continue;
      }
      if (cfgNode.kind === 'suspend') { effect.value = unknown(syntax.namedChildren.map(temporary)); effect.mayCall = true; continue; }
      if (syntax.type === 'let_condition') {
        // The operation node evaluates the scrutinee; the following condition
        // node performs the pattern binding and match branch.
        const valueNode = syntax.namedChild(1);
        effect.value = valueNode ? expression(valueNode, cfgNode) : unknown();
        continue;
      }
      effect.value = expression(syntax, cfgNode);
      // Cleanup nodes are synthetic effects for a context manager. The enter
      // node carries the lifecycle proof (or its conservative diagnostic), so
      // repeating the generic with_item diagnostic here would keep a proven
      // sync/async model partial even after that proof is established.
      if (['with_item', 'with_clause'].includes(syntax.type)
        && cfgNode.kind !== 'cleanup') diagnose(cfgNode, `Binding or lifecycle effect is not lowered: ${syntax.type}`);
      effect.mayCall = ['call', 'call_expression', 'new_expression'].includes(syntax.type);
      if (symbols.language === 'typescript' && syntax.type === 'call_expression' && field(syntax, 'function')?.text === 'eval') effect.mayMutateLocals = true;
      if (cfgNode.text === 'iterator next' || cfgNode.text.startsWith('__enter__') || cfgNode.text.startsWith('__exit__')
        || cfgNode.text.startsWith('__aenter__') || cfgNode.text.startsWith('__aexit__')) effect.mayCall = true;
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

/**
 * 같은 프로젝트의 다른 파일에 선언된 `impl Copy for T`도 구조체 allocation에
 * 적용한다. 프론트엔드는 파일별로 실행되므로 이 보정은 전체 symbol index가
 * 완성된 뒤 한 번만 수행한다.
 */
export function applyRustCopyTypes(graphs: ControlFlowGraph[], copyTypes: ReadonlySet<string>): void {
  for (const graph of graphs) {
    if (graph.language !== 'rust' || !graph.dataflow) continue;
    const visit = (expr: DataExpr): DataExpr => {
      if (expr.kind === 'allocation') {
        const copy = expr.typeName ? copyTypes.has(expr.typeName) || expr.copy : expr.copy;
        return { ...expr, copy, fields: expr.fields.map(([name, value]) => [name, visit(value)]) };
      }
      if (expr.kind === 'member') return { ...expr, object: visit(expr.object) };
      if (expr.kind === 'call') return { ...expr, callee: visit(expr.callee), arguments: expr.arguments.map(visit), ...(expr.receiver ? { receiver: visit(expr.receiver) } : {}) };
      if (expr.kind === 'binary') return { ...expr, left: visit(expr.left), right: visit(expr.right) };
      if (expr.kind === 'unary') return { ...expr, value: visit(expr.value) };
      return expr;
    };
    for (const effect of Object.values(graph.dataflow.effects)) {
      effect.value = visit(effect.value);
      effect.writes = effect.writes.map(write => ({ ...write, value: visit(write.value), target: write.target.kind === 'member' ? { ...write.target, object: visit(write.target.object) } : write.target }));
    }
    for (const variable of graph.dataflow.variables) {
      if (variable.typeName && copyTypes.has(variable.typeName)) variable.copy = true;
    }
  }
}
