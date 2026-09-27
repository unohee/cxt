import type Parser from 'tree-sitter';
import { parseSyntaxTree } from '../frontend/nativeParser.js';
import type { AstLanguage } from '../frontend/types.js';
import type { SourceSpan } from './cfg.js';
import { builtInRules, pathRole, type RuleConfig, type RuleDefinition } from './rulePack.js';

type Node = Parser.SyntaxNode;
export interface StructuralFinding { rule: RuleDefinition; span: SourceSpan; matchedText: string;
  flow?: { owner: string; definitions: string[]; steps: SourceSpan[] } }
const field = (node: Node, key: string) => node.childForFieldName(key);
const isComment = (node: Node) => ['comment', 'line_comment', 'block_comment'].includes(node.type);
const functions = new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'function_definition', 'lambda', 'function_item', 'closure_expression']);
const strings = new Set(['string', 'string_literal', 'raw_string_literal', 'template_string']);
const span = (node: Node): SourceSpan => ({ line: node.startPosition.row + 1, column: node.startPosition.column + 1,
  endLine: node.endPosition.row + 1, endColumn: node.endPosition.column + 1, startOffset: node.startIndex, endOffset: node.endIndex });
function unwrap(node: Node | null): Node | null {
  while (node?.type === 'parenthesized_expression') node = node.namedChildren[0] ?? null;
  return node;
}
function children(node: Node): Node[] { return node.namedChildren.filter(child => !isComment(child)); }
function ancestors(node: Node): Node[] {
  const result: Node[] = []; let current = node.parent;
  while (current) { result.push(current); current = current.parent; }
  return result;
}
function literal(node: Node | null): string | undefined {
  node = unwrap(node);
  if (!node || !strings.has(node.type) || node.descendantsOfType(['interpolation', 'template_substitution']).length) return undefined;
  const text = node.text;
  const quote = text.match(/^[rubf]*(["'`])\1\1|^[rubf]*(["'`])/i);
  if (quote) return text.slice(quote[0].length, -((quote[1] ?? '').length ? 3 : 1));
  if (node.type === 'raw_string_literal') return text.replace(/^r#*"|"#*$/g, '');
  return undefined;
}
function callee(node: Node): string | undefined {
  return field(node, 'function')?.text.replaceAll(/\s+/g, '');
}
function valueAndName(node: Node): { name: string; value: Node } | undefined {
  const key = field(node, 'name') ?? field(node, 'left') ?? field(node, 'key') ?? field(node, 'pattern');
  const value = field(node, 'value') ?? field(node, 'right');
  return key && value ? { name: literal(key) ?? key.text, value } : undefined;
}
function numericValue(node: Node): number | undefined {
  if (!['number', 'integer', 'integer_literal', 'float', 'float_literal'].includes(node.type)) return undefined;
  const text = node.text.replaceAll('_', '').replace(/(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))$/, '');
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}
const statusName = (text: string) => /(?:^|[._])(?:status(?:_code)?|last_status|code)(?:$|[._])/.test(text);
const numericDomainName = (text: string) => /(?:^|[._])(?:timeout|limit|maximum|minimum|max|min|port|size|width|height|delay|interval|ms|seconds|sec|ttl|tokens|length|default)(?:$|[._])/
  .test(text.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());

/** 점으로 나눈 octet 배열의 단일 대입 projection만 IP 비교 문맥으로 인정한다. */
function ipv4Comparison(node: Node): boolean {
  const parents = ancestors(node), comparison = parents.find(parent => parent.type === 'comparison_operator');
  const owner = parents.find(parent => parent.type === 'function_definition');
  if (!comparison || !owner) return false;
  const assignments = owner.descendantsOfType('assignment').filter(assignment => ancestors(assignment).find(parent => parent.type === 'function_definition')?.id === owner.id);
  const names = (pattern: Node | null): string[] => !pattern ? [] : pattern.type === 'identifier' ? [pattern.text] : pattern.descendantsOfType('identifier').map(id => id.text);
  const writes = new Map<string, number>();
  for (const assignment of assignments) for (const name of names(field(assignment, 'left'))) writes.set(name, (writes.get(name) ?? 0) + 1);
  const arrays = new Set(assignments.filter(assignment => {
    const left = field(assignment, 'left'), right = field(assignment, 'right');
    return left?.type === 'identifier' && /(?:^|_)octets$/.test(left.text) && writes.get(left.text) === 1 && assignment.endIndex < node.startIndex
      && right?.descendantsOfType('call').some(call => callee(call)?.endsWith('.split') && literal(field(call, 'arguments')?.namedChildren[0] ?? null) === '.');
  }).map(assignment => field(assignment, 'left')!.text));
  if (!arrays.size) return false;
  const octets = new Set<string>();
  for (const assignment of assignments) {
    if (assignment.endIndex >= node.startIndex) continue;
    const left = field(assignment, 'left'), right = field(assignment, 'right');
    const targets = names(left), values = right?.type === 'expression_list' ? right.namedChildren : right ? [right] : [];
    if (targets.length === values.length) values.forEach((value, i) => {
      if (value.type === 'subscript' && arrays.has(field(value, 'value')?.text ?? '') && /^[0-3]$/.test(field(value, 'subscript')?.text ?? '')
        && writes.get(targets[i]) === 1) octets.add(targets[i]);
    });
  }
  const comprehension = parents.find(parent => parent.type === 'generator_expression');
  for (const clause of comprehension?.namedChildren.filter(child => child.type === 'for_in_clause') ?? []) {
    if (arrays.has(field(clause, 'right')?.text ?? '') && field(clause, 'left')?.type === 'identifier') octets.add(field(clause, 'left')!.text);
  }
  return comparison.namedChildren.some(child => child.type === 'identifier' && octets.has(child.text));
}

/** 숫자가 아닌 AST 문맥을 먼저 확인해 상수/HTTP 도메인과 산술 리터럴을 구분한다. */
function magicNumber(node: Node): boolean {
  const number = numericValue(node);
  if (number === undefined || !/^\d[\d_]*$/.test(node.text) || !Number.isInteger(number) || Math.abs(number) < 100 || [100, 1000, 1024, 365].includes(number)) return false;
  const parents = ancestors(node), binding = parents.find(parent => ['variable_declarator', 'assignment', 'const_item', 'static_item', 'let_declaration'].includes(parent.type));
  if (parents.some(parent => ['slice', 'slice_expression', 'typed_default_parameter', 'default_parameter'].includes(parent.type))) return false;
  const named = parents.find(parent => ['keyword_argument', 'pair'].includes(parent.type));
  if (named && numericDomainName(valueAndName(named)?.name ?? '')) return false;
  if (binding) {
    const pair = valueAndName(binding), direct = unwrap(pair?.value ?? null);
    if (pair && (/^_*[A-Z][A-Z0-9_]*$/.test(pair.name) || ['const_item', 'static_item'].includes(binding.type)
      || direct?.id === node.id && binding.parent?.type === 'lexical_declaration' && binding.parent.children[0]?.text === 'const'
      || numericDomainName(pair.name))) return false;
  }
  if (number >= 100 && number <= 599) {
    const keyword = parents.find(parent => ['keyword_argument', 'pair'].includes(parent.type));
    if (keyword && statusName(valueAndName(keyword)?.name ?? '')) return false;
    const comparison = parents.find(parent => ['comparison_operator', 'binary_expression'].includes(parent.type));
    if (comparison && comparison.children.some(child => ['==', '!=', '===', '!==', '<', '>', '<=', '>=', 'in', 'not in'].includes(child.text))
      && comparison.namedChildren.some(child => statusName(child.text))) return false;
    // HTTP 상태 변수로 대입하는 ternary의 양쪽 결과도 도메인 값이다.
    if (binding && statusName(valueAndName(binding)?.name ?? '') && !parents.some(parent => ['binary_operator', 'binary_expression'].includes(parent.type)
      && parent.children.some(child => ['+', '-', '*', '/', '%'].includes(child.text)))) return false;
    const call = parents.find(parent => ['call', 'call_expression'].includes(parent.type));
    if (call && /(?:^|\.)(?:HTTPException|raise_for_status)$/.test(callee(call) ?? '')) return false;
  }
  // IP 주소 문맥만 좁게 인정한다. 192 등의 값 자체로는 제외하지 않는다.
  if (number <= 255 && ipv4Comparison(node)) return false;
  const expression = parents.find(parent => ['boolean_operator', 'comparison_operator', 'binary_expression'].includes(parent.type));
  if (number <= 255 && expression && /(?:ip|octet|addr)/i.test(expression.text)) {
    const values = expression.descendantsOfType(['integer', 'number', 'integer_literal']).map(numericValue).filter((n): n is number => n !== undefined);
    if (values.length >= 2 && values.every(value => value >= 0 && value <= 255)) return false;
  }
  return true;
}

type HandlerExit = 'propagate' | 'fallthrough' | 'swallow';
/** 내부 callback의 throw와 바깥 handler를 구분하고 각 분기의 조기 종료를 보존한다. */
function handlerExits(node: Node): Set<HandlerExit> {
  if (functions.has(node.type)) return new Set(['fallthrough']);
  if (node.type === 'throw_statement') return new Set(['propagate']);
  if (node.type === 'return_statement') {
    const expression = unwrap(children(node)[0] ?? null);
    return new Set([expression?.type === 'call_expression' && /^(?:Promise\.reject|reject)$/.test(callee(expression) ?? '') ? 'propagate' : 'swallow']);
  }
  if (node.type === 'expression_statement') {
    const call = children(node)[0];
    return new Set([call?.type === 'call_expression' && /^(?:process\.exit|reject|Promise\.reject)$/.test(callee(call) ?? '') ? 'propagate' : 'fallthrough']);
  }
  if (node.type === 'if_statement') {
    const yes = field(node, 'consequence'), no = field(node, 'alternative');
    return new Set([...(yes ? handlerExits(yes) : ['fallthrough' as const]), ...(no ? handlerExits(no) : ['fallthrough' as const])]);
  }
  if (['statement_block', 'else_clause'].includes(node.type)) {
    const exits = new Set<HandlerExit>(['fallthrough']);
    for (const child of children(node)) if (exits.delete('fallthrough')) for (const exit of handlerExits(child)) exits.add(exit);
    return exits;
  }
  if (['break_statement', 'continue_statement'].includes(node.type)) return new Set(['swallow']);
  return new Set(['fallthrough', ...(node.descendantsOfType(['return_statement', 'break_statement', 'continue_statement']).length ? ['swallow' as const] : [])]);
}

export function analyzeAstRules(content: string, filePath: string, language: AstLanguage, config?: RuleConfig, additional: StructuralFinding[] = []): StructuralFinding[] {
  const root = parseSyntaxTree(language, filePath, content).rootNode;
  const nodes: Node[] = [], stack = [root];
  while (stack.length) { const node = stack.pop()!; nodes.push(node); stack.push(...node.namedChildren.reverse()); }
  const comments = nodes.filter(isComment), rules = new Map(builtInRules.map(rule => [rule.id.slice(4), rule]));
  const role = pathRole(filePath, config), lines = content.split('\n'), findings: StructuralFinding[] = [];
  const ignored = (line: number, category: string): boolean => comments.some(comment => {
    const marker = comment.text.match(/^(?:\/\/|\/\*|#)\s*cxt-ignore(-next-line)?\b(?:\s*:\s*([a-z_]+(?:\s*,\s*[a-z_]+)*))?/);
    if (!marker || comment.startPosition.row + (marker[1] ? 2 : 1) !== line) return false;
    return !marker[2] || marker[2].split(',').map(value => value.trim()).includes(category);
  });
  function emit(id: string, node: Node, matchedText = node.text): void {
    const rule = rules.get(id)!;
    if (!rule.languages.includes(language) || rule.ignoredRoles.includes(role) || ignored(node.startPosition.row + 1, rule.category)) return;
    findings.push({ rule, span: span(node), matchedText: matchedText.slice(0, 80) });
  }
  for (const finding of additional) if (!finding.rule.ignoredRoles.includes(role) && !ignored(finding.span.line, finding.rule.category)) findings.push(finding);
  const hasInline = (node: Node, pattern: RegExp) => comments.some(comment => comment.startPosition.row === node.startPosition.row && pattern.test(comment.text));

  for (const node of nodes) {
    const kind = node.type;
    if (isComment(node) && /^(?:\/\/|#|\/\*)\s*(?:TODO|FIXME|XXX|HACK)\b/i.test(node.text)) emit('todo-comment', node);
    if (kind === 'debugger_statement') emit('debugger-statement', node);
    if (kind === 'except_clause') {
      const body = node.namedChildren.find(child => child.type === 'block');
      if (body && children(body).length === 1 && children(body)[0].type === 'pass_statement') emit(field(node, 'value') ? 'typed-except-pass' : 'bare-except-pass', node);
    }
    if (kind === 'catch_clause') {
      const body = field(node, 'body');
      if (body && [...handlerExits(body)].some(exit => exit !== 'propagate')) emit('catch-swallow', node);
    }
    if (kind === 'return_statement') {
      const returned = unwrap(children(node)[0] ?? null), text = literal(returned);
      if ((returned?.type === 'true' || text === 'ok' || text === 'success') && hasInline(node, /(?:always|todo|fixme|hack)/i)) emit('marked-success-return', node);
    }
    if (['variable_declarator', 'assignment', 'assignment_expression', 'pair', 'const_item', 'let_declaration'].includes(kind)) {
      const pair = valueAndName(node), text = literal(pair?.value ?? null);
      if (pair && /(?:password|secret|api_key|apikey|token|private_key)/i.test(pair.name) && text !== undefined && text.length >= 8
        && !(pair.name === 'token' && /^[a-z_]+$/.test(text))) emit('hardcoded-secret', node, `${pair.name} = <redacted literal>`);
    }
    if (kind === 'as_expression' && children(node).at(-1)?.text === 'any') emit('as-any', node);
    if (kind === 'predefined_type' && node.text === 'any' && node.parent?.type === 'type_annotation') emit('any-type', node);
    if (kind === 'non_null_expression') emit('non-null-assertion', node);
    if (kind === 'macro_invocation') {
      const name = field(node, 'macro')?.text;
      if (name === 'todo' || name === 'unimplemented' || name === 'panic' && /["'](?:TODO|FIXME)/i.test(node.text)) emit('rust-incomplete', node);
    }
    if (['call_expression', 'call'].includes(kind)) {
      const name = callee(node) ?? '', arguments_ = field(node, 'arguments')?.namedChildren ?? [];
      if (name === 'eval') emit('eval-call', node);
      if (name === 'console.log') emit('console-log', node);
      const text = literal(arguments_[0] ?? null);
      if (['console.log', 'print'].includes(name) && text && /(?:완료|성공)(?![가-힣])|\b(?:done|finished|success|passed)\b/i.test(text)) emit('success-log', node);
      if (language === 'python' && /^(?:np\.random\.|numpy\.random\.|faker\.|fake\.)|^Faker$/.test(name)
        && !/(?:seed|random_state|RandomState|default_rng)/.test(node.text)) emit('python-fake-data', node);
      if (language === 'rust') {
        if (/\.(?:unwrap|expect)$/.test(name) && !hasInline(node, /\/\/\s*(?:SAFETY:|invariant)/i)) emit('rust-unwrap', node);
        const discarded = /\.ok$/.test(name) && node.parent?.type === 'expression_statement'
          || node.parent?.type === 'let_declaration' && node.parent.children.some(child => child.text === '_');
        if (discarded && !hasInline(node, /\/\/\s*(?:reason|intentional|ignore)/i)) emit('rust-discard-error', node);
      }
    }
    if (strings.has(kind)) {
      const text = literal(node);
      const docstring = language === 'python' && node.parent?.type === 'expression_statement';
      if (!docstring && text && /(?:example\.com|localhost:\d{4}|127\.0\.0\.1:\d{4})/.test(text)) emit('placeholder-url', node);
    }
    if (magicNumber(node)) emit('magic-number', node);
  }
  for (let line = 0; line < lines.length; line++) {
    if (lines[line].length < 200 || /https?:\/\//.test(lines[line])) continue;
    const code = nodes.filter(node => !isComment(node) && node.namedChildCount === 0 && node.startPosition.row === line && !ancestors(node).some(parent => strings.has(parent.type) || isComment(parent)));
    if (!code.length || code.some(node => ancestors(node).some(parent => parent.type.includes('import')))) continue;
    emit('long-line', code[0], lines[line]);
  }
  const unique = new Map(findings.map(finding => [`${finding.rule.id}:${finding.span.startOffset}:${finding.span.endOffset}`, finding]));
  return [...unique.values()].sort((a, b) => a.span.startOffset - b.span.startOffset || a.rule.id.localeCompare(b.rule.id));
}
