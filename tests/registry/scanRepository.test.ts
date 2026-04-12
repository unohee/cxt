import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepository } from '../../src/registry/entityScanner.js';
import { getRegistryStore, closeRegistryStore } from '../../src/registry/sqliteStore.js';

// scanRepository uses the global registry store singleton.
// Pre-initialize the singleton with a tmp DB path so tests don't pollute
// the user's ~/.cxt/registry.db.

let projectDir: string;
let tmpDbDir: string;

function write(rel: string, content: string): void {
  const abs = join(projectDir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
  closeRegistryStore();
  projectDir = mkdtempSync(join(tmpdir(), 'cxt-proj-'));
  tmpDbDir = mkdtempSync(join(tmpdir(), 'cxt-db-'));
  // Pre-init singleton with tmp path
  getRegistryStore(join(tmpDbDir, 'registry.db'));
});

afterEach(() => {
  closeRegistryStore();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(tmpDbDir, { recursive: true, force: true });
});

describe('scanRepository — file walking + test mapping', () => {
  it('detects entities in TS source and parses .test.ts as test file', async () => {
    write('src/math.ts', 'export function add(a: number, b: number) { return a + b; }');
    write('src/math.test.ts', `
      import { add } from './math';
      import { describe, it, expect } from 'vitest';
      describe('add', () => {
        it('works', () => { expect(add(1, 2)).toBe(3); });
      });
    `);

    const result = await scanRepository(projectDir, 'tproj-1');

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.extracted).toBeGreaterThanOrEqual(1);
    expect(result.testsMapped).toBeGreaterThanOrEqual(1);
  });

  it('maps tests via direct named import', async () => {
    write('src/foo.ts', 'export function helper() { return 42; }');
    write('src/foo.test.ts', `
      import { helper } from './foo';
      it('works', () => { helper(); });
    `);

    const result = await scanRepository(projectDir, 'tproj-2');
    expect(result.testsMapped).toBeGreaterThanOrEqual(1);
  });

  it('maps tests via nearby test file (call-by-name fallback)', async () => {
    write('src/util.ts', 'export function compute() { return 1; }');
    write('src/util.test.ts', `
      const u = require('./util');
      it('works', () => { compute(); });
    `);

    const result = await scanRepository(projectDir, 'tproj-3');
    expect(result.testsMapped).toBeGreaterThanOrEqual(1);
  });

  it('skips node_modules via built-in ignore rules', async () => {
    write('src/main.ts', 'export function main() {}');
    write('node_modules/some-pkg/index.ts', 'export function shouldBeSkipped() {}');

    const result = await scanRepository(projectDir, 'tproj-4');
    expect(result.scanned).toBe(1);
  });

  it('returns language breakdown for multiple languages', async () => {
    write('src/a.ts', 'export function a() {}');
    write('src/b.py', 'def b(): pass');
    write('src/c.go', 'package main\nfunc C() {}');

    const result = await scanRepository(projectDir, 'tproj-5');
    expect(result.languageBreakdown.typescript).toBeGreaterThanOrEqual(1);
    expect(result.languageBreakdown.python).toBeGreaterThanOrEqual(1);
    expect(result.languageBreakdown.go).toBeGreaterThanOrEqual(1);
  });

  it('handles empty repository without errors', async () => {
    const result = await scanRepository(projectDir, 'tproj-6');
    expect(result.scanned).toBe(0);
    expect(result.extracted).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('skips files larger than MAX_FILE_SIZE', async () => {
    const big = 'export const X = "' + 'x'.repeat(600 * 1024) + '";';
    write('src/big.ts', big);
    write('src/small.ts', 'export function small() {}');

    const result = await scanRepository(projectDir, 'tproj-7');
    expect(result.scanned).toBe(1);
  });

  it('maps tests via basename match across parallel directory trees', async () => {
    // src/registry/foo.ts ↔ tests/registry/foo.test.ts
    // The test file does NOT import or call the entity by name — only the
    // basename match should mark it as tested.
    write('src/registry/foo.ts', 'export function privateHelper() { return 1; }\nexport class Bar {}');
    write('tests/registry/foo.test.ts', `
      // No import of foo, no direct call to privateHelper or Bar
      describe('something', () => {
        it('does stuff', () => { expect(1).toBe(1); });
      });
    `);

    const result = await scanRepository(projectDir, 'tproj-basename');
    // Both privateHelper and Bar should be tested via basename rule
    expect(result.testsMapped).toBeGreaterThanOrEqual(2);
  });

  it('basename rule does not match unrelated files with different basenames', async () => {
    write('src/foo.ts', 'export function fooFn() {}');
    write('src/bar.ts', 'export function barFn() {}');
    write('tests/foo.test.ts', `
      it('test', () => {});
    `);

    const result = await scanRepository(projectDir, 'tproj-basename-neg');
    // foo.ts should be mapped (basename match), bar.ts should NOT
    expect(result.testsMapped).toBe(1);
  });

  it('marks deleted entities as broken on re-scan', async () => {
    write('src/a.ts', 'export function alpha() {}\nexport function beta() {}');
    const r1 = await scanRepository(projectDir, 'tproj-rescan');
    expect(r1.extracted).toBe(2);

    // Delete beta from source
    write('src/a.ts', 'export function alpha() {}');
    const r2 = await scanRepository(projectDir, 'tproj-rescan');
    expect(r2.extracted).toBe(1);
    expect(r2.removed).toBeGreaterThanOrEqual(1);
  });
});
