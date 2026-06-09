// ============================================
// ctx - BS Detector
// Created: 2026-04-11
// Purpose: 소스 코드에서 BS 패턴을 탐지하는 정적 분석 엔진
// ============================================

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { t } from '../i18n.js';

// ============ 타입 ============

export type BsSeverity = 'critical' | 'warning' | 'minor';

export interface BsIssue {
  severity: BsSeverity;
  category: string;
  message: string;
  filePath: string;
  line: number;
  matchedText: string;
}

export interface BsScanResult {
  issues: BsIssue[];
  filesScanned: number;
  critical: number;
  warning: number;
  minor: number;
  bsScore: number;
}

// ============ 패턴 정의 ============

interface BsPatternDef {
  severity: BsSeverity;
  category: string;
  messageKey: keyof ReturnType<typeof t>;
  pattern: RegExp;
  languages?: string[];
  excludeIf?: (line: string, filePath: string) => boolean;
}

function isTestPath(filePath: string): boolean {
  return /\.test\.|\.spec\.|_test\.|test_|__tests__/.test(filePath);
}

/**
 * Rust 트랙에서 unwrap/expect/panic 류를 production 으로 볼지 판정.
 * tests 모듈/통합 테스트/examples/bin 은 정당하므로 제외.
 */
function isRustNonProd(filePath: string): boolean {
  return isTestPath(filePath)
    || /(?:^|\/)(?:tests|examples|benches|bin)\//.test(filePath)
    || /(?:^|\/)build\.rs$/.test(filePath);
}

function isI18nPath(filePath: string): boolean {
  return /i18n\.[tj]sx?$|locale|messages|translations/i.test(filePath);
}

