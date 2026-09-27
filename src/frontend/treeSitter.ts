import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type Parser from 'tree-sitter';
import type { EntityKind } from '../registry/schema.js';
import type { ExtractedEntity, ReferenceSet } from '../registry/entityScanner.js';
import { entityQualifiedName, FrontendError } from './types.js';
import type { AstLanguage, FrontendResult, LanguageFrontend } from './types.js';
import { extractSymbolFacts } from './symbolFacts.js';
import { buildControlFlow } from './controlFlow.js';

type Node = Parser.SyntaxNode;
const require = createRequire(import.meta.url);
const CALLABLE = new Set(['function_declaration', 'generator_function_declaration', 'function_signature',
  'method_definition', 'abstract_method_signature', 'arrow_function', 'function_expression',
  'generator_function', 'function_definition', 'lambda', 'function_item', 'function_signature_item', 'closure_expression']);
const CLASS = new Set(['class', 'class_declaration', 'abstract_class_declaration', 'class_definition', 'struct_item']);
const TYPE = new Set(['interface_declaration', 'type_alias_declaration', 'enum_declaration',
  'enum_item', 'trait_item', 'type_item']);
const BLOCK = new Set(['statement_block', 'block', 'class_body', 'declaration_list']);
const COMMENT = new Set(['comment', 'line_comment', 'block_comment']);

interface Declaration {
  node: Node;
  callable: Node;
  range: Node;
  name: string;
  kind: EntityKind;
  scopedName?: string;
}

/** Optional native dependencies are loaded only at the frontend boundary. */
export function loadTreeSitterFrontend(language: AstLanguage, filePath: string): LanguageFrontend {
  let parser: Parser;
  let grammar: Parser.Language;
  let Query: typeof Parser.Query;
  const javascript = language === 'typescript' && /\.(?:jsx?|mjs|cjs)$/.test(filePath);
  try {
    const NativeParser = require('tree-sitter') as typeof Parser;
    Query = NativeParser.Query;
    grammar = javascript ? require('tree-sitter-javascript') as Parser.Language : language === 'typescript'
      ? (require('tree-sitter-typescript') as Record<string, Parser.Language>)[/\.[jt]sx$/.test(filePath) ? 'tsx' : 'typescript']
      : require(`tree-sitter-${language}`) as Parser.Language;
    parser = new NativeParser();
    parser.setLanguage(grammar);
    parser.setTimeoutMicros(500_000);
  } catch (error) {
    throw new FrontendError({ code: 'parser-unavailable', filePath,
      message: `${language}: ${error instanceof Error ? error.message : String(error)}` });
  }
  // 배포 누락이나 쿼리 결함은 parser 부재와 다르므로 fallback으로 숨기지 않는다.
  const query = new Query(grammar, readFileSync(new URL(`./queries/${javascript ? 'javascript' : language}.scm`, import.meta.url), 'utf8'));
  return { language, extract: (content, path) => extract(parser, query, language, content, path) };
}

function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}

function* ancestors(node: Node): Generator<Node> {
  let parent = node.parent;
  while (parent) { yield parent; parent = parent.parent; }
}

function bindingNames(node: Node): Node[] {
  if (['identifier', 'shorthand_property_identifier_pattern', 'property_identifier', 'type_identifier'].includes(node.type)) return [node];
  if (['pair_pattern', 'assignment_pattern', 'object_assignment_pattern'].includes(node.type)) {
    const binding = field(node, 'value') ?? field(node, 'left');
    return binding ? bindingNames(binding) : [];
  }
  if (['object_pattern', 'array_pattern', 'rest_pattern', 'pattern_list', 'tuple_pattern', 'list_pattern'].includes(node.type)) {
    return node.namedChildren.flatMap(bindingNames);
  }
  return [];
}

