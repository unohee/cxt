import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  scanFileContent,
  aggregateResults,
  scanFile,
  scanRepository,
} from '../../src/registry/bsDetector.js';

let projectDir: string;

function writeFile(rel: string, content: string): string {
  const abs = join(projectDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
  return abs;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'cxt-bs-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('bsDetector — CRITICAL patterns', () => {
  it('detects empty catch block', () => {
    const src = 'try { foo(); } catch (e) {}';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.severity === 'critical' && i.category === 'exception_hiding')).toBeDefined();
  });

  it('skips empty catch in test files', () => {
    const src = 'try { foo(); } catch (e) {}';
    const issues = scanFileContent(src, 'src/x.test.ts', 'typescript');
    expect(issues.find((i) => i.category === 'exception_hiding')).toBeUndefined();
  });

  it('detects Python except: pass (same line)', () => {
    const src = 'try:\n    foo()\nexcept: pass';
    const issues = scanFileContent(src, 'src/x.py', 'python');
    expect(issues.find((i) => i.category === 'exception_hiding')).toBeDefined();
  });

  it('detects Python except Exception: pass', () => {
    const src = 'try:\n    foo()\nexcept Exception: pass';
    const issues = scanFileContent(src, 'src/x.py', 'python');
    expect(issues.find((i) => i.category === 'exception_hiding')).toBeDefined();
  });

  it('detects hardcoded secrets', () => {
    const src = `const password = "supersecret123";`;
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'hardcoded_secret')).toBeDefined();
  });

  it('skips hardcoded secrets when sourced from process.env', () => {
    const src = `const password = process.env.PW;`;
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'hardcoded_secret')).toBeUndefined();
  });

  it('skips secrets in *.example or sample files', () => {
    const src = `const api_key = "abcdef123456789";`;
    const issues = scanFileContent(src, 'src/config.example.ts', 'typescript');
    expect(issues.find((i) => i.category === 'hardcoded_secret')).toBeUndefined();
  });

  it('detects leftover debugger statement', () => {
    const src = 'function x() {\n  debugger;\n}';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'debug_leftover' && i.severity === 'critical')).toBeDefined();
  });

  it('detects fake success return with marker comment', () => {
    const src = `function ok() { return true; // always }`;
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'fake_execution')).toBeDefined();
  });
});

describe('bsDetector — WARNING patterns', () => {
  it('detects TODO/FIXME', () => {
    const src = '// TODO: implement this properly';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'incomplete')).toBeDefined();
  });

  it('detects console.log in non-test, non-cli code', () => {
    const src = 'function fetch() { console.log(data); }';
    const issues = scanFileContent(src, 'src/lib/fetcher.ts', 'typescript');
    expect(issues.find((i) => i.category === 'debug_leftover' && i.severity === 'warning')).toBeDefined();
  });

  it('skips console.log in test files', () => {
    const src = 'console.log("debug");';
    const issues = scanFileContent(src, 'src/x.test.ts', 'typescript');
    expect(issues.find((i) => i.category === 'debug_leftover')).toBeUndefined();
  });

  it('skips console.log in cli/ paths', () => {
    const src = 'console.log("hello");';
    const issues = scanFileContent(src, 'src/cli/runner.ts', 'typescript');
    expect(issues.find((i) => i.category === 'debug_leftover')).toBeUndefined();
  });

  it('detects `as any` cast', () => {
    const src = 'const x = data as any;';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'type_safety')).toBeDefined();
  });

  it('detects eval()', () => {
    const src = 'function dangerous(s) { return eval(s); }';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'security')).toBeDefined();
  });

  it('detects fake URL example.com', () => {
    const src = 'const api = "https://api.example.com/v1";';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'fake_data')).toBeDefined();
  });

  it('skips fake URL in config files', () => {
    const src = 'const api = "https://api.example.com/v1";';
    const issues = scanFileContent(src, 'src/config.ts', 'typescript');
    expect(issues.find((i) => i.category === 'fake_data')).toBeUndefined();
  });
});

describe('bsDetector — MINOR patterns', () => {
  it('detects long lines', () => {
    const longLine = 'const x = ' + '"a".repeat(1)+'.repeat(60) + '"end";';
    const issues = scanFileContent(longLine, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'readability')).toBeDefined();
  });

  it('skips long lines that are comments or imports', () => {
    const longComment = '// ' + 'x'.repeat(250);
    const issues = scanFileContent(longComment, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'readability')).toBeUndefined();
  });

  it('skips long URL-containing lines', () => {
    const longUrl = 'const u = "https://' + 'x'.repeat(250) + '";';
    const issues = scanFileContent(longUrl, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'readability')).toBeUndefined();
  });
});

