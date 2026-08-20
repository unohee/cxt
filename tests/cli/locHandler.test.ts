import { describe, expect, it } from 'vitest';
import { countLines } from '../../src/cli/locHandler.js';
import { resolveProjectDirFilter } from '../../src/cli/outputSafety.js';

describe('countLines', () => {
  it('ignores block-comment markers inside strings and line comments', () => {
    const source = [
      'const marker = "/*";',
      '// /*',
      'const stillCode = 1;',
      '/* real block',
      ' * continued',
      ' */',
      'const tail = 2;',
    ].join('\n');

    expect(countLines(source, '.ts')).toEqual({ total: 7, blank: 0, comment: 4 });
  });

  it('preserves multiline template literal state across physical lines', () => {
    const source = ['const text = `first', '/* literal marker', 'still literal`;', 'const code = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 4, blank: 0, comment: 0 });
  });

  it('does not interpret comment delimiters inside regex literals', () => {
    const source = ['const marker = /\\/\\*/;', 'const code = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 2, blank: 0, comment: 0 });
  });

  it('recognizes regex literals after return keywords', () => {
    const source = ['function marker() {', '  return /[/*]/;', '}', 'const code = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 4, blank: 0, comment: 0 });
  });

  it('recognizes regex literals after arrow expressions', () => {
    const source = ['const marker = () => /[/*]/;', 'const code = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 2, blank: 0, comment: 0 });
  });

  it('recognizes regex literals after await expressions', () => {
    const source = ['const marker = await /[/*]/.exec(text);', 'const code = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 2, blank: 0, comment: 0 });
  });

  it('recognizes regex expression statements after control-flow heads', () => {
    const source = ['if (ok) /[/*]/.test(value);', 'const code = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 2, blank: 0, comment: 0 });
  });

  it('recognizes regex expression statements after else', () => {
    const source = ['if (ok) value(); else /[/*]/.test(value);', 'const code = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 2, blank: 0, comment: 0 });
  });

  it('recognizes regex literals after yield-star expressions', () => {
    const source = ['function* values() { yield* /[/*]/; }', 'const code = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 2, blank: 0, comment: 0 });
  });

  it('recognizes spaced yield-star and unbraced control-flow regexes', () => {
    const source = ['function* values() { yield * /[/*]/; }', 'if (ok) /[/*]/.test(value);'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 2, blank: 0, comment: 0 });
  });

  it('recognizes regexes after nested control-flow conditions', () => {
    const source = ['if (check(value)) /[/*]/.test(value);', 'const tail = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 2, blank: 0, comment: 0 });
  });

  it('does not confuse division after a regex literal with another regex', () => {
    const source = ['const n = /x/ / /[/*]/.test(s);', 'const tail = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 2, blank: 0, comment: 0 });
  });

  it('keeps regex-versus-division context across physical lines', () => {
    const source = ['const n = value', '/ /[/*]/.test(s);', 'const tail = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 3, blank: 0, comment: 0 });
  });

  it('tracks division context after string and template literals', () => {
    const source = ['const a = "x" / /[/*]/.test(s);', 'const b = `x` / /[/*]/.test(s);'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 2, blank: 0, comment: 0 });
  });

  it('preserves division context across lines after literals before comments', () => {
    const source = ['const a = "x"', '/ 2', '// explanation', 'const b = `x`', '/ 2', '// tail'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 6, blank: 0, comment: 2 });
  });

  it('tracks multiline control-flow heads before regex statements', () => {
    const source = ['if (', '  ok', ')', '/[/*]/.test(value);', 'const tail = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 5, blank: 0, comment: 0 });
  });

  it('tracks control keywords separated from opening parentheses by newlines', () => {
    const source = ['if', ' (ok)', ' /[/*]/.test(value);', 'const tail = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 4, blank: 0, comment: 0 });
  });

  it('tracks newline-separated return and else before regex statements', () => {
    const source = ['return', '/[/*]/.test(value);', 'else', '/[/*]/.test(other);'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 4, blank: 0, comment: 0 });
  });

  it('clears cross-line keywords when a literal intervenes', () => {
    const source = ['return "x" / /[/*x]/.test(value);', 'const tail = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 2, blank: 0, comment: 0 });
  });

  it('clears completed control heads when a literal intervenes', () => {
    const source = ['if (ok) "x" / /[/*]/.test(value);', 'const tail = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 2, blank: 0, comment: 0 });
  });

  it('classifies comments inside multiline template interpolations', () => {
    const source = ['const text = `value ${', '  // explanation', '  value', '}`;', 'const tail = 1;'].join('\n');
    expect(countLines(source, '.ts')).toEqual({ total: 5, blank: 0, comment: 1 });
  });
});

describe('resolveProjectDirFilter', () => {
  it('normalizes absolute and segmented in-project directories to repository-relative paths', () => {
    expect(resolveProjectDirFilter('/project', '/project/src')).toBe('src');
    expect(resolveProjectDirFilter('/project', './src/../src/lib')).toBe('src/lib');
    expect(resolveProjectDirFilter('/project', '.')).toBeUndefined();
    expect(() => resolveProjectDirFilter('/project', '../outside')).toThrow('inside the project root');
  });
});
