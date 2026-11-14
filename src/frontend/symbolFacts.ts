import type Parser from 'tree-sitter';
import type { ExtractedEntity } from '../registry/entityScanner.js';
import type { AstLanguage } from './types.js';
import { entityQualifiedName } from './types.js';
import type { SymbolFacts, SymbolValue, SymbolScope } from '../analysis/symbols.js';

type Node = Parser.SyntaxNode;
export interface EntitySyntax { node: Node; callable: Node; entity: ExtractedEntity }
const FUNCTIONS = new Set(['function_declaration', 'generator_function_declaration', 'function_signature',
  'function_expression', 'generator_function', 'arrow_function', 'method_definition', 'abstract_method_signature', 'method_signature',
  'function_definition', 'lambda', 'function_item', 'function_signature_item', 'closure_expression']);
const CLASSES = new Set(['class', 'class_declaration', 'abstract_class_declaration', 'class_definition', 'interface_declaration', 'struct_item', 'trait_item']);
const field = (node: Node, name: string) => node.childForFieldName(name);
const unknown = (reason = 'dynamic-call'): SymbolValue => ({ kind: 'unknown', reason });
const nameValue = (name: string): SymbolValue => ({ kind: 'name', name });

function boundNames(node: Node): string[] {
  if (node.type === 'union_type') return [];
  if (['type_identifier', 'identifier', 'scoped_type_identifier'].includes(node.type)) return [node.text];
  if (node.type === 'generic_type') {
    const name = field(node, 'name') ?? node.namedChild(0);
    return name ? [name.text] : [];
  }
  return node.namedChildren.flatMap(boundNames);
}