function declarations(node: Node, language: AstLanguage): Declaration[] {
  let kind: EntityKind;
  let callable = node;
  let names = field(node, 'name') ?? field(node, 'property');
  let range = node;
  if (CALLABLE.has(node.type)) kind = 'function';
  else if (CLASS.has(node.type)) kind = 'class';
  else if (TYPE.has(node.type)) kind = 'type';
  else if (['internal_module', 'mod_item'].includes(node.type)) kind = 'module';
  else {
    const value = field(node, 'value') ?? field(node, 'right');
    const isCallable = value && CALLABLE.has(value.type);
    if (!isCallable && [...ancestors(node)].some(n => CALLABLE.has(n.type))) return [];
    if (['public_field_definition', 'field_definition'].includes(node.type) && !isCallable) return [];
    kind = isCallable ? 'function' : 'constant';
    if (isCallable) callable = value;
    names ??= field(node, 'left');
    if (node.type === 'variable_declarator' && node.parent?.namedChildCount === 1) range = node.parent;
  }
  if (range.parent?.type === 'export_statement' || range.parent?.type === 'decorated_definition') range = range.parent;
  // A default export is a named module binding even when its declaration is anonymous.
  const bindings = names ? bindingNames(names).map(n => n.text) : [];
  if (!bindings.length && language === 'typescript' && range.type === 'export_statement') bindings.push('default');
  return bindings.map(name => ({ node, callable, range, name, kind }));
}

function scopeOf(declaration: Declaration, byNode: Map<number, Declaration[]>): string {
  const scopes: string[] = [];
  for (const parent of ancestors(declaration.node)) {
    if (parent.type === 'impl_item') {
      const target = field(parent, 'type')?.text ?? 'impl';
      const trait = field(parent, 'trait')?.text;
      scopes.unshift(trait ? `<${target} as ${trait}>` : target);
    } else {
      const owner = byNode.get(parent.id)?.[0];
      if (owner) scopes.unshift(owner.name);
    }
  }
  return [...scopes, declaration.name].join('.');
}

function metrics(declaration: Declaration): Pick<ExtractedEntity, 'loc' | 'nestingDepth' | 'paramCount'> {
  const root = declaration.callable;
  const params = field(root, 'parameters');
  const paramCount = params
    ? params.namedChildren.filter(n => !COMMENT.has(n.type) && !['positional_separator', 'keyword_separator'].includes(n.type)).length
    : field(root, 'parameter') ? 1 : 0;
  let nestingDepth = 0;
  const stack = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (node.id !== root.id && (CALLABLE.has(node.type) || CLASS.has(node.type))) continue;
    const next = depth + (BLOCK.has(node.type) ? 1 : 0);
    nestingDepth = Math.max(nestingDepth, next);
    for (const child of node.namedChildren) stack.push({ node: child, depth: next });
  }
  return { loc: declaration.range.text.split('\n').filter(line => line.trim()).length, nestingDepth, paramCount };
}

function lastName(node: Node | null): string | undefined {
  if (!node) return undefined;
  if (['identifier', 'property_identifier', 'field_identifier', 'type_identifier'].includes(node.type)) return node.text;
  const member = field(node, 'property') ?? field(node, 'attribute') ?? field(node, 'field') ?? field(node, 'name');
  if (member) return lastName(member);
  if (node.type === 'generic_function') return lastName(field(node, 'function'));
  return undefined;
}

function references(declaration: Declaration, byNode: Map<number, Declaration[]>): ReferenceSet {
  const callNames = new Set<string>();
  const baseNames = new Set<string>();
  const stack = [declaration.callable];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.id !== declaration.callable.id && (byNode.has(node.id) || CALLABLE.has(node.type) || CLASS.has(node.type))) continue;
    if (['call_expression', 'call', 'new_expression'].includes(node.type)) {
      const name = lastName(field(node, 'function') ?? field(node, 'constructor'));
      if (name) callNames.add(name);
    }
    if (['extends_clause', 'implements_clause', 'superclasses'].includes(node.type)
      || node.id === field(declaration.node, 'superclasses')?.id) {
      for (const child of node.namedChildren) { const name = lastName(child); if (name) baseNames.add(name); }
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  // Name resolution is still heuristic until AGT-4565. Never claim symbol-resolved edges here.
  return { callNames, baseNames, importPaths: new Set() };
}

