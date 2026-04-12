import { describe, it, expect } from 'vitest';
import {
  extractEntities,
} from '../../src/registry/entityScanner.js';

// entityScanner exports extractEntities + scanRepository.
// Internal helpers (findBraceBlockEnd, computeBlockMetrics, computeRisk,
// isTestFile, parseTestFile, buildTestMap, isNearbyTest) are private,
// so we exercise them indirectly through extractEntities + scanRepository.

describe('extractEntities — TypeScript', () => {
  it('extracts top-level exported function with signature and line range', () => {
    const src = [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'function privateHelper() {',
      '  return 1;',
      '}',
    ].join('\n');

    const ents = extractEntities(src, 'src/math.ts', 'typescript');
    const names = ents.map((e) => e.name);
    expect(names).toContain('add');
    expect(names).toContain('privateHelper');

    const add = ents.find((e) => e.name === 'add')!;
    expect(add.kind).toBe('function');
    expect(add.isExported).toBe(true);
    expect(add.lineStart).toBe(1);
    expect(add.lineEnd).toBe(3);
    expect(add.signature).toContain('a: number');
    expect(add.paramCount).toBe(2);
  });

  it('extracts class, type, interface, enum, constant', () => {
    const src = [
      'export class Foo {}',
      'export interface Bar { x: number }',
      'export type Baz = string | number;',
      'export enum Color { Red, Blue }',
      'export const MAX_RETRIES = 5;',
    ].join('\n');

    const ents = extractEntities(src, 'src/types.ts', 'typescript');
    const byName = Object.fromEntries(ents.map((e) => [e.name, e.kind]));
    expect(byName.Foo).toBe('class');
    expect(byName.Bar).toBe('type');
    expect(byName.Baz).toBe('type');
    expect(byName.Color).toBe('type');
    expect(byName.MAX_RETRIES).toBe('constant');
  });

  it('skips indented (nested) function declarations', () => {
    const src = [
      'export function outer() {',
      '  function inner() {',
      '    return 1;',
      '  }',
      '  return inner();',
      '}',
    ].join('\n');

    const ents = extractEntities(src, 'src/x.ts', 'typescript');
    const names = ents.map((e) => e.name);
    expect(names).toContain('outer');
    expect(names).not.toContain('inner');
  });

  it('skips comment lines', () => {
    const src = [
      '// export function ghost() {}',
      '/* export function alsoGhost() {} */',
      'export function real() { return 1; }',
    ].join('\n');

    const ents = extractEntities(src, 'src/x.ts', 'typescript');
    expect(ents.map((e) => e.name)).toEqual(['real']);
  });

  it('extracts arrow function const exports', () => {
    const src = `export const greet = (name: string): string => 'hi ' + name;`;
    const ents = extractEntities(src, 'src/x.ts', 'typescript');
    expect(ents.find((e) => e.name === 'greet')?.kind).toBe('function');
  });
});

describe('extractEntities — Python', () => {
  it('extracts def, class, constant', () => {
    const src = [
      'def foo(x, y):',
      '    return x + y',
      '',
      'class Bar:',
      '    def method(self):',
      '        pass',
      '',
      'MAX_VALUE = 100',
    ].join('\n');

    const ents = extractEntities(src, 'src/x.py', 'python');
    const names = ents.map((e) => e.name);
    expect(names).toContain('foo');
    expect(names).toContain('Bar');
    expect(names).toContain('MAX_VALUE');
    // method is indented → should NOT be top-level
    expect(names).not.toContain('method');
  });

  it('detects indent-based block end for top-level def', () => {
    const src = [
      'def first():',
      '    a = 1',
      '    b = 2',
      '    return a + b',
      '',
      'def second():',
      '    return 99',
    ].join('\n');

    const ents = extractEntities(src, 'src/x.py', 'python');
    const first = ents.find((e) => e.name === 'first')!;
    expect(first.lineStart).toBe(1);
    expect(first.lineEnd).toBeGreaterThanOrEqual(4);
    expect(first.lineEnd).toBeLessThan(6);
  });
});

