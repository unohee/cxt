// ============================================
// ctx - Entity Scanner
// Created: 2026-04-11
// Purpose: 레포 소스 파일에서 함수/클래스/타입/상수 선언을 추출하여 레지스트리에 등록
// Dependencies: registry/sqliteStore
// Supported: TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, C#
// ============================================

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { getRegistryStore } from './sqliteStore.js';
import { buildIgnoreConfig, shouldSkipDir } from './ignoreRules.js';
import type { EntityKind, RiskLevel, RelationType } from './schema.js';
import type { SqliteRegistryStore } from './sqliteStore.js';

// ============ 상수 ============

const MAX_FILE_SIZE = 512 * 1024;
const MAX_DEPTH = 15;
const SCAN_TIMEOUT_MS = 60_000;
// 블록 끝 탐색 시 한 엔티티가 차지할 수 있는 최대 줄 수(무한루프 방지 backstop).
// 큰 클래스/함수가 흔하므로 넉넉히. 파일 자체가 512KB로 제한돼 있어 안전.
const MAX_BLOCK_SCAN = 5000;

// ============ 언어 정의 ============

type Language = 'typescript' | 'python' | 'go' | 'rust' | 'java' | 'c' | 'cpp' | 'csharp';

interface LanguageConfig {
  extensions: string[];
  testPatterns: RegExp[];
  patterns: Array<{ pattern: RegExp; kind: EntityKind; sigGroup?: number }>;
  blockStyle: 'brace' | 'indent';
  skipIndented?: EntityKind[];
  commentPrefixes: string[];
  // 클래스 본문 내 메서드 추출용 패턴 (정의된 언어만 메서드 추출 수행).
  // match[1]=메서드명, match[sigGroup]=시그니처(괄호 포함).
  methodPattern?: { pattern: RegExp; sigGroup?: number };
  // 메서드로 오인하면 안 되는 키워드 (제어문 등).
  methodExclude?: Set<string>;
}

// ---- TypeScript / JavaScript ----
const METHOD_EXCLUDE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await',
  'do', 'else', 'with', 'super', 'constructor', 'typeof', 'new', 'case',
]);