function extract(parser: Parser, query: Parser.Query, language: AstLanguage, content: string, filePath: string): FrontendResult {
  const tree = parser.parse(content);
  if (!tree) throw new FrontendError({ code: 'syntax-error', filePath, message: 'Parser timeout or cancellation' });
  if (tree.rootNode.hasError) {
    let error = tree.rootNode;
    while (true) {
      const child = error.children.find(n => n.hasError || n.isMissing);
      if (!child) break;
      error = child;
    }
    throw new FrontendError({ code: 'syntax-error', filePath, message: `Invalid ${language} syntax`,
      line: error.startPosition.row + 1, column: error.startPosition.column + 1 });
  }
  const found = query.captures(tree.rootNode).flatMap(capture => declarations(capture.node, language));
  const claimed = new Set(found.map(declaration => declaration.callable.id));
  const stack = [tree.rootNode];
  while (stack.length) {
    const node = stack.pop()!;
    if (CALLABLE.has(node.type) && field(node, 'body') && !claimed.has(node.id)) {
      // Anonymous callbacks own their calls; attributing those calls to the
      // surrounding function would fabricate synchronous call edges.
      found.push({ node, callable: node, range: node, kind: 'function',
        name: `<lambda@${node.startPosition.row + 1}:${node.startPosition.column + 1}>` });
      claimed.add(node.id);
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  found.sort((a, b) => a.node.startIndex - b.node.startIndex);
  const byNode = new Map<number, Declaration[]>();
  for (const declaration of found) {
    const siblings = byNode.get(declaration.node.id) ?? [];
    siblings.push(declaration); byNode.set(declaration.node.id, siblings);
  }
  const counts = new Map<string, number>();
  for (const declaration of found) {
    declaration.scopedName = scopeOf(declaration, byNode);
    counts.set(declaration.scopedName, (counts.get(declaration.scopedName) ?? 0) + 1);
  }
  const refs = new Map<string, ReferenceSet>();
  const entities = found.map(declaration => {
    const { range, name, kind, node, callable } = declaration;
    let scopedName = declaration.scopedName!;
    // Overloads and repeated bindings must not silently collide in the registry.
    if (counts.get(scopedName)! > 1) scopedName += `@${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
    const body = field(callable, 'body');
    const entity: ExtractedEntity = {
      kind, name, scopedName, filePath,
      lineStart: range.startPosition.row + 1,
      lineEnd: range.endPosition.row + (range.endPosition.column === 0 ? 0 : 1),
      signature: content.slice(callable.startIndex, body?.startIndex ?? callable.endIndex).trim(),
      isExported: language === 'typescript' ? range.type === 'export_statement'
        || (node.type === 'variable_declarator' && node.parent?.parent?.type === 'export_statement')
        : language === 'rust' ? node.namedChildren.some(child => child.type === 'visibility_modifier')
        : !name.startsWith('_'),
      ...metrics(declaration),
    };
    if (kind === 'function' || kind === 'class') refs.set(entityQualifiedName(entity), references(declaration, byNode));
    return entity;
  });
  const symbols = extractSymbolFacts(tree.rootNode, language, filePath,
    found.map((declaration, index) => ({ node: declaration.node, callable: declaration.callable, entity: entities[index] })));
  const controlFlow = found.flatMap((declaration, index) => declaration.kind === 'function' && field(declaration.callable, 'body')
    ? [buildControlFlow(declaration.callable, filePath, entityQualifiedName(entities[index]), language)] : []);
  return { engine: 'ast', entities, references: refs, diagnostics: [], symbols, controlFlow };
}
