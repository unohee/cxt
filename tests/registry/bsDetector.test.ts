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
  it('detects empty catch block (now warning, INT-1486)', () => {
    const src = 'try { foo(); } catch (e) {}';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'exception_hiding')).toBeDefined();
  });

  it('skips empty catch in test files', () => {
    const src = 'try { foo(); } catch (e) {}';
    const issues = scanFileContent(src, 'src/x.test.ts', 'typescript');
    expect(issues.find((i) => i.category === 'exception_hiding')).toBeUndefined();
  });

  // INT-1486: 빈 catch 너머의 삼킴 형태들
  it('detects catch that swallows with only a comment', () => {
    const src = 'try { foo(); } catch { /* ignore */ }';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'exception_hiding')).toBeDefined();
  });

  it('detects catch that swallows by returning null', () => {
    const src = 'try {\n  foo();\n} catch (e) {\n  return null;\n}';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'exception_hiding')).toBeDefined();
  });

  it('detects catch that only logs (debug swallow)', () => {
    const src = 'try {\n  foo();\n} catch (e) {\n  logger.debug(e);\n}';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'exception_hiding')).toBeDefined();
  });

  it('does NOT flag catch that rethrows', () => {
    const src = 'try {\n  foo();\n} catch (e) {\n  throw new Error("wrap: " + e);\n}';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'exception_hiding')).toBeUndefined();
  });

  it('does NOT flag catch that rejects a promise', () => {
    const src = 'try {\n  foo();\n} catch (e) {\n  return Promise.reject(e);\n}';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'exception_hiding')).toBeUndefined();
  });

  it('does NOT count throw inside a comment as handling', () => {
    const src = 'try {\n  foo();\n} catch (e) {\n  // we could throw here but we do not\n  return;\n}';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'exception_hiding')).toBeDefined();
  });

  it('respects cxt-ignore: exception_hiding on the catch line', () => {
    const src = 'try { foo(); } catch { /* ok */ } // cxt-ignore: exception_hiding';
    const issues = scanFileContent(src, 'src/x.ts', 'typescript');
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
    const src = '// TODO: implement this properly'; // cxt-ignore: incomplete -- fixture string, not real debt
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

describe('bsDetector — inline suppression (cxt-ignore)', () => {
  it('same-line // cxt-ignore suppresses all issues on that line', () => {
    const issues = scanFileContent('const x = y as any; // cxt-ignore', 'src/a.ts', 'typescript');
    expect(issues).toHaveLength(0);
  });
  it('# cxt-ignore works for Python', () => {
    const issues = scanFileContent('x = np.random.rand(3)  # cxt-ignore', 'src/m.py', 'python');
    expect(issues).toHaveLength(0);
  });
  it('// cxt-ignore: <category> suppresses only that category', () => {
    const matched = scanFileContent('const x = y as any; // cxt-ignore: type_safety', 'src/a.ts', 'typescript');
    expect(matched.find((i) => i.category === 'type_safety')).toBeUndefined();
    // 카테고리 불일치면 억제 안 됨
    const notMatched = scanFileContent('const x = y as any; // cxt-ignore: security', 'src/a.ts', 'typescript');
    expect(notMatched.find((i) => i.category === 'type_safety')).toBeDefined();
  });
  it('// cxt-ignore-next-line suppresses the following line only', () => {
    const suppressed = scanFileContent('// cxt-ignore-next-line\nconst x = y as any;', 'src/a.ts', 'typescript');
    expect(suppressed.find((i) => i.category === 'type_safety')).toBeUndefined();
    // 한 줄만 적용 — 두 줄 뒤는 계속 잡힘
    const twoBelow = scanFileContent('// cxt-ignore-next-line\nconst ok = 1;\nconst x = y as any;', 'src/a.ts', 'typescript');
    expect(twoBelow.find((i) => i.category === 'type_safety')).toBeDefined();
  });
  it('cxt-ignore inside a string literal does not suppress (needs comment marker)', () => {
    const issues = scanFileContent('const s = "cxt-ignore"; const x = y as any;', 'src/a.ts', 'typescript');
    expect(issues.find((i) => i.category === 'type_safety')).toBeDefined();
  });
  it('same-line rule does not mistake cxt-ignore-next-line for cxt-ignore', () => {
    const issues = scanFileContent('const x = y as any; // cxt-ignore-next-line', 'src/a.ts', 'typescript');
    expect(issues.find((i) => i.category === 'type_safety')).toBeDefined();
  });
});

// ── /audit 이관으로 추가된 신규 패턴 (Rust panic/incomplete/error_swallow, fake_success, fake_data) ──
describe('bsDetector — Rust panic risk (unwrap/expect)', () => {
  it('flags production unwrap()/expect() as critical', () => {
    const issues = scanFileContent('let x = foo.unwrap();', 'src/lib.rs', 'rust');
    expect(issues.find((i) => i.category === 'panic_risk' && i.severity === 'critical')).toBeDefined();
  });
  it('excludes unwrap() in tests/ dir', () => {
    const issues = scanFileContent('let x = foo.unwrap();', 'tests/integration.rs', 'rust');
    expect(issues.find((i) => i.category === 'panic_risk')).toBeUndefined();
  });
  it('excludes partial_cmp().unwrap() (NaN guard) and unwrap_or', () => {
    const a = scanFileContent('arr.sort_by(|x, y| x.partial_cmp(y).unwrap());', 'src/dsp.rs', 'rust');
    const b = scanFileContent('let x = foo.unwrap_or(0);', 'src/lib.rs', 'rust');
    expect(a.find((i) => i.category === 'panic_risk')).toBeUndefined();
    expect(b.find((i) => i.category === 'panic_risk')).toBeUndefined();
  });
  it('excludes unwrap() justified by // SAFETY comment', () => {
    const issues = scanFileContent('let x = v.unwrap(); // SAFETY: len checked', 'src/lib.rs', 'rust');
    expect(issues.find((i) => i.category === 'panic_risk')).toBeUndefined();
  });
  it('does not apply to non-Rust files', () => {
    const issues = scanFileContent('foo.unwrap()', 'src/x.ts', 'typescript');
    expect(issues.find((i) => i.category === 'panic_risk')).toBeUndefined();
  });
});

describe('bsDetector — Rust incomplete macros', () => {
  it('flags todo!()/unimplemented!()/panic!("TODO") as critical', () => {
    for (const src of ['fn f() { todo!() }', 'fn f() { unimplemented!() }', 'panic!("TODO: x");']) {
      const issues = scanFileContent(src, 'src/lib.rs', 'rust');
      expect(issues.find((i) => i.category === 'incomplete' && i.severity === 'critical')).toBeDefined();
    }
  });
});

describe('bsDetector — Rust silent error swallow', () => {
  it('flags let _ = fallible() and .ok(); as warning', () => {
    const a = scanFileContent('let _ = write_file(path);', 'src/io.rs', 'rust');
    const b = scanFileContent('do_thing().ok();', 'src/io.rs', 'rust');
    expect(a.find((i) => i.category === 'error_swallow' && i.severity === 'warning')).toBeDefined();
    expect(b.find((i) => i.category === 'error_swallow')).toBeDefined();
  });
  it('excludes when justified by // reason: comment', () => {
    const issues = scanFileContent('let _ = cleanup(); // reason: best-effort', 'src/io.rs', 'rust');
    expect(issues.find((i) => i.category === 'error_swallow')).toBeUndefined();
  });
});

describe('bsDetector — fake success report', () => {
  it('flags console.log/print of 완료/성공/done/success as critical', () => {
    const cases: Array<[string, string, string]> = [
      ['console.log("✅ 완료");', 'src/run.ts', 'typescript'],
      ['print("성공")', 'src/run.py', 'python'],
      ['console.log("done")', 'src/run.ts', 'typescript'],
      ['print(f"테스트 성공")', 'src/run.py', 'python'],
    ];
    for (const [src, fp, lang] of cases) {
      const issues = scanFileContent(src, fp, lang);
      expect(issues.find((i) => i.category === 'fake_execution' && i.severity === 'critical')).toBeDefined();
    }
  });
  it('does not flag normal logging or 성공률/완료된 (substring guard)', () => {
    const a = scanFileContent('console.log(data)', 'src/run.ts', 'typescript');
    const b = scanFileContent('console.log("성공률 계산 완료된 뒤")', 'src/run.ts', 'typescript');
    expect(a.find((i) => i.category === 'fake_execution')).toBeUndefined();
    expect(b.find((i) => i.category === 'fake_execution')).toBeUndefined();
  });
});

describe('bsDetector — fake data (Python np.random/faker)', () => {
  it('flags np.random/faker in production as critical', () => {
    const a = scanFileContent('data = np.random.rand(100)', 'src/model.py', 'python');
    const b = scanFileContent('name = faker.name()', 'src/seed.py', 'python');
    expect(a.find((i) => i.category === 'fake_data' && i.severity === 'critical')).toBeDefined();
    expect(b.find((i) => i.category === 'fake_data')).toBeDefined();
  });
  it('excludes np.random.seed (deterministic) and test files', () => {
    const a = scanFileContent('np.random.seed(42)', 'src/model.py', 'python');
    const b = scanFileContent('data = np.random.rand(100)', 'tests/test_model.py', 'python');
    expect(a.find((i) => i.category === 'fake_data')).toBeUndefined();
    expect(b.find((i) => i.category === 'fake_data')).toBeUndefined();
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
