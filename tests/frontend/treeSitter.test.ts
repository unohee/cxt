import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { extractFile } from '../../src/registry/entityScanner.js';
import type { Language } from '../../src/registry/entityScanner.js';

interface Fixture {
  id: string;
  language: Language;
  filePath: string;
  source: string;
  expected: Array<[string, string, number, number, string?]>;
}

describe('AST golden corpus (hand-authored declarations, scopes and spans)', () => {
  for (const language of ['typescript', 'python', 'rust']) {
    const fixtures = JSON.parse(readFileSync(new URL(`../../bench/corpus/${language}.json`, import.meta.url), 'utf8')) as Fixture[];
    for (const fixture of fixtures) {
      it(fixture.id, () => {
        const result = extractFile(fixture.source, fixture.filePath, fixture.language, 'ast');
        expect(result.engine).toBe('ast');
        expect(result.diagnostics).toEqual([]);
        expect(result.entities.map(e => [e.kind, e.name, e.lineStart, e.lineEnd, e.scopedName])).toEqual(
          fixture.expected.map(([kind, name, start, end, scoped]) => [kind, name, start, end, scoped ?? name]));
      });
    }
  }
});

describe('AST contracts', () => {
  it('parses JavaScript with its own grammar, including JSX and class fields', () => {
    const result = extractFile('export const View = () => <div/>; class A { run = () => 1; }', 'x.jsx', 'typescript', 'ast');
    expect(result.entities.map(e => e.scopedName)).toEqual(['View', 'A', 'A.run']);
    expect(() => extractFile('const n: number = 1;', 'x.js', 'typescript', 'ast')).toThrow('syntax-error');
  });

  it('counts parameters from syntax rather than commas inside types/defaults', () => {
    const result = extractFile('function f(a: {x:number,y:number}, b = [1,2], ...rest: string[]) {}', 'x.ts', 'typescript', 'ast');
    expect(result.entities[0].paramCount).toBe(3);
    const python = extractFile('def f(a, /, b=(1,2), *, c=3, **kw): pass', 'x.py', 'python', 'ast');
    expect(python.entities[0].paramCount).toBe(4);
  });

  it('attributes calls to the exact entity on a shared line', () => {
    const result = extractFile('function a() { alpha(); } function b() { beta(); } class C { run() { gamma(); } }', 'x.ts', 'typescript', 'ast');
    expect([...result.references.get('x.ts::a')!.callNames]).toEqual(['alpha']);
    expect([...result.references.get('x.ts::b')!.callNames]).toEqual(['beta']);
    expect([...result.references.get('x.ts::C')!.callNames]).toEqual([]);
    expect([...result.references.get('x.ts::C.run')!.callNames]).toEqual(['gamma']);
  });

  it('does not absorb nested function calls into the parent', () => {
    const result = extractFile('function outer() { function inner() { leaf(); } inner(); }', 'x.ts', 'typescript', 'ast');
    expect([...result.references.get('x.ts::outer')!.callNames]).toEqual(['inner']);
    expect([...result.references.get('x.ts::outer.inner')!.callNames]).toEqual(['leaf']);
  });

  it('rejects malformed syntax without silently downgrading to regex', () => {
    for (const mode of ['ast', 'auto'] as const) {
      expect(() => extractFile('function broken(', 'bad.ts', 'typescript', mode)).toThrow('syntax-error');
    }
  });

  it('reports unsupported languages and honors explicit parser modes', () => {
    const fallback = extractFile('func main() {}', 'x.go', 'go', 'auto');
    expect(fallback.engine).toBe('lexical');
    expect(fallback.diagnostics[0].code).toBe('unsupported-language');
    expect(() => extractFile('func main() {}', 'x.go', 'go', 'ast')).toThrow('unsupported-language');
    expect(extractFile('type Private = number;', 'x.ts', 'typescript', 'lexical').entities).toEqual([]);
  });

  it('preserves multiple overloads with unique identities', () => {
    const result = extractFile('function f(x: number): number;\nfunction f(x: string): string;\nfunction f(x: any) { return x; }', 'x.ts', 'typescript', 'ast');
    expect(result.entities).toHaveLength(3);
    expect(new Set(result.entities.map(e => e.scopedName)).size).toBe(3);
  });
});
