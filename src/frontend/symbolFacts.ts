import type Parser from 'tree-sitter';
import type { ExtractedEntity } from '../registry/entityScanner.js';
import type { AstLanguage } from './types.js';
import { entityQualifiedName } from './types.js';
import type { SymbolFacts, SymbolValue, SymbolScope } from '../analysis/symbols.js';

type Node = Parser.SyntaxNode;
export interface EntitySyntax { node: Node; callable: Node; entity: ExtractedEntity }
const FUNCTIONS = new Set(['function_declaration', 'generator_function_declaration', 'function_signature',
  'function_expression', 'generator_function', 'arrow_function', 'method_definition', 'abstract_method_signature',
  'function_definition', 'lambda', 'function_item', 'function_signature_item', 'closure_expression']);
const CLASSES = new Set(['class', 'class_declaration', 'abstract_class_declaration', 'class_definition', 'struct_item', 'trait_item']);
const field = (node: Node, name: string) => node.childForFieldName(name);
const unknown = (reason = 'dynamic-call'): SymbolValue => ({ kind: 'unknown', reason });
const nameValue = (name: string): SymbolValue => ({ kind: 'name', name });

function expression(node: Node | null): SymbolValue {
  if (!node) return unknown();
  if (['identifier', 'type_identifier', 'this', 'self', 'super', 'crate'].includes(node.type)) return nameValue(node.text);
  if (['member_expression', 'attribute', 'field_expression', 'scoped_identifier', 'scoped_type_identifier'].includes(node.type)) {
    const object = field(node, 'object') ?? field(node, 'value') ?? field(node, 'path');
    const member = field(node, 'property') ?? field(node, 'attribute') ?? field(node, 'field') ?? field(node, 'name');
    return object && member ? { kind: 'member', object: expression(object), name: member.text } : unknown();
  }
  if (node.type === 'new_expression') return { kind: 'instance', type: expression(field(node, 'constructor')) };
  if (['call', 'call_expression'].includes(node.type)) return { kind: 'invoke', callee: expression(field(node, 'function')) };
  if (['parenthesized_expression', 'type_annotation', 'type', 'reference_type', 'generic_type', 'generic_function'].includes(node.type)) {
    return expression(field(node, 'type') ?? field(node, 'function') ?? node.namedChildren.find(n => n.type !== 'lifetime') ?? null);
  }
  if (node.type === 'as_expression' || node.type === 'non_null_expression') return expression(node.namedChild(0));
  return unknown();
}

function bindings(node: Node | null): string[] {
  if (!node) return [];
  if (['identifier', 'shorthand_property_identifier_pattern', 'self'].includes(node.type)) return [node.text];
  if (['required_parameter', 'optional_parameter', 'parameter', 'default_parameter', 'typed_default_parameter'].includes(node.type)) {
    return bindings(field(node, 'pattern') ?? field(node, 'name'));
  }
  if (['typed_parameter', 'self_parameter'].includes(node.type)) return bindings(node.namedChild(0));
  if (['assignment_pattern', 'object_assignment_pattern'].includes(node.type)) return bindings(field(node, 'left'));
  if (node.type === 'pair_pattern') return bindings(field(node, 'value'));
  if (['match_pattern', 'as_pattern_target'].includes(node.type)) return node.namedChildren.flatMap(bindings);
  if (['tuple_struct_pattern', 'struct_pattern'].includes(node.type)) {
    const type = field(node, 'type');
    return node.namedChildren.filter(child => child.id !== type?.id).flatMap(bindings);
  }
  if (['object_pattern', 'array_pattern', 'tuple_pattern', 'list_pattern', 'pattern_list', 'rest_pattern', 'list_splat_pattern', 'dictionary_splat_pattern'].includes(node.type)) return node.namedChildren.flatMap(bindings);
  return [];
}

function moduleText(node: Node | null): string {
  if (!node) return '';
  return node.type === 'string' ? node.namedChildren.map(n => n.text).join('') : node.text;
}