const TS_CONFIG: LanguageConfig = {
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  testPatterns: [/\.test\.[tj]sx?$/, /\.spec\.[tj]sx?$/],
  blockStyle: 'brace',
  skipIndented: ['function'],
  commentPrefixes: ['//', '*', '/*'],
  // 클래스 메서드: [접근제어자] [static] [async] [get/set] name(params)[: Ret] {
  // 화살표 프로퍼티(name = () =>)는 별도. 여기선 메서드 문법만.
  methodPattern: {
    pattern: /^(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+|override\s+|abstract\s+)*([A-Za-z_]\w*)\s*(\([^)]*\)(?:\s*:\s*[^{;]+)?)\s*\{/,
    sigGroup: 2,
  },
  methodExclude: METHOD_EXCLUDE,
  patterns: [
    { pattern: /^export\s+(?:async\s+)?function\s+(\w+)\s*(\([^)]*\)(?:\s*:\s*[^{]+)?)?\s*\{?/, kind: 'function', sigGroup: 2 },
    { pattern: /^export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*(?::\s*\w[^=]*)?\s*=>|function)/, kind: 'function' },
    { pattern: /^export\s+(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
    { pattern: /^export\s+(?:interface|type)\s+(\w+)/, kind: 'type' },
    { pattern: /^export\s+(?:const\s+)?enum\s+(\w+)/, kind: 'type' },
    { pattern: /^export\s+const\s+([A-Z][A-Z0-9_]+)\s*=/, kind: 'constant' },
    { pattern: /^(?:async\s+)?function\s+(\w+)\s*(\([^)]*\)(?:\s*:\s*[^{]+)?)?\s*\{?/, kind: 'function', sigGroup: 2 },
    { pattern: /^(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
  ],
};

// ---- Python ----
const PY_METHOD_EXCLUDE = new Set([
  'if', 'for', 'while', 'with', 'try', 'except', 'finally', 'else', 'elif',
  'return', 'yield', 'raise', 'assert', 'pass', 'break', 'continue',
]);

const PY_CONFIG: LanguageConfig = {
  extensions: ['.py', '.pyw'],
  testPatterns: [/_test\.py$/, /test_.*\.py$/, /\.test\.py$/],
  blockStyle: 'indent',
  commentPrefixes: ['#'],
  // INT-1480: Python 클래스 내 메서드 추출 — def로 시작하는 들여쓰기된 줄.
  // indent 블록 스타일에서는 extractMethods 대신 여기서 직접 패턴 정의.
  // brace 언어용 extractMethods는 블록 끝을 brace로 찾으므로 Python에는 미사용.
  methodPattern: {
    pattern: /^(?:async\s+)?def\s+(\w+)\s*(\([^)]*\)(?:\s*->\s*[^:]+)?)?\s*:/,
    sigGroup: 2,
  },
  methodExclude: PY_METHOD_EXCLUDE,
  patterns: [
    { pattern: /^(?:async\s+)?def\s+(\w+)\s*(\([^)]*\)(?:\s*->\s*[^:]+)?)?\s*:/, kind: 'function', sigGroup: 2 },
    { pattern: /^class\s+(\w+)/, kind: 'class' },
    { pattern: /^([A-Z]\w+)\s*(?::\s*TypeAlias\s*)?=\s*(?:Literal|Union|Optional|Type|Annotated|Final)\[/, kind: 'type' },
    { pattern: /^([A-Z][A-Z0-9_]+)\s*(?::\s*\w[^=]*)?\s*=/, kind: 'constant' },
  ],
};

// ---- Go ----
const GO_CONFIG: LanguageConfig = {
  extensions: ['.go'],
  testPatterns: [/_test\.go$/],
  blockStyle: 'brace',
  commentPrefixes: ['//', '*', '/*'],
  patterns: [
    { pattern: /^func\s+(\w+)\s*(\([^)]*\)(?:\s*(?:\([^)]*\)|[^{]+))?)?\s*\{?/, kind: 'function', sigGroup: 2 },
    { pattern: /^func\s+\([^)]+\)\s+(\w+)\s*(\([^)]*\)(?:\s*(?:\([^)]*\)|[^{]+))?)?\s*\{?/, kind: 'function', sigGroup: 2 },
    { pattern: /^type\s+(\w+)\s+struct\s*\{?/, kind: 'class' },
    { pattern: /^type\s+(\w+)\s+interface\s*\{?/, kind: 'type' },
    { pattern: /^type\s+(\w+)\s+[^si]/, kind: 'type' },
    { pattern: /^const\s+(\w+)\s*(?:\w+)?\s*=/, kind: 'constant' },
    { pattern: /^var\s+(\w+)\s+/, kind: 'constant' },
  ],
};

// ---- Rust ----
const RUST_CONFIG: LanguageConfig = {
  extensions: ['.rs'],
  testPatterns: [],
  blockStyle: 'brace',
  commentPrefixes: ['//', '///', '*', '/*'],
  patterns: [
    { pattern: /^(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(<[^>]*>)?\s*(\([^)]*\)(?:\s*->\s*[^{]+)?)?\s*(?:where\s+[^{]*)?\{?/, kind: 'function', sigGroup: 3 },
    { pattern: /^(?:pub(?:\(crate\))?\s+)?struct\s+(\w+)/, kind: 'class' },
    { pattern: /^(?:pub(?:\(crate\))?\s+)?enum\s+(\w+)/, kind: 'type' },
    { pattern: /^(?:pub(?:\(crate\))?\s+)?trait\s+(\w+)/, kind: 'type' },
    { pattern: /^(?:pub(?:\(crate\))?\s+)?type\s+(\w+)/, kind: 'type' },
    { pattern: /^(?:pub(?:\(crate\))?\s+)?const\s+([A-Z][A-Z0-9_]+)\s*:/, kind: 'constant' },
    { pattern: /^(?:pub(?:\(crate\))?\s+)?static\s+(?:mut\s+)?([A-Z][A-Z0-9_]+)\s*:/, kind: 'constant' },
    { pattern: /^impl(?:<[^>]*>)?\s+(\w+)(?:<[^>]*>)?\s*(?:for\s+\w+)?\s*\{/, kind: 'class' },
  ],
};

// ---- Java ----
const JAVA_CONFIG: LanguageConfig = {
  extensions: ['.java'],
  testPatterns: [/Test\.java$/, /Tests\.java$/, /IT\.java$/],
  blockStyle: 'brace',
  commentPrefixes: ['//', '*', '/*', '@'],
  patterns: [
    { pattern: /^(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:abstract\s+)?(?:native\s+)?(?:<[^>]+>\s+)?(?:\w+(?:<[^>]*>)?(?:\[\])*)\s+(\w+)\s*(\([^)]*\))\s*(?:throws\s+[^{]+)?\s*\{?/, kind: 'function', sigGroup: 2 },
    { pattern: /^(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
    { pattern: /^(?:(?:public|private|protected)\s+)?(?:static\s+)?interface\s+(\w+)/, kind: 'type' },
    { pattern: /^(?:(?:public|private|protected)\s+)?enum\s+(\w+)/, kind: 'type' },
    { pattern: /^(?:(?:public|private|protected)\s+)?@interface\s+(\w+)/, kind: 'type' },
    { pattern: /^(?:(?:public|private|protected)\s+)?record\s+(\w+)/, kind: 'class' },
    { pattern: /^(?:(?:public|private|protected)\s+)?static\s+final\s+\w+(?:<[^>]*>)?\s+([A-Z][A-Z0-9_]+)\s*=/, kind: 'constant' },
  ],
};

// ---- C ----
const C_CONFIG: LanguageConfig = {
  extensions: ['.c', '.h'],
  testPatterns: [/_test\.c$/, /test_.*\.c$/],
  blockStyle: 'brace',
  commentPrefixes: ['//', '*', '/*'],
  patterns: [
    { pattern: /^(?:static\s+)?(?:inline\s+)?(?:extern\s+)?(?:const\s+)?(?:unsigned\s+)?(?:signed\s+)?(?:long\s+)?(?:short\s+)?\w+[\s*]+(\w+)\s*(\([^)]*\))\s*\{/, kind: 'function', sigGroup: 2 },
    { pattern: /^typedef\s+struct\s+(?:\w+\s*)?\{/, kind: 'class' },
    { pattern: /^(?:typedef\s+)?struct\s+(\w+)\s*\{?/, kind: 'class' },
    { pattern: /^(?:typedef\s+)?enum\s+(\w+)/, kind: 'type' },
    { pattern: /^typedef\s+\w+[\s*]*\(\s*\*\s*(\w+)\s*\)/, kind: 'type' },
    { pattern: /^typedef\s+.+\s+(\w+)\s*;/, kind: 'type' },
    { pattern: /^#define\s+([A-Z][A-Z0-9_]+)/, kind: 'constant' },
    { pattern: /^(?:static\s+)?const\s+\w+\s+([A-Z][A-Z0-9_]+)\s*=/, kind: 'constant' },
  ],
};

// ---- C++ ----
const CPP_CONFIG: LanguageConfig = {
  extensions: ['.cpp', '.cxx', '.cc', '.hpp', '.hxx', '.hh'],
  testPatterns: [/_test\.cpp$/, /test_.*\.cpp$/, /_test\.cc$/, /Test\.cpp$/],
  blockStyle: 'brace',
  commentPrefixes: ['//', '*', '/*'],
  patterns: [
    { pattern: /^(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?:\[\[.*?\]\]\s+)?(\w+)(?:\s*final)?\s*(?::\s*(?:public|private|protected)\s+[^{]+)?\s*\{/, kind: 'class' },
    { pattern: /^namespace\s+(\w+)/, kind: 'module' },
    { pattern: /^(?:template\s*<[^>]*>\s*)?(?:\w+[\s*&]+)?(\w+)::(\w+)\s*(\([^)]*\))/, kind: 'function', sigGroup: 3 },
    { pattern: /^(?:template\s*<[^>]*>\s*)?(?:static\s+)?(?:inline\s+)?(?:virtual\s+)?(?:explicit\s+)?(?:constexpr\s+)?(?:const\s+)?(?:unsigned\s+)?\w+[\s*&]+(\w+)\s*(\([^)]*\))\s*(?:const)?\s*(?:override|final|noexcept)?\s*\{?/, kind: 'function', sigGroup: 2 },
    { pattern: /^enum\s+(?:class\s+)?(\w+)/, kind: 'type' },
    { pattern: /^using\s+(\w+)\s*=/, kind: 'type' },
    { pattern: /^typedef\s+.+\s+(\w+)\s*;/, kind: 'type' },
    { pattern: /^(?:static\s+)?(?:inline\s+)?constexpr\s+\w+\s+([A-Z][A-Z0-9_]+)\s*[={]/, kind: 'constant' },
    { pattern: /^#define\s+([A-Z][A-Z0-9_]+)/, kind: 'constant' },
    { pattern: /^(?:static\s+)?const\s+\w+\s+([A-Z][A-Z0-9_]+)\s*=/, kind: 'constant' },
  ],
};

// ---- C# ----
const CSHARP_CONFIG: LanguageConfig = {
  extensions: ['.cs'],
  testPatterns: [/Tests?\.cs$/, /\.test\.cs$/],
  blockStyle: 'brace',
  commentPrefixes: ['//', '///', '*', '/*'],
  patterns: [
    { pattern: /^(?:\[.*?\]\s*)?(?:(?:public|private|protected|internal)\s+)?(?:static\s+)?(?:sealed\s+)?(?:abstract\s+)?(?:partial\s+)?class\s+(\w+)/, kind: 'class' },
    { pattern: /^(?:\[.*?\]\s*)?(?:(?:public|private|protected|internal)\s+)?(?:readonly\s+)?(?:ref\s+)?(?:partial\s+)?struct\s+(\w+)/, kind: 'class' },
    { pattern: /^(?:\[.*?\]\s*)?(?:(?:public|private|protected|internal)\s+)?(?:sealed\s+)?(?:abstract\s+)?record\s+(?:struct\s+|class\s+)?(\w+)/, kind: 'class' },
    { pattern: /^(?:\[.*?\]\s*)?(?:(?:public|private|protected|internal)\s+)?(?:partial\s+)?interface\s+(\w+)/, kind: 'type' },
    { pattern: /^(?:\[.*?\]\s*)?(?:(?:public|private|protected|internal)\s+)?enum\s+(\w+)/, kind: 'type' },
    { pattern: /^(?:(?:public|private|protected|internal)\s+)?delegate\s+\w+[\s<>[\],*]*\s+(\w+)\s*[(<]/, kind: 'type' },
    { pattern: /^(?:\[.*?\]\s*)?(?:(?:public|private|protected|internal)\s+)?(?:static\s+)?(?:virtual\s+)?(?:override\s+)?(?:abstract\s+)?(?:async\s+)?(?:new\s+)?(?:\w+(?:<[^>]*>)?(?:\[\]|\?)?)\s+(\w+)\s*(<[^>]*>)?\s*(\([^)]*\))\s*(?:where\s+[^{]*)?\s*[{=>]/, kind: 'function', sigGroup: 3 },
    { pattern: /^(?:(?:public|private|protected|internal)\s+)?(?:static\s+)?(?:readonly\s+)?const\s+\w+\s+(\w+)\s*=/, kind: 'constant' },
  ],
};

// ============ 언어 레지스트리 ============

const LANGUAGE_CONFIGS: Record<Language, LanguageConfig> = {
  typescript: TS_CONFIG,
  python: PY_CONFIG,
  go: GO_CONFIG,
  rust: RUST_CONFIG,
  java: JAVA_CONFIG,
  c: C_CONFIG,
  cpp: CPP_CONFIG,
  csharp: CSHARP_CONFIG,
};

const EXT_TO_LANGUAGE: Record<string, Language> = {};
for (const [lang, config] of Object.entries(LANGUAGE_CONFIGS)) {
  for (const ext of config.extensions) {
    EXT_TO_LANGUAGE[ext] = lang as Language;
  }
}

const SOURCE_EXTENSIONS = new Set(Object.keys(EXT_TO_LANGUAGE));

function detectLanguage(ext: string): Language | null {
  return EXT_TO_LANGUAGE[ext] ?? null;
}

function isTestFile(name: string, language: Language): boolean {
  return LANGUAGE_CONFIGS[language].testPatterns.some(p => p.test(name));
}

// ============ 추출된 엔티티 정보 ============

export interface ExtractedEntity {
  kind: EntityKind;
  name: string;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  signature?: string;
  isExported: boolean;
  loc: number;
  nestingDepth: number;
  paramCount: number;
}

// ============ 엔티티 추출 ============

export function extractEntities(
  content: string,
  filePath: string,
  language: Language,
): ExtractedEntity[] {
  const lines = content.split('\n');
  const entities: ExtractedEntity[] = [];
  const config = LANGUAGE_CONFIGS[language];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (!trimmed) continue;

    if (config.commentPrefixes.some(p => trimmed.startsWith(p))) continue;

    for (const { pattern, kind, sigGroup } of config.patterns) {
      const match = trimmed.match(pattern);
      if (!match) continue;

      const name = match[1];
      if (!name) continue;

      const key = `${name}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (language === 'python' && kind === 'function' && lines[i].match(/^\s+/)) continue;
      if (config.skipIndented?.includes(kind) && lines[i].match(/^\s{2,}/)) continue;

      const isExported = language === 'go'
        ? /^[A-Z]/.test(name)
        : trimmed.startsWith('export') || trimmed.startsWith('pub');

      const signature = sigGroup ? match[sigGroup]?.trim() : undefined;

      let lineEnd: number | undefined;
      if (config.blockStyle === 'brace') {
        lineEnd = findBraceBlockEnd(lines, i);
      } else if (config.blockStyle === 'indent') {
        lineEnd = findIndentBlockEnd(lines, i);
      }

      const complexity = (kind === 'function' || kind === 'class')
        ? computeBlockMetrics(lines, i, lineEnd)
        : { loc: 0, nestingDepth: 0, paramCount: 0 };

      entities.push({
        kind,
        name,
        filePath,
        lineStart: i + 1,
        // lineEnd가 0(파일 첫 줄에서 끝나는 블록)일 때 falsy로 삼켜지지 않도록 명시 비교.
        lineEnd: lineEnd !== undefined ? lineEnd + 1 : undefined,
        signature,
        isExported,
        loc: complexity.loc,
        nestingDepth: complexity.nestingDepth,
        paramCount: complexity.paramCount,
      });

      // 클래스라면 본문 범위에서 직속 메서드를 추출한다 (methodPattern 정의 언어만).
      if (kind === 'class' && lineEnd !== undefined && config.methodPattern) {
        const methodExtractor = config.blockStyle === 'indent'
          ? extractIndentMethods  // INT-1480: Python 등 indent 스타일
          : extractMethods;       // brace 스타일 (TS/JS/Go/...)
        for (const method of methodExtractor(lines, i, lineEnd, config, filePath, name)) {
          const mkey = `${method.name}:${method.lineStart - 1}`;
          if (seen.has(mkey)) continue;
          seen.add(mkey);
          entities.push(method);
        }
      }

      break;
    }
  }

  return entities;
}

// ============ 블록 끝 추정 ============

/**
 * INT-1480: Python(indent 스타일) 클래스 본문 직속 메서드 추출.
 * classStart..classEnd(0-based) 범위 내에서 클래스보다 정확히 한 들여쓰기 단계
 * 더 들어간 `def`/`async def` 줄만 추출한다. 중첩 클래스·로컬 함수는 delta가
 * 2단계 이상이므로 자동으로 제외된다.
 */
function extractIndentMethods(
  lines: string[],
  classStart: number,
  classEnd: number,
  config: LanguageConfig,
  filePath: string,
  className: string,
): ExtractedEntity[] {
  const mp = config.methodPattern;
  if (!mp) return [];
  const exclude = config.methodExclude ?? new Set<string>();
  const methods: ExtractedEntity[] = [];

  const classIndent = lines[classStart].length - lines[classStart].trimStart().length;
  // Python 관례: 클래스 바디는 classIndent + 4(또는 +2 혼합). 정확한 단계는 첫 줄에서 결정.
  let methodIndent = -1;

  for (let i = classStart + 1; i <= classEnd; i++) {
    const raw = lines[i];
    if (raw === undefined) break;
    const trimmed = raw.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = raw.length - trimmed.length;
    if (indent <= classIndent) break; // 클래스 본문 종료

    // 첫 실질 줄로 methodIndent 확정
    if (methodIndent === -1) methodIndent = indent;
    // 직속 단계가 아닌 줄(중첩)은 스킵
    if (indent !== methodIndent) continue;

    const m = trimmed.match(mp.pattern);
    if (!m) continue;
    const name = m[1];
    if (!name || exclude.has(name)) continue;

    const lineEnd = findIndentBlockEnd(lines, i);
    const signature = mp.sigGroup ? m[mp.sigGroup]?.trim() : undefined;
    const metrics = computeBlockMetrics(lines, i, lineEnd);

    methods.push({
      kind: 'function',
      name,
      filePath,
      lineStart: i + 1,
      lineEnd: lineEnd !== undefined ? lineEnd + 1 : undefined,
      signature: signature ? `${signature}  // ${className}` : `// ${className}`,
      isExported: false,
      loc: metrics.loc,
      nestingDepth: metrics.nestingDepth,
      paramCount: metrics.paramCount,
    });

    // 메서드 본문을 건너뛰어 다음 직속 줄로 이동
    if (lineEnd !== undefined && lineEnd > i) i = lineEnd;
  }

  return methods;
}

/**
 * 클래스 본문(classStart..classEnd, 0-based) 범위에서 직속 메서드를 추출한다.
 * 클래스 바로 다음 들여쓰기 단계(중첩 함수/객체 리터럴이 아닌)만 대상으로,
 * 제어 키워드(if/for/...)와 constructor는 제외한다. brace 언어 전용.
 * 메서드명은 `qualified` 형태로 클래스명을 prefix해 동명 메서드 충돌을 줄인다.
 */
function extractMethods(
  lines: string[],
  classStart: number,
  classEnd: number,
  config: LanguageConfig,
  filePath: string,
  className: string,
): ExtractedEntity[] {
  const mp = config.methodPattern;
  if (!mp) return [];
  const exclude = config.methodExclude ?? new Set<string>();
  const methods: ExtractedEntity[] = [];

  // 클래스 헤더 줄의 들여쓰기. 메서드는 그보다 한 단계 더 들어간 깊이여야 한다.
  const classIndent = lines[classStart].length - lines[classStart].trimStart().length;

  for (let i = classStart + 1; i < classEnd; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    if (!trimmed) continue;
    if (config.commentPrefixes.some(p => trimmed.startsWith(p))) continue;

    const indent = raw.length - trimmed.length;
    // 클래스 직속만: 들여쓰기가 클래스 헤더보다 깊되, 중첩 블록(더 깊은 곳)은 제외.
    // 본문 메서드는 보통 classIndent + 2(또는 +4). 깊이 차가 1~4칸인 줄만 후보.
    const delta = indent - classIndent;
    if (delta <= 0 || delta > 4) continue;

    // 멀티라인 시그니처 메서드(예: name(\n  arg,\n): T {) 지원 — 본문 `{`가
    // 나올 때까지(최대 8줄) 합쳐서 매칭 시도. 한 줄로 끝나면 그대로.
    let probe = trimmed;
    if (!/\{\s*$/.test(trimmed) && !trimmed.includes('{')) {
      for (let j = 1; j <= 8 && i + j < classEnd; j++) {
        probe += ' ' + lines[i + j].trim();
        if (lines[i + j].includes('{')) break;
      }
    }
    const m = probe.match(mp.pattern);
    if (!m) continue;
    const name = m[1];
    if (!name || exclude.has(name)) continue;

    const lineEnd = findBraceBlockEnd(lines, i);
    if (lineEnd === undefined) continue;
    // 클래스 범위를 벗어나면(파싱 오류) 스킵.
    if (lineEnd > classEnd) continue;

    const signature = mp.sigGroup ? m[mp.sigGroup]?.trim() : undefined;
    const metrics = computeBlockMetrics(lines, i, lineEnd);

    // 이름은 단순 메서드명(호출부 `.method(`와 매칭되도록). 동명 충돌은
    // qualified_name(file::name)과 동일파일-우선 해소로 구분된다. 시그니처에
    // 소속 클래스를 남겨 표시/디버깅에 활용.
    methods.push({
      kind: 'function',
      name,
      filePath,
      lineStart: i + 1,
      lineEnd: lineEnd + 1,
      signature: signature ? `${signature}  // ${className}` : `// ${className}`,
      isExported: false,
      loc: metrics.loc,
      nestingDepth: metrics.nestingDepth,
      paramCount: metrics.paramCount,
    });
  }

  return methods;
}

function findBraceBlockEnd(lines: string[], startIdx: number): number | undefined {
  // brace 카운팅으로 블록 끝을 찾는다. 핵심 함정: 멀티라인 시그니처의 타입 주석
  // (예: `options?: { a?: number },`)은 같은 줄에서 `{`와 `}`가 균형을 이루므로
  // '줄 끝 depth'가 0으로 유지된다. 본문은 `) {` 처럼 열린 `{`가 줄 끝까지 남아
  // '줄 끝 depth > 0'가 되는 순간 시작된다. 따라서 본문 시작은 "줄을 끝냈을 때
  // depth가 양수로 남은 첫 줄"로 판정하고, 그 이후 depth가 0으로 닫히면 종료한다.
  let depth = 0;
  let bodyStarted = false;
  // 시그니처가 끝나고 본문 `{`가 등장한 적이 있는지(한 줄 함수 판정용).
  let sawAnyBrace = false;

  for (let i = startIdx; i < Math.min(startIdx + MAX_BLOCK_SCAN, lines.length); i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; sawAnyBrace = true; }
      if (ch === '}') depth--;
    }
    if (!bodyStarted) {
      // 줄 끝에 열린 brace가 남으면 본문 시작 — inline 균형 {}는 여기서 걸러진다.
      if (depth > 0) { bodyStarted = true; continue; }
      // 한 줄 함수: 이 줄에서 본문 여는 `) {` / `=> {`가 열렸다 닫혔다면 그 줄이 끝.
      // (시그니처의 inline 타입 주석 `{ ... }`은 이 패턴에 안 걸려 제외된다.)
      if (sawAnyBrace && depth <= 0 && /(\)|=>)\s*\{/.test(lines[i])) return i;
      continue;
    }
    if (depth <= 0) return i;
  }
  return undefined;
}

function findIndentBlockEnd(lines: string[], startIdx: number): number | undefined {
  const startLine = lines[startIdx];
  const baseIndent = startLine.length - startLine.trimStart().length;

  for (let i = startIdx + 1; i < Math.min(startIdx + MAX_BLOCK_SCAN, lines.length); i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const currentIndent = line.length - line.trimStart().length;
    if (currentIndent <= baseIndent) return i - 1;
  }
  return undefined;
}

// ============ 복잡도 산정 ============

function computeBlockMetrics(
  lines: string[], startIdx: number, endIdx: number | undefined,
): { loc: number; nestingDepth: number; paramCount: number } {
  const end = endIdx ?? Math.min(startIdx + 50, lines.length);
  const blockLines = lines.slice(startIdx, end + 1);
  const loc = blockLines.filter(l => l.trim().length > 0).length;

  let maxNesting = 0;
  let currentNesting = 0;
  for (const line of blockLines) {
    for (const ch of line) {
      if (ch === '{' || ch === '(') currentNesting++;
      if (ch === '}' || ch === ')') currentNesting--;
    }
    if (currentNesting > maxNesting) maxNesting = currentNesting;
  }

  const firstLine = blockLines[0] ?? '';
  const paramMatch = firstLine.match(/\(([^)]*)\)/);
  const paramCount = paramMatch
    ? paramMatch[1].split(',').filter(p => p.trim().length > 0).length
    : 0;

  return { loc, nestingDepth: maxNesting, paramCount };
}

function computeComplexityFromMetrics(
  loc: number, nestingDepth: number, paramCount: number,
): number {
  let score = 0;
  if (loc > 100) score += 3;
  else if (loc > 50) score += 2;
  else if (loc > 20) score += 1;

  if (nestingDepth > 6) score += 3;
  else if (nestingDepth > 4) score += 2;
  else if (nestingDepth > 2) score += 1;

  if (paramCount > 6) score += 2;
  else if (paramCount > 3) score += 1;

  return Math.min(score, 10);
}

function computeRisk(complexityScore: number, hasTests: boolean): RiskLevel {
  if (complexityScore >= 8) return 'high';
  if (complexityScore >= 6 && !hasTests) return 'high';
  if (complexityScore >= 6) return 'medium';
  if (complexityScore >= 4 && !hasTests) return 'medium';
  return 'low';
}

// ============ 참조 추출 (관계 그래프) ============
//
// 각 엔티티의 본문 라인 범위를 스캔해 호출(callee)·상속 대상 식별자를 수집하고,
// 파일 단위 import 경로를 추출한다. 2-pass 스캔에서 식별자 → entityId로 해소.
// AST가 아니므로 동명이인 오지는 동일 프로젝트 슬롯 + 노이즈 필터로 완화한다.

export interface ReferenceSet {
  /** 본문에서 호출된 식별자 (callee 후보). */
  callNames: Set<string>;
  /** extends/implements 대상 식별자. */
  baseNames: Set<string>;
  /** import한 모듈 경로 (상대경로만, 동일 프로젝트 파일 해소용). */
  importPaths: Set<string>;
}

// 호출식: `foo(` 또는 `Bar.foo(` 의 마지막 식별자. 선언 자체(def/function 등)는 별도 제외.
const CALL_PATTERN = /(?:^|[^.\w])([A-Za-z_]\w*)\s*\(/g;
// 멤버 호출: `x.method(` 의 method 도 후보로 (메서드 매칭용).
const MEMBER_CALL_PATTERN = /\.([A-Za-z_]\w*)\s*\(/g;

// 언어별 상속/구현 추출 패턴.
const BASE_PATTERNS: Partial<Record<Language, RegExp[]>> = {
  typescript: [/\bextends\s+([A-Za-z_]\w*)/g, /\bimplements\s+([A-Za-z_][\w,\s]*)/g],
  python: [/^\s*class\s+\w+\s*\(([^)]*)\)/],
  java: [/\bextends\s+([A-Za-z_]\w*)/g, /\bimplements\s+([A-Za-z_][\w,\s.]*)/g],
  csharp: [/:\s*([A-Za-z_][\w,\s<>.]*)\s*[{]/],
  go: [],
  rust: [/\bimpl(?:<[^>]*>)?\s+(\w+)\s+for\s+(\w+)/g],
  c: [],
  cpp: [/(?:class|struct)\s+\w+\s*:\s*(?:public|private|protected)?\s*([A-Za-z_][\w:]*)/g],
};

// 언어별 import/use 경로 추출 (상대경로만 관심).
const IMPORT_PATTERNS: Partial<Record<Language, RegExp[]>> = {
  typescript: [/(?:import|export)\s+.*?\s+from\s+['"](\.[^'"]+)['"]/g, /require\(\s*['"](\.[^'"]+)['"]\s*\)/g],
  python: [/^\s*from\s+(\.[.\w]*)\s+import\b/gm, /^\s*import\s+([.\w]+)/gm],
  go: [/^\s*"([^"]+)"/gm],
  rust: [/^\s*use\s+(crate::[\w:]+|self::[\w:]+|super::[\w:]+)/gm],
  java: [/^\s*import\s+([\w.]+);/gm],
  c: [/^\s*#include\s+"([^"]+)"/gm],
  cpp: [/^\s*#include\s+"([^"]+)"/gm],
  csharp: [/^\s*using\s+([\w.]+);/gm],
};

/**
 * 한 파일에서 엔티티별 참조 집합을 추출한다.
 * entities는 이 파일에서 추출된 엔티티 목록 (라인 범위 보유).
 * 반환: 엔티티 lineStart → ReferenceSet 맵.
 */
export function extractReferences(
  content: string,
  entities: ExtractedEntity[],
  language: Language,
): Map<number, ReferenceSet> {
  const lines = content.split('\n');
  const result = new Map<number, ReferenceSet>();

  // 파일 단위 import 경로 (모든 엔티티가 공유).
  const fileImports = new Set<string>();
  for (const re of IMPORT_PATTERNS[language] ?? []) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) fileImports.add(m[1].trim());
    }
  }

  const basePatterns = BASE_PATTERNS[language] ?? [];

  for (const ent of entities) {
    if (ent.kind !== 'function' && ent.kind !== 'class') continue;
    const start = ent.lineStart - 1;
    const end = (ent.lineEnd ?? ent.lineStart) - 1;
    const body = lines.slice(start, end + 1).join('\n');

    const callNames = new Set<string>();
    for (const re of [CALL_PATTERN, MEMBER_CALL_PATTERN]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const name = m[1];
        if (!name || RESERVED_NAMES.has(name)) continue;
        if (name === ent.name) continue; // 자기 선언/재귀 제외
        callNames.add(name);
      }
    }

    const baseNames = new Set<string>();
    const head = lines.slice(start, Math.min(start + 3, end + 1)).join('\n');
    for (const re of basePatterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(head)) !== null) {
        // 콤마 구분(implements A, B) 분해.
        for (const tok of (m[1] ?? '').split(/[,\s<>(){}:]+/)) {
          const t = tok.trim();
          if (t && /^[A-Z]/.test(t) && !RESERVED_NAMES.has(t)) baseNames.add(t);
        }
        if (m[2]) {
          const t = m[2].trim();
          if (t && /^[A-Z]/.test(t)) baseNames.add(t);
        }
        if (!re.global) break;
      }
    }

    result.set(ent.lineStart, { callNames, baseNames, importPaths: fileImports });
  }

  return result;
}

// ============ 테스트 매핑 ============

interface TestFileInfo {
  testFilePath: string;
  importedSymbols: Map<string, Set<string>>;
  referencedNames: Set<string>;
}

const TS_IMPORT_FROM = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

const RESERVED_NAMES = new Set([
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach',
  'beforeAll', 'afterAll', 'vi', 'jest', 'mock', 'fn', 'spyOn',
  'console', 'setTimeout', 'setInterval', 'Promise', 'Date',
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Map', 'Set',
  'JSON', 'Math', 'Error', 'RegExp', 'require', 'import',
  'resolve', 'reject', 'then', 'catch', 'finally', 'push',
  'filter', 'map', 'reduce', 'forEach', 'find', 'includes',
  'join', 'split', 'trim', 'slice', 'splice', 'pop', 'shift',
  'assert', 'assertEqual', 'assertTrue', 'assertFalse', 'assertRaises',
  'testing', 'Errorf', 'Fatalf', 'Run', 'Equal', 'NotNil',
  'assert_eq', 'assert_ne', 'assert', 'panic', 'println',
  'assertEquals', 'assertNotNull', 'assertThrows', 'assertTrue',
  'Assert', 'Fact', 'Theory',
  // i18n / 공통 유틸 — 호출 그래프 노이즈 방지.
  't', 'log', 'warn', 'error', 'info', 'debug', 'print', 'printf',
  'sprintf', 'format', 'String', 'Number', 'parseInt', 'parseFloat',
  'keys', 'values', 'entries', 'from', 'of', 'all', 'race', 'has', 'get', 'set',
  'add', 'delete', 'clear', 'replace', 'match', 'test', 'exec', 'startsWith',
  'endsWith', 'padEnd', 'padStart', 'toString', 'valueOf', 'call', 'apply', 'bind',
]);

function parseTestFile(content: string, testFilePath: string, language: Language): TestFileInfo {
  const importedSymbols = new Map<string, Set<string>>();
  const referencedNames = new Set<string>();

  if (language === 'typescript') {
    TS_IMPORT_FROM.lastIndex = 0;
    let match;
    while ((match = TS_IMPORT_FROM.exec(content)) !== null) {
      const symbols = match[1].split(',')
        .map(s => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(s => s && !s.startsWith('type '));
      const importPath = match[2];
      if (importPath.startsWith('.')) {
        const resolved = resolveImportPath(testFilePath, importPath);
        if (resolved) {
          const existing = importedSymbols.get(resolved) ?? new Set();
          for (const s of symbols) existing.add(s);
          importedSymbols.set(resolved, existing);
        }
      }
    }
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const calls = trimmed.matchAll(/\b([a-zA-Z_]\w+)\s*\(/g);
    for (const c of calls) {
      if (!RESERVED_NAMES.has(c[1])) referencedNames.add(c[1]);
    }
  }

  return { testFilePath, importedSymbols, referencedNames };
}

function resolveImportPath(fromFile: string, importPath: string): string | null {
  const dir = dirname(fromFile);
  const cleaned = importPath.replace(/\.[jt]sx?$/, '');
  const resolved = join(dir, cleaned).replace(/\\/g, '/');
  if (resolved.startsWith('..')) return null;
  return resolved.replace(/^\.\//, '');
}

function stripTestSuffix(filePath: string): string {
  return filePath
    .replace(/\.test\.[^.]+$/, '')
    .replace(/\.spec\.[^.]+$/, '')
    .replace(/_test\.[^.]+$/, '')
    .replace(/Test\.[^.]+$/, '')
    .replace(/Tests\.[^.]+$/, '')
    .replace(/IT\.[^.]+$/, '');
}

function buildTestMap(
  entities: ExtractedEntity[],
  testFiles: TestFileInfo[],
): Map<string, { hasTests: boolean; testFile: string }> {
  const result = new Map<string, { hasTests: boolean; testFile: string }>();

  const entitiesByFile = new Map<string, ExtractedEntity[]>();
  const entityByName = new Map<string, ExtractedEntity[]>();
  // Index source files by their basename (without extension) so we can find
  // "foo.test.ts" → "foo.ts" matches even when the test lives in a parallel
  // tests/ tree (e.g. src/registry/foo.ts ↔ tests/registry/foo.test.ts).
  const entitiesByBasename = new Map<string, ExtractedEntity[]>();

  for (const e of entities) {
    const list = entitiesByFile.get(e.filePath) ?? [];
    list.push(e);
    entitiesByFile.set(e.filePath, list);

    const nameList = entityByName.get(e.name) ?? [];
    nameList.push(e);
    entityByName.set(e.name, nameList);

    const base = e.filePath.split('/').pop()?.replace(/\.[^.]+$/, '');
    if (base) {
      const baseList = entitiesByBasename.get(base) ?? [];
      baseList.push(e);
      entitiesByBasename.set(base, baseList);
    }
  }

  for (const tf of testFiles) {
    // Rule 0 (strongest): basename match.
    // foo.test.ts is the de-facto unit test for foo.ts — mark every entity
    // in any source file with that basename as tested. This catches the
    // common parallel-tree layout (src/x/foo.ts ↔ tests/x/foo.test.ts) where
    // tests exercise private helpers that the test file never names directly.
    const testBasename = tf.testFilePath.split('/').pop();
    if (testBasename) {
      const sourceBasename = stripTestSuffix(testBasename).replace(/\.[^.]+$/, '');
      const matchedEntities = entitiesByBasename.get(sourceBasename);
      if (matchedEntities && sourceBasename.length > 0) {
        for (const entity of matchedEntities) {
          const qName = `${entity.filePath}::${entity.name}`;
          if (!result.has(qName)) {
            result.set(qName, { hasTests: true, testFile: tf.testFilePath });
          }
        }
      }
    }

    for (const [sourcePath, symbols] of tf.importedSymbols) {
      const candidates = [
        sourcePath + '.ts', sourcePath + '.tsx', sourcePath + '.js',
        sourcePath + '/index.ts', sourcePath,
      ];
      for (const candidate of candidates) {
        const fileEntities = entitiesByFile.get(candidate);
        if (!fileEntities) continue;
        for (const entity of fileEntities) {
          if (symbols.has(entity.name)) {
            result.set(`${entity.filePath}::${entity.name}`, { hasTests: true, testFile: tf.testFilePath });
          }
        }
        break;
      }
    }

    for (const refName of tf.referencedNames) {
      const matchingEntities = entityByName.get(refName);
      if (!matchingEntities) continue;
      for (const entity of matchingEntities) {
        const qName = `${entity.filePath}::${entity.name}`;
        if (result.has(qName)) continue;
        if (isNearbyTest(entity.filePath, tf.testFilePath)) {
          result.set(qName, { hasTests: true, testFile: tf.testFilePath });
        }
      }
    }
  }

  return result;
}

function isNearbyTest(sourceFile: string, testFile: string): boolean {
  const sourceDir = dirname(sourceFile);
  const testDir = dirname(testFile);
  const sourceBase = sourceFile.replace(/\.[^.]+$/, '');
  const testBase = testFile
    .replace(/\.test\.[^.]+$|\.spec\.[^.]+$/, '')
    .replace(/_test\.[^.]+$/, '')
    .replace(/Test\.[^.]+$/, '')
    .replace(/Tests\.[^.]+$/, '');

  const srcName = sourceBase.split('/').pop();
  const tstName = testBase.split('/').pop();
  if (srcName && tstName && srcName === tstName) return true;

  if (sourceDir === testDir) return true;
  if (testDir === `${sourceDir}/__tests__`) return true;
  if (testDir === `${sourceDir}/tests`) return true;
  if (testDir === `${sourceDir}/test`) return true;

  const sourceParent = dirname(sourceDir);
  if (testDir === `${sourceParent}/__tests__` || testDir === 'src/__tests__') return true;

  return false;
}

// ============ 스캔 결과 ============

export interface ScanResult {
  scanned: number;
  extracted: number;
  registered: number;
  updated: number;
  removed: number;
  relationsLoaded: number;
  testsMapped: number;
  errors: string[];
  durationMs: number;
  languageBreakdown: Record<string, number>;
}

// ============ 메인 스캔 함수 ============

export async function scanRepository(
  projectPath: string,
  projectId: string,
  options?: { maxDepth?: number; timeoutMs?: number; verbose?: boolean },
): Promise<ScanResult> {
  const startTime = Date.now();
  const maxDepth = options?.maxDepth ?? MAX_DEPTH;
  const timeoutMs = options?.timeoutMs ?? SCAN_TIMEOUT_MS;
  const verbose = options?.verbose ?? false;
  const store = getRegistryStore();
  const ignoreConfig = buildIgnoreConfig(projectPath);

  const allExtracted: ExtractedEntity[] = [];
  // 엔티티 qualifiedName → 참조 집합 (2-pass 관계 해소용).
  const refsByQName = new Map<string, ReferenceSet>();
  const testFiles: TestFileInfo[] = [];
  const errors: string[] = [];
  const languageBreakdown: Record<string, number> = {};
  let scannedFiles = 0;

  async function walk(dirPath: string, relPath: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (Date.now() - startTime > timeoutMs) return;

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (err) { // cxt-ignore: exception_hiding — 디렉터리 접근 실패 시 해당 디렉터리 스킵 (verbose 로깅)
      if (verbose) console.log(`  [scan] skip dir ${relPath}: ${err instanceof Error ? err.message : 'access denied'}`);
      return;
    }

    for (const entry of entries) {
      if (Date.now() - startTime > timeoutMs) return;

      const fullPath = join(dirPath, entry.name);
      const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name, relPath, ignoreConfig)) continue;
        await walk(fullPath, entryRelPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;

        const language = detectLanguage(ext);
        if (!language) continue;

        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > MAX_FILE_SIZE) continue;
        } catch (err) { // cxt-ignore: exception_hiding — stat 실패 시 해당 파일 스킵 (verbose 로깅)
          if (verbose) console.log(`  [scan] skip stat ${entryRelPath}: ${err instanceof Error ? err.message : 'access denied'}`);
          continue;
        }

        try {
          const content = await readFile(fullPath, 'utf-8');

          if (isTestFile(entry.name, language)) {
            testFiles.push(parseTestFile(content, entryRelPath, language));
          } else {
            const entities = extractEntities(content, entryRelPath, language);
            allExtracted.push(...entities);

            // 참조 추출 (관계 그래프 2-pass용).
            const refs = extractReferences(content, entities, language);
            for (const ent of entities) {
              const r = refs.get(ent.lineStart);
              if (r) refsByQName.set(`${entryRelPath}::${ent.name}`, r);
            }

            scannedFiles++;
            languageBreakdown[language] = (languageBreakdown[language] ?? 0) + 1;

            if (verbose && entities.length > 0) {
              console.log(`  [scan] ${entryRelPath}: ${entities.length} entities (${language})`);
            }
          }
        } catch (err) { // cxt-ignore: exception_hiding — err는 errors[]에 수집되어 ScanResult로 보고됨
          errors.push(`${entryRelPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  await walk(projectPath, '', 0);

  const testMap = buildTestMap(allExtracted, testFiles);
  if (verbose && testMap.size > 0) {
    console.log(`  [test-map] ${testMap.size} entities mapped to tests`); // cxt-ignore: debug_leftover
  }

  const existing = store.listEntities({ projectId, limit: 100_000, offset: 0 });
  const existingByQName = new Map(existing.entities.map(e => [e.qualifiedName, e]));
  const extractedQNames = new Set<string>();

  let registered = 0;
  let updated = 0;
  let testsMapped = 0;

  for (const ext of allExtracted) {
    const qualifiedName = `${ext.filePath}::${ext.name}`;
    extractedQNames.add(qualifiedName);

    const testInfo = testMap.get(qualifiedName);
    const hasTests = testInfo?.hasTests ?? false;
    const testFile = testInfo?.testFile;
    const score = computeComplexityFromMetrics(ext.loc, ext.nestingDepth, ext.paramCount);
    const riskLevel = computeRisk(score, hasTests);

    if (hasTests) testsMapped++;

    const existingEntity = existingByQName.get(qualifiedName);

    if (!existingEntity) {
      try {
        store.registerEntity({
          projectId,
          kind: ext.kind,
          name: ext.name,
          filePath: ext.filePath,
          lineStart: ext.lineStart,
          lineEnd: ext.lineEnd,
          signature: ext.signature,
          status: 'active',
          hasTests,
          testFile,
          complexityScore: score,
          riskLevel,
          author: 'scanner',
        });
        registered++;
      } catch (err) { // cxt-ignore: exception_hiding — UNIQUE 충돌은 의도적 무시, 그 외 err는 errors[]에 수집됨
        if (!(err instanceof Error && err.message.includes('UNIQUE'))) {
          errors.push(`register ${qualifiedName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      // INT-1477: broken 엔티티를 재발견했으면 active로 복원.
      // scanner가 broken으로 전환했던 엔티티만 대상(수동 annotate 제외).
      if (existingEntity.status === 'broken' && existingEntity.author === 'scanner') {
        store.changeEntityStatus(existingEntity.id, 'active', 'scanner');
        updated++;
      }

      const needsUpdate =
        existingEntity.lineStart !== ext.lineStart ||
        existingEntity.lineEnd !== ext.lineEnd ||
        existingEntity.signature !== ext.signature ||
        existingEntity.hasTests !== hasTests ||
        existingEntity.testFile !== testFile ||
        existingEntity.complexityScore !== score ||
        existingEntity.riskLevel !== riskLevel;

      if (needsUpdate) {
        store.updateEntity(existingEntity.id, {
          lineStart: ext.lineStart,
          lineEnd: ext.lineEnd,
          signature: ext.signature,
          hasTests,
          testFile,
          complexityScore: score,
          riskLevel,
        }, 'scanner');
        if (existingEntity.status !== 'broken') updated++;
      }
    }
  }

  let removed = 0;
  for (const [qName, entity] of existingByQName) {
    if (!extractedQNames.has(qName) && entity.author === 'scanner' && entity.status === 'active') {
      store.changeEntityStatus(entity.id, 'broken', 'scanner');
      removed++;
    }
  }

  // ============ 관계 그래프 적재 (2-pass) ============
  const relations = resolveRelations(store, projectId, refsByQName);
  const relationsLoaded = store.replaceRelationsForProject(projectId, relations);
  if (verbose) {
    console.log(`  [relations] ${relationsLoaded} edges loaded (${refsByQName.size} entities scanned for refs)`);
  }

  return {
    scanned: scannedFiles,
    extracted: allExtracted.length,
    registered,
    updated,
    removed,
    relationsLoaded,
    testsMapped,
    errors,
    durationMs: Date.now() - startTime,
    languageBreakdown,
  };
}

// ============ 관계 해소 ============
//
// 참조 집합(이름)을 실제 entityId edge로 변환한다. 동일 프로젝트 내부만.
// 동명이인 오지 완화: (1) 같은 파일 후보 우선, (2) 그래도 모호하면 단일 후보일 때만 연결.

interface RelResolveEntity {
  id: string;
  name: string;
  kind: EntityKind;
  filePath: string;
}

export function resolveRelations(
  store: SqliteRegistryStore,
  projectId: string,
  refsByQName: Map<string, ReferenceSet>,
): Array<{ sourceId: string; targetId: string; relationType: RelationType }> {
  // active/experimental/deprecated 엔티티로 인덱스 구축.
  // broken은 제외 — 해당 파일이 사라진 것이므로 관계 해소 대상 아님.
  const { entities } = store.listEntities({ projectId, limit: 200_000, offset: 0 });
  const byName = new Map<string, RelResolveEntity[]>();
  const byQName = new Map<string, RelResolveEntity>();
  for (const e of entities) {
    if (e.status === 'broken') continue; // cxt-ignore: incomplete
    const re: RelResolveEntity = { id: e.id, name: e.name, kind: e.kind, filePath: e.filePath };
    byQName.set(e.qualifiedName, re);
    const arr = byName.get(e.name);
    if (arr) arr.push(re);
    else byName.set(e.name, [re]);
  }

  // 이름 → 가장 적절한 후보 선택 (소스 파일 우선, 단일 후보면 그대로, 모호하면 null).
  function resolve(name: string, sourceFile: string, kindFilter?: EntityKind): RelResolveEntity | null {
    let candidates = byName.get(name);
    if (!candidates || candidates.length === 0) return null;
    if (kindFilter) {
      const filtered = candidates.filter(c => c.kind === kindFilter);
      if (filtered.length > 0) candidates = filtered;
    }
    if (candidates.length === 1) return candidates[0];
    // 같은 파일 후보 우선 (지역 호출).
    const sameFile = candidates.filter(c => c.filePath === sourceFile);
    if (sameFile.length === 1) return sameFile[0];
    // 여전히 모호 → 오지 방지 위해 스킵.
    return null;
  }

  const edges: Array<{ sourceId: string; targetId: string; relationType: RelationType }> = [];
  const seen = new Set<string>();

  for (const [qName, refs] of refsByQName) {
    const source = byQName.get(qName);
    if (!source) continue;

    for (const callName of refs.callNames) {
      const target = resolve(callName, source.filePath);
      if (!target || target.id === source.id) continue;
      // INT-1481: constant/type 참조는 'uses', 함수/클래스 호출은 'calls'.
      const relType: RelationType =
        (target.kind === 'constant' || target.kind === 'type') ? 'uses' : 'calls';
      const key = `${source.id}|${target.id}|${relType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ sourceId: source.id, targetId: target.id, relationType: relType });
    }

    for (const baseName of refs.baseNames) {
      const target = resolve(baseName, source.filePath);
      if (!target || target.id === source.id) continue;
      // 인터페이스/타입이면 implements, 클래스면 extends.
      // overrides: 함수 엔티티가 다른 함수와 같은 이름을 상속 관계로 참조하는 경우.
      let relType: RelationType;
      if (target.kind === 'type') {
        relType = 'implements';
      } else if (target.kind === 'class') {
        relType = source.kind === 'function' ? 'overrides' : 'extends';
      } else {
        relType = 'extends';
      }
      const key = `${source.id}|${target.id}|${relType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ sourceId: source.id, targetId: target.id, relationType: relType });
    }
  }

  return edges;
}
