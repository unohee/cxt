/** 문자열·주석·정규식 내용을 공백으로 가리되 줄바꿈과 코드 위치는 보존한다. */
export function maskLiteralsAndComments(source: string, language?: string): string {
  if (language === 'python') return maskPythonLiteralsAndComments(source);
  let out = '';
  let state: 'code' | 'single' | 'double' | 'template' | 'line-comment' | 'block-comment' | 'regex' = 'code';
  let escaped = false;
  let regexCharClass = false;
  let prevCode = '';
  let recentWord = '';
  let controlParenDepth: number | undefined;
  let afterControlHead = false;
  const masked = (ch: string) => ch === '\n' || ch === '\r' ? ch : ' ';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1] ?? '';
    if (state === 'line-comment') {
      if (ch === '\n') { state = 'code'; out += ch; } else out += ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { out += '  '; i++; state = 'code'; }
      else out += masked(ch);
      continue;
    }
    if (state !== 'code') {
      out += masked(ch);
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (state === 'regex') {
        if (ch === '[') regexCharClass = true;
        else if (ch === ']') regexCharClass = false;
        else if (ch === '/' && !regexCharClass) state = 'code';
        continue;
      }
      if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') ||
          (state === 'template' && ch === '`')) state = 'code';
      continue;
    }
    if (ch === '/' && next === '/') { out += '  '; i++; state = 'line-comment'; continue; }
    if (ch === '/' && next === '*') { out += '  '; i++; state = 'block-comment'; continue; }
    if (ch === "'") { out += ' '; state = 'single'; recentWord = ''; afterControlHead = false; continue; }
    if (ch === '"') { out += ' '; state = 'double'; recentWord = ''; afterControlHead = false; continue; }
    if (ch === '`') { out += ' '; state = 'template'; recentWord = ''; afterControlHead = false; continue; }
    const followsRegexKeyword = /^(?:return|throw|case|yield|await|typeof|delete|void|new|in|of|else|do)$/.test(recentWord);
    if (ch === '/' && (afterControlHead || !prevCode || followsRegexKeyword || /[({[=,:;!?&|+*%~<>]/.test(prevCode))) {
      out += ' '; state = 'regex'; regexCharClass = false; recentWord = ''; afterControlHead = false; continue;
    }
    out += ch;
    if (!/\s/.test(ch)) {
      if (ch === '(') {
        if (controlParenDepth !== undefined) controlParenDepth++;
        else if (/^(?:if|while|for|with)$/.test(recentWord)) controlParenDepth = 1;
      } else if (ch === ')' && controlParenDepth !== undefined && --controlParenDepth === 0) {
        controlParenDepth = undefined;
        afterControlHead = true;
      } else if (afterControlHead) afterControlHead = false;
      prevCode = ch;
      if (/[A-Za-z_]/.test(ch)) recentWord += ch;
      else recentWord = '';
    }
  }
  return language === undefined || language === 'typescript' || language === 'javascript'
    ? restoreTemplateExpressions(source, out)
    : out;
}

function restoreTemplateExpressions(source: string, masked: string): string {
  const result = [...masked];
  let inTemplate = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '`') { inTemplate = !inTemplate; continue; }
    if (!inTemplate || ch !== '$' || source[i + 1] !== '{') continue;

    let depth = 1;
    let quote: string | undefined;
    let innerEscaped = false;
    const start = i + 2;
    let end = start;
    for (; end < source.length && depth > 0; end++) {
      const current = source[end];
      if (quote) {
        if (innerEscaped) innerEscaped = false;
        else if (current === '\\') innerEscaped = true;
        else if (current === quote) quote = undefined;
        continue;
      }
      if (current === "'" || current === '"' || current === '`') { quote = current; continue; }
      if (current === '{') depth++;
      else if (current === '}') depth--;
    }
    if (depth !== 0) continue;
    const expressionEnd = end - 1;
    const expressionMasked = maskLiteralsAndComments(source.slice(start, expressionEnd));
    for (let j = 0; j < expressionMasked.length; j++) result[start + j] = expressionMasked[j];
    i = expressionEnd;
  }
  return result.join('');
}

function maskPythonLiteralsAndComments(source: string): string {
  let out = '';
  let quote: "'" | '"' | "'''" | '"""' | undefined;
  let escaped = false;
  const blank = (ch: string) => ch === '\n' || ch === '\r' ? ch : ' ';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (quote.length === 3 && source.startsWith(quote, i)) {
        out += '   '; i += 2; quote = undefined; continue;
      }
      out += blank(ch);
      if (quote.length === 1) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = undefined;
      }
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i++; }
      if (i < source.length) out += source[i];
      continue;
    }
    if (source.startsWith("'''", i) || source.startsWith('"""', i)) {
      quote = source.slice(i, i + 3) as "'''" | '"""'; out += '   '; i += 2; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ' '; continue; }
    out += ch;
  }
  return out;
}