export function extractSymbolFacts(root: Node, language: AstLanguage, filePath: string, syntax: EntitySyntax[]): SymbolFacts {
  const facts: SymbolFacts = { filePath, language, scopes: [{ id: 0, parent: null, kind: 'module', startOffset: root.startIndex, endOffset: root.endIndex }], bindings: [],
    entities: [], exports: [], starExports: [], calls: [], bases: [], implementations: [] };
  const declarations = new Map<number, EntitySyntax[]>();
  const callables = new Map<number, EntitySyntax>();
  const containers = new Map<number, EntitySyntax>();
  for (const item of syntax) {
    declarations.set(item.node.id, [...declarations.get(item.node.id) ?? [], item]);
    if (item.entity.kind === 'function') callables.set(item.callable.id, item);
    const value = field(item.node, 'value');
    if (value?.type === 'object') containers.set(value.id, item);
  }
  const entities = new Map<string, (typeof facts.entities)[number]>();
  const writes: Array<{ name: string; scope: number; offset: number }> = [];
  const directives: Array<{ name: string; scope: number; global: boolean }> = [];
  const bind = (name: string, scope: number, value: SymbolValue, offset = 0, hoisted = true, isParameter = false) => {
    facts.bindings.push({ name, scope, value, offset, hoisted, ...(isParameter ? { isParameter: true } : {}) });
  };
  const exported = (name: string, value: SymbolValue, scope = 0) => facts.exports.push({ name, value, scope });
  const nearestFunction = (scope: number): number => {
    while (facts.scopes[scope].kind === 'block' && facts.scopes[scope].parent !== null) scope = facts.scopes[scope].parent!;
    return scope;
  };

  function imports(node: Node, scope: number): void {
    if (language === 'typescript' && node.type === 'import_statement') {
      const module = moduleText(field(node, 'source'));
      const clause = node.namedChildren.find(n => n.type === 'import_clause');
      for (const child of clause?.namedChildren ?? []) {
        if (child.type === 'identifier') bind(child.text, scope, { kind: 'import', module, name: 'default' });
        if (child.type === 'namespace_import') bind(child.namedChildren[0].text, scope, { kind: 'import', module, name: '*' });
        if (child.type === 'named_imports') for (const spec of child.namedChildren) {
          const name = field(spec, 'name');
          if (name) bind((field(spec, 'alias') ?? name).text, scope, { kind: 'import', module, name: name.text });
        }
      }
    }
    if (language === 'python' && ['import_statement', 'import_from_statement'].includes(node.type)) {
      const from = field(node, 'module_name');
      for (const item of node.namedChildren.filter(n => n.id !== from?.id && n.type !== 'wildcard_import')) {
        const name = moduleText(field(item, 'name') ?? item);
        const alias = field(item, 'alias')?.text;
        bind(alias ?? (from ? name : name.split('.')[0]), scope,
          { kind: 'import', module: from ? from.text : alias ? name : name.split('.')[0], name: from ? name : '*' });
      }
      if (from && node.namedChildren.some(n => n.type === 'wildcard_import')) facts.starExports.push(from.text);
    }
    if (language === 'rust' && node.type === 'use_declaration') {
      const collect = (item: Node, prefix = ''): void => {
        if (item.type === 'scoped_use_list') {
          const path = field(item, 'path')?.text;
          const next = [prefix, path].filter(Boolean).join('::');
          for (const child of field(item, 'list')?.namedChildren ?? []) collect(child, next);
          return;
        }
        const text = item.type === 'use_as_clause' ? field(item, 'path')!.text : item.text;
        const parts = [prefix, text].filter(Boolean).join('::').split('::');
        const name = parts.pop()!;
        const module = parts.join('::');
        const alias = field(item, 'alias')?.text ?? name;
        if (name === '*') facts.starExports.push(module);
        else bind(alias, scope, { kind: 'import', module, name });
        if (node.namedChildren.some(n => n.type === 'visibility_modifier')) exported(alias, nameValue(alias), scope);
      };
      const argument = field(node, 'argument');
      if (argument) collect(argument);
    }
  }

  function exports(node: Node, scope: number): void {
    if (language !== 'typescript' || node.type !== 'export_statement') return;
    const module = moduleText(field(node, 'source'));
    const clause = node.namedChildren.find(n => n.type === 'export_clause');
    if (clause) for (const spec of clause.namedChildren) {
      const name = field(spec, 'name');
      if (name) exported((field(spec, 'alias') ?? name).text, module
        ? { kind: 'import', module, name: name.text } : nameValue(name.text), scope);
    }
    else if (module) facts.starExports.push(module);
    const value = field(node, 'value');
    if (value && !declarations.has(value.id)) exported('default', expression(value), scope);
  }

  function visit(node: Node, parentScope: number, caller?: string): void {
    let scope = parentScope;
    imports(node, parentScope);
    exports(node, parentScope);
    const declared = declarations.get(node.id) ?? [];
    for (const { entity, callable } of declared) {
      const qualifiedName = entityQualifiedName(entity);
      const symbol = { qualifiedName, name: entity.name, kind: entity.kind, scope: parentScope,
        hasBody: !!field(callable, 'body'), returnType: field(callable, 'return_type') ? expression(field(callable, 'return_type')) : undefined };
      facts.entities.push(symbol); entities.set(qualifiedName, symbol);
      bind(entity.name, parentScope, { kind: 'entity', qualifiedName }, node.startIndex,
        language !== 'python' && !['class', 'class_declaration', 'abstract_class_declaration',
          'variable_declarator', 'assignment', 'public_field_definition', 'field_definition'].includes(node.type));
      if (entity.isExported) exported(entity.name, nameValue(entity.name), parentScope);
      if (node.parent?.type === 'export_statement' && node.parent.children.some(n => n.type === 'default')) exported('default', nameValue(entity.name));
    }

    let kind: SymbolScope['kind'] | undefined;
    const callable = callables.get(node.id);
    if (FUNCTIONS.has(node.type)) kind = 'function';
    else if (CLASSES.has(node.type) || node.type === 'impl_item' || node.type === 'object') kind = 'class';
    else if (node.type === 'internal_module' || node.type === 'mod_item') kind = 'module';
    else if (language === 'python' && ['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression'].includes(node.type)) kind = 'block';
    else if (language === 'rust' && ['for_expression', 'match_arm', 'if_expression', 'while_expression'].includes(node.type)) kind = 'block';
    else if (language !== 'python' && node.parent?.type !== 'internal_module'
      && ['statement_block', 'block', 'catch_clause', 'for_statement', 'for_in_statement'].includes(node.type)) kind = 'block';
    if (kind) {
      const ownerSyntax = callable ?? containers.get(node.id) ?? declared[0];
      const owner = ownerSyntax ? entityQualifiedName(ownerSyntax.entity) : undefined;
      scope = facts.scopes.length;
      const receiver: SymbolValue | undefined = kind === 'class'
        ? node.type === 'impl_item' ? expression(field(node, 'type')) : owner ? { kind: 'entity', qualifiedName: owner } : undefined
        : undefined;
      facts.scopes.push({ id: scope, parent: parentScope, kind, owner, receiver, startOffset: node.startIndex, endOffset: node.endIndex });
      if (owner) { const entity = entities.get(owner); if (entity) entity.bodyScope = scope; }
      if (kind === 'function') caller = owner;
      else if (kind === 'class') caller = owner;
      if (node.type === 'impl_item' && receiver) facts.implementations.push({ type: receiver, scope, parentScope });
      if (kind === 'function') {
        facts.scopes[scope].parameters = [];
        const classScope = facts.scopes[parentScope].kind === 'class' ? facts.scopes[parentScope] : undefined;
        if (classScope?.receiver) {
          bind('this', scope, { kind: 'instance', type: classScope.receiver }, 0, true, true);
          if (language === 'typescript') facts.scopes[scope].parameters!.push({ index: -1, name: 'this', receiver: true });
          bind('Self', scope, classScope.receiver);
        }
        const parameters = field(node, 'parameters');
        const params = parameters?.namedChildren ?? (field(node, 'parameter') ? [field(node, 'parameter')!] : []);
        let argumentIndex = 0;
        for (const parameter of params) {
          const pattern = field(parameter, 'pattern') ?? field(parameter, 'name')
            ?? (['identifier', 'self'].includes(parameter.type) ? parameter : parameter.namedChild(0));
          const directName = pattern && ['identifier', 'self', 'this'].includes(pattern.type) ? pattern.text : undefined;
          const receiver = !!classScope && (language === 'rust' && parameter.type === 'self_parameter'
            || language === 'python' && argumentIndex === 0 && ['self', 'cls'].includes(directName ?? '')
            || language === 'typescript' && directName === 'this');
          facts.scopes[scope].parameters!.push({ index: receiver ? -1 : argumentIndex++, name: directName, receiver });
          for (const name of bindings(parameter)) {
            const type = field(parameter, 'type');
            const value = classScope?.receiver && (name === 'self' || name === 'cls')
              ? { kind: 'instance' as const, type: classScope.receiver }
              : type ? { kind: 'instance' as const, type: expression(type) } : unknown('unknown-receiver');
            bind(name, scope, value, 0, true, true);
          }
        }
        if (node.type === 'function_expression' && field(node, 'name') && owner) bind(field(node, 'name')!.text, scope, { kind: 'entity', qualifiedName: owner });
      }
      if (owner && kind === 'class') {
        const base = field(node, 'superclasses');
        for (const type of base?.namedChildren ?? []) facts.bases.push({ entity: owner, type: expression(type), scope: parentScope });
        const heritage = node.namedChildren.find(n => n.type === 'class_heritage');
        for (const clause of heritage?.namedChildren ?? []) for (const type of clause.namedChildren) facts.bases.push({ entity: owner, type: expression(type), scope: parentScope });
      }
    }

    if (['variable_declarator', 'let_declaration', 'assignment', 'named_expression', 'public_field_definition',
      'field_definition', 'pair', 'assignment_expression', 'augmented_assignment_expression', 'augmented_assignment'].includes(node.type)) {
      const pattern = field(node, 'name') ?? field(node, 'pattern') ?? field(node, 'left') ?? field(node, 'property') ?? field(node, 'key');
      const value = field(node, 'value') ?? field(node, 'right');
      const targetScope = language === 'python' || node.parent?.type === 'variable_declaration' ? nearestFunction(scope) : scope;
      const names = pattern?.type === 'property_identifier' ? [pattern.text] : bindings(pattern);
      for (const name of names) {
        if (['assignment_expression', 'augmented_assignment_expression', 'augmented_assignment'].includes(node.type)) {
          writes.push({ name, scope, offset: node.startIndex });
          continue;
        }
        // Function declarations already have an entity binding; ordinary values
        // still need their initializer so aliases/instances can be resolved.
        const entity = declared.find(d => d.entity.name === name);
        if (entity?.entity.kind === 'function') continue;
        if (entity && value && containers.has(value.id)) continue;
        const existing = facts.bindings.find(b => b.scope === targetScope && b.name === name && b.offset === node.startIndex);
        if (existing) existing.value = expression(value);
        else bind(name, targetScope, expression(value), node.startIndex, false);
      }
    }
    if (node.type === 'catch_clause') {
      for (const name of bindings(field(node, 'parameter'))) bind(name, scope, unknown('unknown-receiver'));
    }
    if (language === 'typescript' && node.type === 'for_in_statement') {
      const declaration = node.children.find(child => ['var', 'let', 'const'].includes(child.type));
      for (const name of bindings(field(node, 'left'))) {
        if (declaration) bind(name, declaration.type === 'var' ? nearestFunction(scope) : scope, unknown('unknown-receiver'), node.startIndex, false);
        else writes.push({ name, scope, offset: node.startIndex });
      }
    }
    if (language === 'python') {
      if (node.type === 'for_statement' || node.type === 'for_in_clause') {
        for (const name of bindings(field(node, 'left'))) bind(name, scope, unknown('unknown-receiver'));
      }
      if (node.type === 'as_pattern') for (const name of bindings(field(node, 'alias'))) bind(name, nearestFunction(scope), unknown('unknown-receiver'));
      if (node.type === 'global_statement' || node.type === 'nonlocal_statement') {
        for (const name of node.namedChildren.flatMap(bindings)) directives.push({ name, scope: nearestFunction(scope), global: node.type === 'global_statement' });
      }
    }
    if (language === 'rust' && ['for_expression', 'match_arm', 'let_condition'].includes(node.type)) {
      for (const name of bindings(field(node, 'pattern'))) bind(name, scope, unknown('unknown-receiver'));
    }
    if (['call_expression', 'call', 'new_expression'].includes(node.type)) {
      const callee = field(node, 'function') ?? field(node, 'constructor');
      facts.calls.push({ filePath, caller, scope, callee: expression(callee), expression: callee?.text ?? node.text,
        line: node.startPosition.row + 1, column: node.startPosition.column + 1,
        endLine: node.endPosition.row + 1, endColumn: node.endPosition.column + 1, offset: node.startIndex });
    }
    for (const child of node.namedChildren) {
      const childScope = language === 'rust' && node.type === 'if_expression' && child.id === field(node, 'alternative')?.id ? parentScope : scope;
      visit(child, childScope, caller);
    }
  }
  visit(root, 0);
  for (const directive of directives) {
    let target = 0;
    if (!directive.global) {
      let parent = facts.scopes[directive.scope].parent;
      while (parent !== null && parent !== undefined) {
        if (facts.scopes[parent].kind === 'function' && facts.bindings.some(b => b.scope === parent && b.name === directive.name)) { target = parent; break; }
        parent = facts.scopes[parent].parent;
      }
    }
    if (target === directive.scope) continue;
    const frame = facts.scopes[directive.scope];
    frame.redirects = { ...frame.redirects, [directive.name]: target };
    for (const binding of facts.bindings) if (binding.scope === directive.scope && binding.name === directive.name) binding.scope = target;
  }
  // Assignment writes to an existing lexical binding, even from a nested block.
  // Until CFG/dataflow exists, multiple writes are deliberately unresolved.
  for (const write of writes) {
    let scope = write.scope;
    while (!facts.bindings.some(b => b.name === write.name && b.scope === scope) && facts.scopes[scope].parent !== null) scope = facts.scopes[scope].parent!;
    bind(write.name, scope, unknown('reassigned-binding'), write.offset, false);
  }
  return facts;
}