describe('bsDetector — i18n self-detection guard', () => {
  it('returns no issues for i18n files (would otherwise self-detect)', () => {
    const src = `const messages = { bsHardcodedSecret: 'password = "..."' };`;
    const issues = scanFileContent(src, 'src/i18n.ts', 'typescript');
    expect(issues).toEqual([]);
  });

  it('returns no issues for locale/messages/translations files', () => {
    const src = `const x = "password = secretvalue123";`;
    const issues1 = scanFileContent(src, 'src/locales/en.ts', 'typescript');
    const issues2 = scanFileContent(src, 'src/messages/ko.ts', 'typescript');
    expect(issues1).toEqual([]);
    expect(issues2).toEqual([]);
  });
});

describe('bsDetector — language scoping', () => {
  it('skips TS-only patterns on Python files', () => {
    const src = 'x = 1  # debugger';
    const issues = scanFileContent(src, 'src/x.py', 'python');
    expect(issues.find((i) => i.category === 'debug_leftover' && i.severity === 'critical')).toBeUndefined();
  });
});

describe('bsDetector — aggregateResults', () => {
  it('counts severities and computes BS score', () => {
    const issues = [
      { severity: 'critical' as const, category: 'x', message: 'm', filePath: 'a', line: 1, matchedText: '' },
      { severity: 'critical' as const, category: 'x', message: 'm', filePath: 'a', line: 2, matchedText: '' },
      { severity: 'warning' as const, category: 'x', message: 'm', filePath: 'a', line: 3, matchedText: '' },
      { severity: 'minor' as const, category: 'x', message: 'm', filePath: 'a', line: 4, matchedText: '' },
    ];
    const result = aggregateResults(issues, 10);
    expect(result.critical).toBe(2);
    expect(result.warning).toBe(1);
    expect(result.minor).toBe(1);
    // (2*10 + 1*3 + 1*1) / 10 = 2.4
    expect(result.bsScore).toBeCloseTo(2.4, 5);
  });

  it('returns zero score when no files scanned', () => {
    const result = aggregateResults([], 0);
    expect(result.bsScore).toBe(0);
  });
});

describe('bsDetector — scanFile (async file reader)', () => {
  it('reads file from disk and returns issues', async () => {
    const path = writeFile('src/x.ts', 'function bad() { eval("1+1"); }');
    const issues = await scanFile(path);
    expect(issues.find((i) => i.category === 'security')).toBeDefined();
  });

  it('returns empty for unsupported extensions', async () => {
    const path = writeFile('src/x.txt', 'eval("nope");');
    const issues = await scanFile(path);
    expect(issues).toEqual([]);
  });
});

describe('bsDetector — scanRepository', () => {
  it('walks the repo and aggregates issues across files', async () => {
    writeFile('src/clean.ts', 'export function ok() { return 1; }');
    writeFile('src/dirty.ts', 'function dirty() { eval("nope"); }');
    writeFile('node_modules/pkg/bad.ts', 'function ignored() { eval("vendor"); }');

    const result = await scanRepository(projectDir);
    expect(result.filesScanned).toBe(2); // node_modules excluded
    expect(result.warning).toBeGreaterThanOrEqual(1);
    expect(result.issues.find((i) => i.filePath.includes('dirty.ts'))).toBeDefined();
    expect(result.issues.find((i) => i.filePath.includes('node_modules'))).toBeUndefined();
  });

  it('handles empty repository', async () => {
    const result = await scanRepository(projectDir);
    expect(result.filesScanned).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.bsScore).toBe(0);
  });

  it('skips oversized files', async () => {
    const big = 'const X = "' + 'x'.repeat(600 * 1024) + '";';
    writeFile('src/big.ts', big);
    writeFile('src/small.ts', 'export const Y = 1;');

    const result = await scanRepository(projectDir);
    expect(result.filesScanned).toBe(1);
  });

  it('verbose mode does not crash', async () => {
    writeFile('src/x.ts', 'function f() { eval("a"); }');
    const result = await scanRepository(projectDir, { verbose: true });
    expect(result.filesScanned).toBe(1);
  });
});