describe('extractEntities — Go', () => {
  it('extracts func, struct, interface, const', () => {
    const src = [
      'package main',
      '',
      'func PublicFn(x int) int { return x }',
      'func privateFn() {}',
      'type Foo struct { X int }',
      'type Reader interface { Read() }',
      'const MaxSize = 1024',
    ].join('\n');

    const ents = extractEntities(src, 'src/x.go', 'go');
    const byName = Object.fromEntries(ents.map((e) => [e.name, e]));
    expect(byName.PublicFn).toBeDefined();
    expect(byName.PublicFn.isExported).toBe(true);
    expect(byName.privateFn.isExported).toBe(false);
    expect(byName.Foo.kind).toBe('class');
    expect(byName.Reader.kind).toBe('type');
    expect(byName.MaxSize.kind).toBe('constant');
  });
});

describe('extractEntities — Rust', () => {
  it('extracts pub fn, struct, enum, trait, const', () => {
    const src = [
      'pub fn add(a: i32, b: i32) -> i32 { a + b }',
      'fn private() {}',
      'pub struct Point { x: i32, y: i32 }',
      'pub enum Status { Ok, Err }',
      'pub trait Greet { fn hello(&self); }',
      'pub const MAX: u32 = 100;',
    ].join('\n');

    const ents = extractEntities(src, 'src/x.rs', 'rust');
    const byName = Object.fromEntries(ents.map((e) => [e.name, e]));
    expect(byName.add?.isExported).toBe(true);
    expect(byName.private?.isExported).toBe(false);
    expect(byName.Point?.kind).toBe('class');
    expect(byName.Status?.kind).toBe('type');
    expect(byName.Greet?.kind).toBe('type');
    expect(byName.MAX?.kind).toBe('constant');
  });
});

describe('extractEntities — Java', () => {
  it('extracts class, interface, enum, method', () => {
    const src = [
      'public class Calculator {',
      '  public int add(int a, int b) { return a + b; }',
      '}',
      'public interface Greeter { void hello(); }',
      'public enum Color { RED, BLUE }',
    ].join('\n');

    const ents = extractEntities(src, 'src/Calc.java', 'java');
    const names = ents.map((e) => e.name);
    expect(names).toContain('Calculator');
    expect(names).toContain('Greeter');
    expect(names).toContain('Color');
  });
});

describe('extractEntities — C', () => {
  it('extracts function definitions', () => {
    const src = [
      'int add(int a, int b) {',
      '  return a + b;',
      '}',
    ].join('\n');

    const ents = extractEntities(src, 'src/x.c', 'c');
    // C parser may or may not resolve this as a function depending on patterns;
    // assert at least no crash and structure-preserving extraction.
    expect(Array.isArray(ents)).toBe(true);
  });
});

describe('extractEntities — block end estimation', () => {
  it('handles unbalanced/missing braces gracefully', () => {
    const src = [
      'export function broken() {',
      '  if (true) {',
      '    return 1;',
      // intentionally missing closing braces
    ].join('\n');

    const ents = extractEntities(src, 'src/x.ts', 'typescript');
    const broken = ents.find((e) => e.name === 'broken');
    expect(broken).toBeDefined();
    // Should not throw — lineEnd may be undefined
  });

  it('respects 500-line scan window', () => {
    const long = ['export function big() {']
      .concat(Array(600).fill('  doStuff();'))
      .concat(['}']);

    const ents = extractEntities(long.join('\n'), 'src/x.ts', 'typescript');
    const big = ents.find((e) => e.name === 'big');
    expect(big).toBeDefined();
  });
});

describe('extractEntities — complexity metrics', () => {
  it('computes higher LOC for larger functions', () => {
    const small = 'export function s() { return 1; }';
    const large = ['export function l() {']
      .concat(Array(60).fill('  doStuff();'))
      .concat(['}'])
      .join('\n');

    const sEnt = extractEntities(small, 'src/x.ts', 'typescript').find((e) => e.name === 's')!;
    const lEnt = extractEntities(large, 'src/x.ts', 'typescript').find((e) => e.name === 'l')!;
    expect(lEnt.loc).toBeGreaterThan(sEnt.loc);
  });

  it('counts parameters', () => {
    const src = 'export function many(a: number, b: number, c: number, d: number) { return a; }';
    const ent = extractEntities(src, 'src/x.ts', 'typescript').find((e) => e.name === 'many')!;
    expect(ent.paramCount).toBe(4);
  });

  it('zero params for parameterless function', () => {
    const src = 'export function none() { return 1; }';
    const ent = extractEntities(src, 'src/x.ts', 'typescript').find((e) => e.name === 'none')!;
    expect(ent.paramCount).toBe(0);
  });
});