const BS_PATTERN_DEFS: BsPatternDef[] = [
  // ============ CRITICAL ============
  {
    severity: 'critical',
    category: 'exception_hiding',
    messageKey: 'bsEmptyCatch',
    pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    excludeIf: (_line, fp) => isTestPath(fp),
  },
  {
    severity: 'critical',
    category: 'exception_hiding',
    messageKey: 'bsExceptPass',
    pattern: /except\s*:\s*pass/,
    languages: ['python'],
  },
  {
    severity: 'critical',
    category: 'exception_hiding',
    messageKey: 'bsExceptExceptionPass',
    pattern: /except\s+\w+\s*:\s*pass/,
    languages: ['python'],
  },
  {
    severity: 'critical',
    category: 'fake_execution',
    messageKey: 'bsFakeReturn',
    pattern: /return\s+(?:true|'ok'|"ok"|'success'|"success")\s*;?\s*\/\/\s*(?:always|todo|fixme|hack)/i,
    excludeIf: (_line, fp) => isTestPath(fp),
  },
  {
    severity: 'critical',
    category: 'hardcoded_secret',
    messageKey: 'bsHardcodedSecret',
    pattern: /(?:password|secret|api_key|apikey|token|private_key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    excludeIf: (line, fp) => isTestPath(fp) || /example|sample|template|placeholder|dummy|config\.example/i.test(fp) || /process\.env|env\.|getenv|os\.environ/i.test(line) || /token:\s*'[a-z_]+'/.test(line),
  },
  {
    severity: 'critical',
    category: 'debug_leftover',
    messageKey: 'bsDebugger',
    pattern: /^\s*debugger\s*;?\s*$/,
    languages: ['typescript', 'javascript'],
  },
  {
    // Rust: production unwrap()/expect() — runtime panic 가능
    severity: 'critical',
    category: 'panic_risk',
    messageKey: 'bsRustUnwrap',
    pattern: /\.(?:unwrap|expect)\s*\(/,
    languages: ['rust'],
    excludeIf: (line, fp) =>
      isRustNonProd(fp) ||
      // NaN guard / len-checked index 등 invariant 가 명백한 정당 패턴
      /partial_cmp|unwrap_or|unwrap_err|expect_err|\.last\(\)\.unwrap|\.first\(\)\.unwrap/.test(line) ||
      // SAFETY: 주석으로 invariant 를 정당화한 경우
      /\/\/\s*SAFETY:|\/\/\s*invariant/i.test(line),
  },
  {
    // Rust: 미완성 매크로 — release 금지
    severity: 'critical',
    category: 'incomplete',
    messageKey: 'bsRustTodo',
    pattern: /\b(?:todo!|unimplemented!)\s*\(|panic!\s*\(\s*"(?:TODO|FIXME)/i,
    languages: ['rust'],
    excludeIf: (_line, fp) => isRustNonProd(fp),
  },
  {
    // TS/JS/Python: 가짜 성공 보고 — 실제 검증 없이 완료 선언.
    // 한글 키워드는 \b 가 작동하지 않으므로 (?![가-힣]) 로 단어 경계 대용 (성공률/완료된 제외).
    severity: 'critical',
    category: 'fake_execution',
    messageKey: 'bsFakeSuccess',
    pattern: /(?:console\.log|print)\s*\(\s*f?['"`][^'"`]*?(?:(?:완료|성공)(?![가-힣])|\b(?:done|finished|success|passed)\b)/i,
    languages: ['typescript', 'javascript', 'python'],
    excludeIf: (line, fp) => isTestPath(fp) || /scripts\//.test(fp),
  },
  {
    // Python: production 위장 데이터 생성 (np.random / faker)
    severity: 'critical',
    category: 'fake_data',
    messageKey: 'bsFakeData',
    pattern: /\b(?:np\.random\.|numpy\.random\.|faker\.|Faker\(\)|fake\.\w+\(\))/,
    languages: ['python'],
    excludeIf: (line, fp) =>
      isTestPath(fp) ||
      /seed|random_state|RandomState|default_rng|conftest|fixture/.test(line) ||
      /\/(?:test|tests|fixtures|mock|mocks|examples?)\//.test(fp),
  },

  // ============ WARNING ============
  {
    severity: 'warning',
    category: 'incomplete',
    messageKey: 'bsTodoFixme',
    pattern: /(?:\/\/|#)\s*(?:TODO|FIXME|XXX|HACK)\b.*$/i,
  },
  {
    severity: 'warning',
    category: 'debug_leftover',
    messageKey: 'bsConsoleLog',
    pattern: /console\.log\s*\(/,
    languages: ['typescript', 'javascript'],
    excludeIf: (line, fp) =>
      isTestPath(fp) ||
      /scripts\//.test(fp) ||
      /cli\/|cli\.ts|runners\//.test(fp) ||
      /index\.ts$/.test(fp) ||
      /console\.(?:warn|error|info)/.test(line) ||
      /\[\w+\]/.test(line) || /`\[/.test(line),
  },
  {
    severity: 'warning',
    category: 'type_safety',
    messageKey: 'bsAsAny',
    pattern: /as\s+any\b/,
    languages: ['typescript'],
    excludeIf: (line, fp) =>
      isTestPath(fp) || /eslint-disable/.test(line) ||
      /JSON\.parse|URLSearchParams|\.map\(/.test(line),
  },
  {
    severity: 'warning',
    category: 'type_safety',
    messageKey: 'bsAnyType',
    pattern: /:\s*any\b(?!\[)/,
    languages: ['typescript'],
    excludeIf: (line, fp) =>
      isTestPath(fp) || /eslint-disable/.test(line) || /\/\//.test(line.split(':')[0] ?? '') ||
      /function\s+normalize|parsed:\s*any|JSON\.parse|response\.\w+\.map/.test(line),
  },
  {
    severity: 'warning',
    category: 'type_safety',
    messageKey: 'bsNonNullAssertion',
    pattern: /\w+!\./,
    languages: ['typescript'],
    excludeIf: (_line, fp) => isTestPath(fp),
  },
  {
    severity: 'warning',
    category: 'security',
    messageKey: 'bsEval',
    pattern: /\beval\s*\(/,
    excludeIf: (_line, fp) => isTestPath(fp),
  },
  {
    // Rust: 에러 silently 무시 (let _ = fallible(); 또는 .ok();)
    severity: 'warning',
    category: 'error_swallow',
    messageKey: 'bsRustSilentError',
    pattern: /let\s+_\s*=\s*[\w.]+\([^)]*\)\s*[?;]|\.ok\(\)\s*;/,
    languages: ['rust'],
    excludeIf: (line, fp) =>
      isRustNonProd(fp) ||
      // 의도적 무시를 // reason: 으로 정당화한 경우
      /\/\/\s*(?:reason|intentional|ignore)/i.test(line),
  },
  {
    severity: 'warning',
    category: 'fake_data',
    messageKey: 'bsFakeUrl',
    pattern: /(?:example\.com|localhost:\d{4}|127\.0\.0\.1:\d{4})/,
    excludeIf: (line, fp) => isTestPath(fp) || /\/\//.test(line.split('http')[0] ?? '') || /config|env|default/i.test(fp) || /config|env|default/i.test(line),
  },

  // ============ MINOR ============
  {
    severity: 'minor',
    category: 'magic_number',
    messageKey: 'bsMagicNumber',
    pattern: /(?:=|return|>|<|===|!==)\s*(?:(?!0\b|1\b|2\b|-1\b|100\b|1000\b|60\b|24\b|365\b)\d{3,})\b/,
    excludeIf: (line, fp) => isTestPath(fp) || /const|timeout|limit|max|min|port|size|width|height|delay|interval|ms|sec/i.test(line),
  },
  {
    severity: 'minor',
    category: 'readability',
    messageKey: 'bsLongLine',
    pattern: /.{200,}/,
    excludeIf: (line, _fp) => /^[\s]*\/\//.test(line) || /^[\s]*\*/.test(line) || /import\s/.test(line) || /https?:\/\//.test(line),
  },
];

// ============ 언어 감지 ============

function detectLanguageForBs(ext: string): string | null {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.pyw': 'python',
    '.go': 'go', '.rs': 'rust', '.java': 'java',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cxx': 'cpp', '.cc': 'cpp',
    '.hpp': 'cpp', '.hxx': 'cpp', '.cs': 'csharp',
  };
  return map[ext] ?? null;
}

// ============ 단일 파일 스캔 ============

export function scanFileContent(
  content: string,
  filePath: string,
  language: string,
): BsIssue[] {
  if (isI18nPath(filePath)) return [];

  const issues: BsIssue[] = [];
  const lines = content.split('\n');
  const msgs = t();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const bp of BS_PATTERN_DEFS) {
      if (bp.languages && !bp.languages.includes(language)) continue;

      const match = line.match(bp.pattern);
      if (!match) continue;

      if (bp.excludeIf && bp.excludeIf(line, filePath)) continue;

      issues.push({
        severity: bp.severity,
        category: bp.category,
        message: msgs[bp.messageKey] as string,
        filePath,
        line: i + 1,
        matchedText: match[0].slice(0, 80),
      });
    }
  }

  return issues;
}

// ============ 파일 스캔 (비동기) ============

export async function scanFile(filePath: string): Promise<BsIssue[]> {
  const ext = extname(filePath);
  const language = detectLanguageForBs(ext);
  if (!language) return [];

  const content = await readFile(filePath, 'utf-8');
  return scanFileContent(content, filePath, language);
}

// ============ 결과 집계 ============

export function aggregateResults(issues: BsIssue[], filesScanned: number): BsScanResult {
  const critical = issues.filter(i => i.severity === 'critical').length;
  const warning = issues.filter(i => i.severity === 'warning').length;
  const minor = issues.filter(i => i.severity === 'minor').length;
  const bsScore = filesScanned > 0
    ? (critical * 10 + warning * 3 + minor * 1) / filesScanned
    : 0;

  return { issues, filesScanned, critical, warning, minor, bsScore };
}

// ============ 레포 전체 스캔 ============

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { buildIgnoreConfig, shouldSkipDir } from './ignoreRules.js';

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.cxx', '.cc', '.hpp', '.cs',
]);

const MAX_FILE_SIZE = 512 * 1024;

export async function scanRepository(
  projectPath: string,
  options?: { verbose?: boolean },
): Promise<BsScanResult> {
  const verbose = options?.verbose ?? false;
  const ignoreConfig = buildIgnoreConfig(projectPath);
  const allIssues: BsIssue[] = [];
  let filesScanned = 0;

  async function walk(dirPath: string, relPath: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name, relPath, ignoreConfig)) continue;
        await walk(fullPath, entryRelPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;

        const language = detectLanguageForBs(ext);
        if (!language) continue;

        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > MAX_FILE_SIZE) continue;
        } catch { continue; }

        try {
          const content = await readFile(fullPath, 'utf-8');
          const issues = scanFileContent(content, entryRelPath, language);
          allIssues.push(...issues);
          filesScanned++;

          if (verbose && issues.length > 0) {
            console.log(`  [bs] ${entryRelPath}: ${issues.length} issues`);
          }
        } catch { continue; }
      }
    }
  }

  await walk(projectPath, '');
  return aggregateResults(allIssues, filesScanned);
}