function expression(node: Node | null): SymbolValue {
  if (!node) return unknown();
  if (['identifier', 'type_identifier', 'this', 'self', 'super', 'crate'].includes(node.type)) return nameValue(node.text);
  if (node.type === 'predefined_type') return { kind: 'type', name: node.text };
  if (['member_expression', 'attribute', 'field_expression', 'scoped_identifier', 'scoped_type_identifier'].includes(node.type)) {
    const object = field(node, 'object') ?? field(node, 'value') ?? field(node, 'path');
    const member = field(node, 'property') ?? field(node, 'attribute') ?? field(node, 'field') ?? field(node, 'name');
    return object && member ? { kind: 'member', object: expression(object), name: member.text } : unknown();
  }
  if (node.type === 'new_expression') return { kind: 'instance', type: expression(field(node, 'constructor')) };
  if (['call', 'call_expression'].includes(node.type)) return { kind: 'invoke', callee: expression(field(node, 'function')) };
  if (['parenthesized_expression', 'type_annotation', 'type', 'reference_type', 'generic_type', 'generic_function'].includes(node.type)) {
    if (node.type === 'generic_type') {
      const name = field(node, 'name')?.text ?? node.namedChild(0)?.text;
      const argumentsNode = field(node, 'type_arguments');
      if (name && argumentsNode) return { kind: 'generic', name, args: argumentsNode.namedChildren.map(expression) };
    }
    return expression(field(node, 'type') ?? field(node, 'function') ?? node.namedChildren.find(n => n.type !== 'lifetime') ?? null);
  }
  if (node.type === 'union_type') {
    return { kind: 'union', types: node.namedChildren.map(expression) };
  }
  if (node.type === 'intersection_type') return { kind: 'intersection', types: node.namedChildren.map(expression) };
  if (node.type === 'binary_operator' && node.children.some(child => child.text === '|')) {
    return { kind: 'union', types: node.namedChildren.map(expression) };
  }
  if (node.type === 'as_expression') {
    const asserted = field(node, 'type') ?? node.namedChild(1);
    const value = field(node, 'left') ?? node.namedChild(0);
    return asserted ? { kind: 'instance', type: expression(asserted) } : expression(value);
  }
  if (node.type === 'type_assertion') {
    const typeArguments = field(node, 'type') ?? node.namedChildren.find(child => child.type === 'type_arguments');
    const asserted = typeArguments?.namedChild(0) ?? typeArguments;
    return asserted ? { kind: 'instance', type: expression(asserted) } : expression(node.namedChild(0));
  }
  if (node.type === 'non_null_expression') return expression(node.namedChild(0));
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
    entities: [], exports: [], starExports: [], calls: [], bases: [], implementations: [], narrowings: [], exclusions: [], discriminants: {}, discriminantChecks: [], propertyChecks: [], conditionalTypes: {} };
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
      facts.scopes.push({ id: scope, parent: parentScope, kind, owner, receiver, startOffset: node.startIndex, endOffset: node.endIndex,
        ...(language === 'typescript' && kind === 'class' ? { memberOnly: true } : {}) });
      if (owner) { const entity = entities.get(owner); if (entity) entity.bodyScope = scope; }
      if (kind === 'function') caller = owner;
      else if (kind === 'class' && node.type !== 'object') caller = owner;
      if (node.type === 'impl_item' && receiver) facts.implementations.push({ type: receiver,
        ...(field(node, 'trait') ? { trait: expression(field(node, 'trait')) } : {}), scope, parentScope });
      if (kind === 'function') {
        facts.scopes[scope].parameters = [];
        if (language === 'rust' || language === 'typescript') {
          const genericBounds: Record<string, string[]> = {};
          const genericUnionBounds: Record<string, string[]> = {};
          for (const parameter of field(node, 'type_parameters')?.namedChildren ?? []) {
            if (parameter.type !== 'type_parameter') continue;
            const name = field(parameter, 'name')?.text ?? parameter.namedChild(0)?.text;
            const boundNode = parameter.namedChildren.find(child => child.type === 'trait_bounds' || child.type === 'constraint');
            const unionNode = boundNode?.namedChildren.find(child => child.type === 'union_type');
            const unionBounds = unionNode?.namedChildren.flatMap(boundNames);
            if (name && unionBounds?.length) {
              genericUnionBounds[name] = unionBounds;
              continue;
            }
            const bounds = boundNode?.namedChildren
              .flatMap(boundNames)
              .filter(bound => !!bound && !bound.startsWith("'"));
            if (name && bounds?.length) genericBounds[name] = bounds;
          }
          const whereClause = field(node, 'where_clause') ?? node.namedChildren.find(child => child.type === 'where_clause');
          for (const predicate of whereClause?.namedChildren ?? []) {
            if (predicate.type !== 'where_predicate') continue;
            const name = predicate.namedChild(0)?.text;
            const boundsNode = predicate.namedChildren.find(child => child.type === 'trait_bounds');
            const bounds = boundsNode?.namedChildren.flatMap(boundNames).filter(bound => !!bound && !bound.startsWith("'"));
            if (name && bounds?.length) genericBounds[name] = [...new Set([...(genericBounds[name] ?? []), ...bounds])];
          }
          if (Object.keys(genericBounds).length) facts.scopes[scope].genericBounds = genericBounds;
          if (Object.keys(genericUnionBounds).length) facts.scopes[scope].genericUnionBounds = genericUnionBounds;
        }
        const classScope = facts.scopes[parentScope].kind === 'class' ? facts.scopes[parentScope] : undefined;
        if (classScope?.receiver) {
          bind('this', scope, { kind: 'instance', type: classScope.receiver }, 0, true, true);
          if (language === 'typescript') facts.scopes[scope].parameters!.push({ index: -1, name: 'this', receiver: true });
          bind('Self', scope, classScope.receiver);
        }
        const parameters = field(node, 'parameters');
        const params = parameters?.namedChildren ?? (field(node, 'parameter') ? [field(node, 'parameter')!] : []);
        const rustCopyGenerics = language === 'rust'
          ? new Set((field(node, 'type_parameters')?.namedChildren ?? []).filter(parameter => parameter.type === 'type_parameter'
            && parameter.namedChildren.find(child => child.type === 'trait_bounds')?.namedChildren.some(bound => bound.text === 'Copy'))
            .map(parameter => field(parameter, 'name')?.text ?? parameter.namedChild(0)?.text)
            .filter((name): name is string => !!name))
          : new Set<string>();
        let argumentIndex = 0;
        for (const parameter of params) {
          const pattern = field(parameter, 'pattern') ?? field(parameter, 'name')
            ?? (['identifier', 'self'].includes(parameter.type) ? parameter : parameter.namedChild(0));
          const directName = pattern && ['identifier', 'self', 'this'].includes(pattern.type) ? pattern.text : undefined;
          const receiver = !!classScope && (language === 'rust' && parameter.type === 'self_parameter'
            || language === 'python' && argumentIndex === 0 && ['self', 'cls'].includes(directName ?? '')
            || language === 'typescript' && directName === 'this');
          const typeName = language === 'rust' && field(parameter, 'type') ? field(parameter, 'type')!.text : undefined;
          facts.scopes[scope].parameters!.push({ index: receiver ? -1 : argumentIndex++, name: directName, receiver,
            ...(typeName ? { typeName, ...(rustCopyGenerics.has(typeName) ? { copy: true } : {}) } : {}) });
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
      if (pattern && ['member_expression', 'field_expression', 'attribute'].includes(pattern.type)) {
        const object = field(pattern, 'object') ?? field(pattern, 'value');
        const property = field(pattern, 'property') ?? field(pattern, 'field') ?? field(pattern, 'attribute');
        if (object && property && ['assignment_expression', 'augmented_assignment_expression', 'augmented_assignment', 'assignment', 'named_expression'].includes(node.type)) {
          (facts.memberWrites ??= []).push({ object: object.text, property: property.text, offset: node.startIndex, scope });
        }
      }
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
  if (language === 'typescript') {
    const literalValue = (node: Node | null | undefined): string | undefined => {
      if (!node) return undefined;
      const text = node.text;
      if (node.type === 'string' || node.type === 'string_fragment') return text.replace(/^['"]|['"]$/g, '');
      if (node.type === 'number') return text;
      return undefined;
    };
    const collectDiscriminants = (node: Node): void => {
      if (node.type === 'interface_declaration' || node.type === 'type_alias_declaration') {
        const name = field(node, 'name')?.text;
        const entity = facts.entities.find(item => item.kind === 'type' && item.name === name);
        const body = node.type === 'interface_declaration' ? field(node, 'body') : field(node, 'value');
        if (entity && body) for (const property of body.namedChildren.filter(child => child.type === 'property_signature')) {
          const propertyName = field(property, 'name')?.text;
          const type = field(property, 'type')?.namedChild(0);
          const value = literalValue(type?.namedChild(0) ?? type);
          if (propertyName && value !== undefined) facts.discriminants![entity.qualifiedName] = {
            ...facts.discriminants![entity.qualifiedName], [propertyName]: value,
          };
        }
      }
      for (const child of node.namedChildren) collectDiscriminants(child);
    };
    collectDiscriminants(root);
    const collectConditionalTypes = (node: Node): void => {
      const splitTypeArguments = (text: string): string[] => {
        const result: string[] = []; let start = 0; let depth = 0;
        for (let index = 0; index < text.length; index++) {
          if (text[index] === '<') depth++;
          else if (text[index] === '>') depth--;
          else if (text[index] === ',' && depth === 0) { result.push(text.slice(start, index).trim()); start = index + 1; }
        }
        const last = text.slice(start).trim(); if (last) result.push(last);
        return result;
      };
      const collectInferPatterns = (text: string): Array<{ path: number[]; containers: string[]; parameter: string }> => {
        type TypePattern = { name: string; args: TypePattern[] } | { infer: string };
        const parse = (source: string): TypePattern | undefined => {
          const infer = source.match(/^infer\s+([A-Za-z_$][\w$]*)$/);
          if (infer) return { infer: infer[1] };
          const match = source.match(/^([A-Za-z_$][\w$]*)(?:\s*<([\s\S]+)>)?$/);
          if (!match) return undefined;
          return { name: match[1], args: match[2] ? splitTypeArguments(match[2]).map(parse).filter((item): item is TypePattern => !!item) : [] };
        };
        const root = parse(text); const found: Array<{ path: number[]; containers: string[]; parameter: string }> = [];
        const visit = (value: TypePattern | undefined, path: number[], containers: string[]): void => {
          if (!value) return;
          if ('infer' in value) { found.push({ path, containers, parameter: value.infer }); return; }
          value.args.forEach((child, index) => visit(child, [...path, index], [...containers, value.name]));
        };
        visit(root, [], []); return found;
      };
      if (node.type === 'type_alias_declaration') {
        const name = field(node, 'name')?.text;
        const value = field(node, 'value');
        if (name && value?.type === 'conditional_type') {
          const left = field(value, 'left');
          const right = field(value, 'right');
          const consequence = field(value, 'consequence');
          const alternative = field(value, 'alternative');
          const parameters = field(node, 'type_parameters')?.namedChildren ?? [];
          const parameter = parameters.length === 1 ? parameters[0].namedChild(0)?.text : undefined;
          const entity = facts.entities.find(item => item.kind === 'type' && item.name === name);
          const inferMatch = right?.text.match(/^([A-Za-z_$][\w$]*)\s*<\s*infer\s+([A-Za-z_$][\w$]*)\s*>$/);
          const multiInferMatch = right?.text.match(/^([A-Za-z_$][\w$]*)\s*<(.+)>$/);
          const inferences = multiInferMatch ? multiInferMatch[2].split(',').map((part, index) => {
            const match = part.trim().match(/^infer\s+([A-Za-z_$][\w$]*)$/);
            return match ? { container: multiInferMatch[1], parameter: match[1], index } : undefined;
          }).filter((entry): entry is { container: string; parameter: string; index: number } => !!entry) : [];
          const inferencePatterns = right ? collectInferPatterns(right.text) : [];
          if (entity && left && right && consequence && alternative) facts.conditionalTypes![entity.qualifiedName] = {
            left: left.text, right: right.text, ...(parameter ? { parameter } : {}),
            ...(inferMatch ? { infer: { container: inferMatch[1], parameter: inferMatch[2] } } : {}),
            ...(inferences.length > 1 ? { inferences } : {}),
            ...(inferencePatterns.length ? { inferencePatterns } : {}),
            whenTrue: expression(consequence), whenFalse: expression(alternative),
          };
        }
      }
      for (const child of node.namedChildren) collectConditionalTypes(child);
    };
    collectConditionalTypes(root);
    const collectNarrowings = (node: Node): void => {
      const branchScopeFor = (branch: Node | null): number | undefined => branch
        ? facts.scopes.filter(scope => scope.startOffset <= branch.startIndex && scope.endOffset >= branch.endIndex)
          .sort((left, right) => right.startOffset - left.startOffset)[0]?.id
        : undefined;
      if (node.type === 'if_statement') {
        const condition = field(node, 'condition')?.namedChild(0) ?? field(node, 'condition');
        const parseInstanceof = (candidate: Node | null | undefined, positive = true): { left: Node; right: Node; rights?: Node[]; positive: boolean; compound?: boolean; disjunction?: boolean } | undefined => {
          let item = candidate;
          while (item?.type === 'parenthesized_expression') item = item.namedChild(0);
          if (!item) return undefined;
          if (item.type === 'unary_expression' && item.childForFieldName('operator')?.text === '!')
            return parseInstanceof(item.childForFieldName('argument') ?? item.namedChild(0), !positive);
          const operator = item.childForFieldName('operator');
          const left = item.childForFieldName('left');
          const right = item.childForFieldName('right');
          if (operator?.text === 'instanceof' && left?.type === 'identifier' && right) return { left, right, positive };
          if (operator?.text === '||') {
            const checks = item.namedChildren.map(child => parseInstanceof(child)).filter((check): check is NonNullable<typeof check> => !!check);
            if (checks.length >= 2 && checks.every(check => check.positive && check.left.text === checks[0].left.text))
              return { left: checks[0].left, right: checks[0].right, rights: checks.flatMap(check => check.rights ?? [check.right]), positive, disjunction: true };
          }
          if (operator?.text === '&&') {
            const checks = item.namedChildren.map(child => parseInstanceof(child)).filter((check): check is NonNullable<typeof check> => !!check);
            return checks.length === 1 && checks[0].positive ? { ...checks[0], compound: true } : undefined;
          }
          return undefined;
        };
        const instanceofCheck = parseInstanceof(condition);
        const consequence = field(node, 'consequence');
        const branchScope = consequence
          ? facts.scopes.filter(scope => scope.startOffset <= consequence.startIndex && scope.endOffset >= consequence.endIndex)
            .sort((left, right) => right.startOffset - left.startOffset)[0]?.id
          : undefined;
        if (instanceofCheck && branchScope !== undefined && branchScope !== null && consequence) {
          const rights = instanceofCheck.rights ?? [instanceofCheck.right];
          const addBranchFact = (branch: Node, scope: number, positive: boolean) => {
            const span = { name: instanceofCheck.left.text, scope, startOffset: branch.startIndex, endOffset: branch.endIndex };
            if (positive) {
              const type = rights.length === 1 ? expression(rights[0]) : { kind: 'union' as const, types: rights.map(expression) };
              facts.narrowings!.push({ ...span, type });
            } else for (const right of rights) facts.exclusions!.push({ ...span, type: expression(right) });
          };
          addBranchFact(consequence, branchScope, instanceofCheck.positive);
          const alternative = field(node, 'alternative');
          const alternativeBranch = alternative?.type === 'else_clause' ? alternative.namedChild(0) : alternative;
          const alternativeScope = branchScopeFor(alternativeBranch ?? null);
          if (alternativeBranch && alternativeScope !== undefined && !instanceofCheck.compound) addBranchFact(alternativeBranch, alternativeScope, !instanceofCheck.positive);
        }
        const parsePropertyCheck = (candidate: Node | null | undefined, matches = true): { name: string; property: string; matches: boolean } | undefined => {
          let item = candidate;
          while (item?.type === 'parenthesized_expression') item = item.namedChild(0);
          if (!item) return undefined;
          if (item.type === 'unary_expression' && item.childForFieldName('operator')?.text === '!')
            return parsePropertyCheck(item.childForFieldName('argument') ?? item.namedChild(0), !matches);
          if (item.childForFieldName('operator')?.text !== 'in') return undefined;
          const left = item.childForFieldName('left');
          const right = item.childForFieldName('right');
          const property = literalValue(left?.namedChild(0) ?? left);
          return typeof property === 'string' && right?.type === 'identifier' ? { name: right.text, property, matches } : undefined;
        };
        const propertyCheck = language === 'typescript' ? parsePropertyCheck(condition) : undefined;
        if (propertyCheck && branchScope !== undefined && branchScope !== null && consequence) {
          const addPropertyFact = (branch: Node, scope: number, matches: boolean) => facts.propertyChecks!.push({ ...propertyCheck, matches, scope,
            startOffset: branch.startIndex, endOffset: branch.endIndex });
          addPropertyFact(consequence, branchScope, propertyCheck.matches);
          const alternative = field(node, 'alternative');
          const alternativeBranch = alternative?.type === 'else_clause' ? alternative.namedChild(0) : alternative;
          const alternativeScope = branchScopeFor(alternativeBranch ?? null);
          if (alternativeBranch && alternativeScope !== undefined) addPropertyFact(alternativeBranch, alternativeScope, !propertyCheck.matches);
        }
        const parseDiscriminant = (candidate: Node | null | undefined): { name: string; property: string; value: string; equality: boolean } | undefined => {
          let item = candidate;
          while (item?.type === 'parenthesized_expression') item = item.namedChild(0);
          const itemOperator = item?.childForFieldName('operator')?.text;
          if (!item || !['===', '==', '!==', '!='].includes(itemOperator ?? '')) return undefined;
          const itemLeft = item.childForFieldName('left');
          const itemRight = item.childForFieldName('right');
          const itemObject = itemLeft?.type === 'member_expression' ? field(itemLeft, 'object') : null;
          const itemProperty = itemLeft?.type === 'member_expression' ? field(itemLeft, 'property')?.text : undefined;
          const itemValue = literalValue(itemRight?.namedChild(0) ?? itemRight);
          if (itemObject?.type !== 'identifier' || !itemProperty || itemValue === undefined) return undefined;
          return { name: itemObject.text, property: itemProperty, value: itemValue, equality: itemOperator === '===' || itemOperator === '==' };
        };
        const directDiscriminant = parseDiscriminant(condition);
        const disjunctionCandidates = condition?.childForFieldName('operator')?.text === '||'
          ? condition.namedChildren.map(parseDiscriminant)
          : [];
        const disjunction = disjunctionCandidates.length && disjunctionCandidates.every((item): item is NonNullable<typeof item> => !!item)
          ? disjunctionCandidates : [];
        const positiveCompound = (candidate: Node | null | undefined): NonNullable<ReturnType<typeof parseDiscriminant>>[] => {
          let item = candidate;
          while (item?.type === 'parenthesized_expression') item = item.namedChild(0);
          const direct = parseDiscriminant(item);
          if (direct) return direct.equality ? [direct] : [];
          const compoundOperator = item?.childForFieldName('operator')?.text;
          if (compoundOperator !== '&&' && compoundOperator !== '||') return [];
          const children = item?.namedChildren ?? [];
          const left = positiveCompound(children[0]);
          const right = positiveCompound(children[1]);
          if (compoundOperator === '||') {
            if (!left.length || !right.length) return [];
            const all = [...left, ...right];
            return all.every(test => test.name === all[0].name && test.property === all[0].property) ? all : [];
          }
          if (!left.length) return right;
          if (!right.length) return left;
          if (left[0].name !== right[0].name || left[0].property !== right[0].property) return [];
          const values = new Set(right.map(test => test.value));
          return left.filter(test => values.has(test.value));
        };
        const compoundComparisons = !directDiscriminant && !disjunction.length ? positiveCompound(condition) : [];
        const comparisons = directDiscriminant ? [directDiscriminant] : disjunction.length ? disjunction : compoundComparisons;
        const consequenceOnly = compoundComparisons.length > 0;
        const sameDiscriminant = comparisons.length > 0 && comparisons.every(item => item.name === comparisons[0].name && item.property === comparisons[0].property);
        const memberObject = sameDiscriminant ? { type: 'identifier', text: comparisons[0].name } as Node : null;
        const propertyName = sameDiscriminant ? comparisons[0].property : undefined;
        const expectedValues = sameDiscriminant ? [...new Set(comparisons.map(item => item.value))] : [];
        const allEquality = sameDiscriminant && comparisons.every(item => item.equality);
        const allInequality = sameDiscriminant && comparisons.every(item => !item.equality);
        const alternative = field(node, 'alternative');
        if ((allEquality || allInequality) && memberObject?.type === 'identifier' && propertyName && expectedValues.length && consequence) {
          const binding = facts.bindings.filter(item => item.name === memberObject.text
            && item.scope < facts.scopes.length && facts.scopes[item.scope].startOffset <= condition!.startIndex
            && facts.scopes[item.scope].endOffset >= condition!.endIndex)
            .sort((left, right) => right.scope - left.scope)[0];
          const type = binding?.value.kind === 'instance' ? binding.value.type : undefined;
          const flatten = (items: SymbolValue[]): SymbolValue[] => items.flatMap(item => item.kind === 'union' ? flatten(item.types) : [item]);
          const arms = type ? flatten(type.kind === 'union' ? type.types : [type]) : [];
          const matching = arms.filter(arm => {
            if (arm.kind !== 'name') return false;
            const armEntity = facts.bindings.find(item => item.scope === 0 && item.name === arm.name)?.value;
            return armEntity?.kind === 'entity' && expectedValues.includes(facts.discriminants?.[armEntity.qualifiedName]?.[propertyName] ?? '');
          });
          const remaining = arms.filter(arm => !matching.includes(arm));
          const add = (branch: Node | null, allowed: SymbolValue[]): void => {
            const scope = branchScopeFor(branch);
            if (!branch || scope === undefined || allowed.length === 0) return;
            const narrowed = allowed.length === 1 ? allowed[0] : { kind: 'union' as const, types: allowed };
            facts.narrowings!.push({ name: memberObject.text, type: narrowed, scope,
              startOffset: branch.startIndex, endOffset: branch.endIndex });
          };
          const equality = allEquality;
          const consequenceBranch = branchScopeFor(consequence);
          if (consequenceBranch !== undefined) facts.discriminantChecks!.push({ name: memberObject.text, property: propertyName,
            values: expectedValues, matches: equality, scope: consequenceBranch, startOffset: consequence.startIndex, endOffset: consequence.endIndex });
          const alternativeBranch = branchScopeFor(alternative);
          if (!consequenceOnly && alternative && alternativeBranch !== undefined) facts.discriminantChecks!.push({ name: memberObject.text, property: propertyName,
            values: expectedValues, matches: !equality, scope: alternativeBranch, startOffset: alternative.startIndex, endOffset: alternative.endIndex });
          add(consequence, equality ? matching : remaining);
          if (!consequenceOnly) add(alternative, equality ? remaining : matching);
        }
      }
      if (node.type === 'switch_statement') {
        const value = field(node, 'value')?.namedChild(0) ?? field(node, 'value');
        const object = value?.type === 'member_expression' ? field(value, 'object') : null;
        const property = value?.type === 'member_expression' ? field(value, 'property')?.text : undefined;
        const body = field(node, 'body');
        if (object?.type === 'identifier' && property && body) {
          const binding = facts.bindings.filter(item => item.name === object.text
            && item.scope < facts.scopes.length && facts.scopes[item.scope].startOffset <= node.startIndex
            && facts.scopes[item.scope].endOffset >= node.endIndex)
            .sort((left, right) => right.scope - left.scope)[0];
          const type = binding?.value.kind === 'instance' ? binding.value.type : undefined;
          const flatten = (items: SymbolValue[]): SymbolValue[] => items.flatMap(item => item.kind === 'union' ? flatten(item.types) : [item]);
          const arms = type ? flatten(type.kind === 'union' ? type.types : [type]) : [];
          const clauses = body.namedChildren.filter(child => child.type === 'switch_case' || child.type === 'switch_default');
          const seenValues: string[] = [];
          let fallthroughValues: string[] = [];
          for (const clause of clauses) {
            const caseValue = clause.type === 'switch_case' ? literalValue(clause.namedChild(0)?.namedChild(0) ?? clause.namedChild(0)) : undefined;
            const values = caseValue === undefined ? seenValues : [...new Set([...fallthroughValues, caseValue])];
            if (caseValue !== undefined) seenValues.push(caseValue);
            const discriminantFor = (arm: SymbolValue): string | undefined => {
              if (arm.kind !== 'name') return undefined;
              const armEntity = facts.bindings.find(item => item.scope === 0 && item.name === arm.name)?.value;
              return armEntity?.kind === 'entity' ? facts.discriminants?.[armEntity.qualifiedName]?.[property] : undefined;
            };
            const allKnown = arms.length > 0 && arms.every(arm => discriminantFor(arm) !== undefined);
            const allowed = caseValue === undefined ? fallthroughValues.length ? [] : allKnown ? arms.filter(arm => !seenValues.includes(discriminantFor(arm)!)) : [] : arms.filter(arm => {
              if (arm.kind !== 'name') return false;
              const armEntity = facts.bindings.find(item => item.scope === 0 && item.name === arm.name)?.value;
              return armEntity?.kind === 'entity' && values.includes(facts.discriminants?.[armEntity.qualifiedName]?.[property] ?? '');
            });
            const scope = branchScopeFor(clause);
            if (scope === undefined) continue;
            if (allowed.length) {
              const narrowed = allowed.length === 1 ? allowed[0] : { kind: 'union' as const, types: allowed };
              facts.narrowings!.push({ name: object.text, type: narrowed, scope, startOffset: clause.startIndex, endOffset: clause.endIndex });
            }
            // A default arm is the complement of all seen case values. The
            // resolver can apply this fact to imported arms using its global
            // discriminant map even when this file has no local declarations.
            if (caseValue !== undefined || !fallthroughValues.length) facts.discriminantChecks!.push({ name: object.text, property, values,
              matches: caseValue !== undefined, scope, startOffset: clause.startIndex, endOffset: clause.endIndex });
            const terminates = clause.namedChildren.some(child => ['break_statement', 'return_statement', 'throw_statement', 'continue_statement'].includes(child.type));
            fallthroughValues = !terminates && caseValue !== undefined ? values : [];
          }
        }
      }
      for (const child of node.namedChildren) collectNarrowings(child);
    };
    collectNarrowings(root);
  }
  if (language === 'python') {
    const collectPythonTypeChecks = (node: Node): void => {
      if (node.type === 'if_statement') {
        const parse = (candidate: Node | null | undefined, positive = true): { name: string; types: Node[]; positive: boolean } | undefined => {
          let item = candidate;
          while (item?.type === 'parenthesized_expression') item = item.namedChild(0);
          if (!item) return undefined;
          if (item.type === 'not_operator') return parse(item.namedChild(0), !positive);
          const call = item.type === 'call' && field(item, 'function')?.text === 'isinstance' ? item : undefined;
          const args = call ? field(call, 'arguments')?.namedChildren ?? [] : [];
          if (!call || args.length !== 2 || args[0].type !== 'identifier') return undefined;
          const types = args[1].type === 'identifier' ? [args[1]]
            : args[1].type === 'tuple' && args[1].namedChildren.every(child => child.type === 'identifier') ? args[1].namedChildren : [];
          return types.length ? { name: args[0].text, types, positive } : undefined;
        };
        const check = parse(field(node, 'condition'));
        if (check) {
          const consequence = field(node, 'consequence');
          const alternative = field(node, 'alternative');
          const alternativeBranch = alternative?.type === 'else_clause' ? alternative.namedChild(0) : alternative;
          const branchScope = (branch: Node | null): number | undefined => branch
            ? facts.scopes.filter(scope => scope.startOffset <= branch.startIndex && scope.endOffset >= branch.endIndex)
              .sort((left, right) => right.startOffset - left.startOffset)[0]?.id : undefined;
          const add = (branch: Node | null, positive: boolean) => {
            const scope = branchScope(branch);
            if (scope === undefined || !branch) return;
            const span = { name: check.name, scope, startOffset: branch.startIndex, endOffset: branch.endIndex };
            if (positive) facts.narrowings!.push({ ...span, type: check.types.length === 1 ? expression(check.types[0]) : { kind: 'union' as const, types: check.types.map(expression) } });
            else for (const type of check.types) facts.exclusions!.push({ ...span, type: expression(type) });
          };
          add(consequence, check.positive); add(alternativeBranch, !check.positive);
        }
      }
      for (const child of node.namedChildren) collectPythonTypeChecks(child);
    };
    collectPythonTypeChecks(root);
  }
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
  if (language === 'rust') {
    const copyTypes: string[] = [];
    const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'impl_item' && field(node, 'trait')?.text === 'Copy' && field(node, 'type')?.text) copyTypes.push(field(node, 'type')!.text);
      pending.push(...node.namedChildren);
    }
    const collectDerivedCopy = (container: Node): void => {
      const children = container.namedChildren;
      for (let index = 0; index < children.length; index++) {
        const attribute = children[index];
        if (attribute.type !== 'attribute_item' || !/derive\s*\([^)]*\bCopy\b/.test(attribute.text)) continue;
        let next = index + 1;
        while (next < children.length && children[next].type === 'attribute_item') next++;
        const declaration = children[next];
        const name = declaration && ['struct_item', 'enum_item', 'union_item'].includes(declaration.type)
          ? field(declaration, 'name')?.text : undefined;
        const typeParameters = declaration?.namedChildren.find(child => child.type === 'type_parameters');
        const generic = !!typeParameters;
        const genericParameters = typeParameters?.namedChildren.filter(child => child.type === 'type_parameter') ?? [];
        const inlineCopyBounds = new Set(genericParameters
          .filter(parameter => parameter.namedChildren.some(child => child.type === 'trait_bounds'
            && child.namedChildren.some(bound => bound.text === 'Copy')))
          .map(parameter => parameter.namedChild(0)?.text).filter((name): name is string => !!name));
        const whereClause = declaration?.namedChildren.find(child => child.type === 'where_clause');
        const whereCopyBounds = new Set((whereClause?.namedChildren ?? [])
          .filter(predicate => predicate.type === 'where_predicate'
            && predicate.namedChildren.some(child => child.type === 'trait_bounds'
              && child.namedChildren.some(bound => bound.text === 'Copy')))
          .map(predicate => predicate.namedChild(0)?.text).filter((name): name is string => !!name));
        const genericCopySafe = !!typeParameters && genericParameters.length > 0
          && genericParameters.every(parameter => {
            const name = parameter.namedChild(0)?.text;
            return !!name && (inlineCopyBounds.has(name) || whereCopyBounds.has(name));
          });
        // A generic derive(Copy) is conditional on every specialization's
        // type arguments. It is safe to promote only when every declared type
        // parameter carries an explicit Copy bound; where-clause solving and
        // unconstrained specializations remain conservative.
        if (name && (!generic || genericCopySafe)) copyTypes.push(name);
      }
      for (const child of children) collectDerivedCopy(child);
    };
    collectDerivedCopy(root);
    facts.copyTypes = [...new Set(copyTypes)];
  }
  return facts;
}
