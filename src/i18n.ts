// ============================================
// ctx - i18n (Internationalization)
// Created: 2026-04-11
// Purpose: Multi-language support for CLI output
// ============================================

export type Locale = 'en' | 'ko';

interface Messages {
  // ── CLI help ──
  helpScan: string;
  helpScanVerbose: string;
  helpCheckStats: string;
  helpCheckFile: string;
  helpCheckSearch: string;
  helpCheckUntested: string;
  helpCheckHighRisk: string;
  helpCheckTree: string;
  helpCheckCi: string;
  helpBs: string;
  helpBsVerbose: string;
  helpInject: string;
  helpSupportedLangs: string;
  helpStorage: string;
  helpStorageDesc: string;

  // ── Check handler ──
  scanningRepo: string;
  scanComplete: string;
  filesScanned: string;
  entitiesFound: string;
  newRegistered: string;
  updated: string;
  markedBroken: string;
  testsMapped: string;
  duration: string;
  byLanguage: string;
  errors: string;
  andMore: (n: number) => string;
  registryStatus: string;
  registryStats: string;
  statsScopeProject: (id: string) => string;
  statsScopeGlobal: string;
  totalEntities: string;
  deprecated: string;
  untested: string;
  highRisk: string;
  withWarnings: string;
  byKind: string;
  byStatus: string;
  deprecatedEntities: string;
  untestedEntities: string;
  highRiskEntities: string;
  entitiesTagged: (tag: string) => string;
  noEntitiesWithTag: (tag: string) => string;
  searchResults: (query: string, count: number) => string;
  noMatches: string;
  fileBrief: string;
  noRegisteredEntities: string;
  runScanFirst: string;
  codeRegistry: string;
  registryEmpty: string;
  runScan: string;
  usage: string;
  none: string;
  allTested: string;
  codeTree: string;

  // ── BS detector messages ──
  bsDetector: string;
  bsScanResult: string;
  bsScore: string;
  criticalFixNow: string;
  warningRecommended: string;
  minorCount: (n: number) => string;

  bsEmptyCatch: string;
  bsExceptPass: string;
  bsExceptExceptionPass: string;
  bsFakeReturn: string;
  bsHardcodedSecret: string;
  bsDebugger: string;
  bsTodoFixme: string;
  bsConsoleLog: string;
  bsAsAny: string;
  bsAnyType: string;
  bsNonNullAssertion: string;
  bsEval: string;
  bsFakeUrl: string;
  bsMagicNumber: string;
  bsLongLine: string;

  // ── Annotate ──
  annotating: string;
  deprecatedStatus: string;
  statusChanged: string;
  tagAdded: string;
  tagRemoved: string;
  noteAdded: string;
  noChanges: string;
  updatedState: string;
  entityNotFound: (name: string) => string;
  useQualifiedName: string;
  multipleMatches: (name: string) => string;
  useFullQualifiedName: string;
  invalidStatus: (status: string, valid: string) => string;
  invalidRisk: (risk: string, valid: string) => string;
  invalidWarnFormat: string;
  warnExample: string;

  // ── Inject ──
  injectHeader: (name: string) => string;
  highRiskHeader: string;
}

const en: Messages = {
  // CLI help
  helpScan: 'Scan codebase → sync to registry',
  helpScanVerbose: 'Verbose scan output',
  helpCheckStats: 'Show overall statistics',
  helpCheckFile: 'File entity listing',
  helpCheckSearch: 'Full-text search (FTS5)',
  helpCheckUntested: 'Untested entity listing',
  helpCheckHighRisk: 'High-risk entity listing',
  helpCheckTree: 'Directory tree view',
  helpCheckCi: 'CI mode (JSON, exit code)',
  helpBs: 'BS pattern scan',
  helpBsVerbose: 'Per-file issue detail',
  helpInject: 'Claude Code SessionStart hook summary',
  helpSupportedLangs: 'Supported Languages',
  helpStorage: 'Storage',
  helpStorageDesc: '(SQLite, per-project isolation)',

  // Check handler
  scanningRepo: 'Scanning repository...',
  scanComplete: 'Scan Complete',
  filesScanned: 'Files scanned:',
  entitiesFound: 'Entities found:',
  newRegistered: 'New registered:',
  updated: 'Updated:',
  markedBroken: 'Marked broken:',
  testsMapped: 'Tests mapped:',
  duration: 'Duration:',
  byLanguage: 'By language:',
  errors: 'Errors',
  andMore: (n) => `...and ${n} more`,
  registryStatus: 'Registry Status',
  registryStats: 'Registry Stats',
  statsScopeProject: (id) => `scope: project "${id}"`,
  statsScopeGlobal: 'scope: ALL projects (--global)',
  totalEntities: 'Total entities:',
  deprecated: 'Deprecated:',
  untested: 'Untested:',
  highRisk: 'High risk:',
  withWarnings: 'With warnings:',
  byKind: 'By kind:',
  byStatus: 'By status:',
  deprecatedEntities: 'Deprecated Entities',
  untestedEntities: 'Untested Active Entities',
  highRiskEntities: 'High Risk Entities',
  entitiesTagged: (tag) => `Entities tagged "${tag}"`,
  noEntitiesWithTag: (tag) => `No entities with tag "${tag}"`,
  searchResults: (query, count) => `Search: "${query}" (${count} results)`,
  noMatches: 'No matches',
  fileBrief: 'File Brief',
  noRegisteredEntities: 'No registered entities for this file.',
  runScanFirst: 'Run `cxt check --scan` first.',
  codeRegistry: 'Code Registry',
  registryEmpty: 'empty',
  runScan: 'Run: cxt check --scan',
  usage: 'Usage:',
  none: 'None',
  allTested: 'All tested',
  codeTree: 'Code Tree',

  // BS detector
  bsDetector: 'BS Detector',
  bsScanResult: 'BS Scan Result',
  bsScore: 'BS Score:',
  criticalFixNow: 'CRITICAL (fix immediately)',
  warningRecommended: 'WARNING (recommended fix)',
  minorCount: (n) => `MINOR (${n})`,

  bsEmptyCatch: 'Empty catch block — exception silenced',
  bsExceptPass: 'except: pass — Python exception hiding',
  bsExceptExceptionPass: 'except Exception: pass — all exceptions ignored',
  bsFakeReturn: 'Hardcoded success return — no real logic',
  bsHardcodedSecret: 'Hardcoded secret/token pattern',
  bsDebugger: 'Leftover debugger statement',
  bsTodoFixme: 'TODO/FIXME with empty implementation',
  bsConsoleLog: 'Leftover console.log in production code',
  bsAsAny: 'as any — type safety bypass',
  bsAnyType: ': any type — no type safety',
  bsNonNullAssertion: 'Non-null assertion (!) — no null check',
  bsEval: 'eval() usage — code injection risk',
  bsFakeUrl: 'Fake URL (example.com, localhost) — not production-ready',
  bsMagicNumber: 'Magic number — unclear hardcoded value',
  bsLongLine: 'Line over 200 chars — poor readability',

  // Annotate
  annotating: 'Annotating:',
  deprecatedStatus: 'Deprecated',
  statusChanged: 'Status changed',
  tagAdded: 'Tag:',
  tagRemoved: 'Removed tag:',
  noteAdded: 'Note added',
  noChanges: 'No changes. Use --deprecate, --status, --tag, --note, --risk, or --warn',
  updatedState: 'Updated state:',
  entityNotFound: (name) => `Entity not found: "${name}"`,
  useQualifiedName: 'Use qualified name (file::name) or search with: cxt check --search <query>',
  multipleMatches: (name) => `Multiple matches for "${name}":`,
  useFullQualifiedName: 'Use the full qualified name to annotate a specific entity.',
  invalidStatus: (status, valid) => `Invalid status: ${status}. Valid: ${valid}`,
  invalidRisk: (risk, valid) => `Invalid risk: ${risk}. Valid: ${valid}`,
  invalidWarnFormat: 'Invalid warning format. Use: severity/category: message',
  warnExample: 'Example: --warn "error/security: SQL injection risk"',

  // Inject
  injectHeader: (name) => `[Code Registry] ${name} — skip exploratory Read/Grep, use this map`,
  highRiskHeader: 'High-risk (untested + complex):',
};

const ko: Messages = {
  // CLI help
  helpScan: '코드베이스 스캔 → 레지스트리 동기화',
  helpScanVerbose: '상세 출력으로 스캔',
  helpCheckStats: '전체 통계 조회',
  helpCheckFile: '파일 엔티티 목록',
  helpCheckSearch: '전문 검색 (FTS5)',
  helpCheckUntested: '테스트 없는 엔티티 목록',
  helpCheckHighRisk: '고위험 엔티티 목록',
  helpCheckTree: '디렉토리 트리 뷰',
  helpCheckCi: 'CI 모드 (JSON, exit code)',
  helpBs: 'BS 패턴 스캔',
  helpBsVerbose: '파일별 이슈 상세 출력',
  helpInject: 'Claude Code SessionStart 훅용 요약',
  helpSupportedLangs: '지원 언어',
  helpStorage: '저장소',
  helpStorageDesc: '(SQLite, 프로젝트별 분리)',

  // Check handler
  scanningRepo: '레포지토리 스캔 중...',
  scanComplete: '스캔 완료',
  filesScanned: '스캔 파일:',
  entitiesFound: '발견 엔티티:',
  newRegistered: '신규 등록:',
  updated: '업데이트:',
  markedBroken: 'Broken 전환:',
  testsMapped: '테스트 매핑:',
  duration: '소요 시간:',
  byLanguage: '언어별:',
  errors: '오류',
  andMore: (n) => `...외 ${n}건`,
  registryStatus: '레지스트리 현황',
  registryStats: '레지스트리 통계',
  statsScopeProject: (id) => `범위: 프로젝트 "${id}"`,
  statsScopeGlobal: '범위: 전체 프로젝트 (--global)',
  totalEntities: '전체 엔티티:',
  deprecated: 'Deprecated:',
  untested: '테스트 없음:',
  highRisk: '고위험:',
  withWarnings: '경고 있음:',
  byKind: '종류별:',
  byStatus: '상태별:',
  deprecatedEntities: 'Deprecated 엔티티',
  untestedEntities: '테스트 없는 활성 엔티티',
  highRiskEntities: '고위험 엔티티',
  entitiesTagged: (tag) => `"${tag}" 태그 엔티티`,
  noEntitiesWithTag: (tag) => `"${tag}" 태그를 가진 엔티티 없음`,
  searchResults: (query, count) => `검색: "${query}" (${count}건)`,
  noMatches: '결과 없음',
  fileBrief: '파일 요약',
  noRegisteredEntities: '등록된 엔티티 없음.',
  runScanFirst: '`cxt check --scan`을 먼저 실행하세요.',
  codeRegistry: '코드 레지스트리',
  registryEmpty: '비어 있음',
  runScan: '실행: cxt check --scan',
  usage: '사용법:',
  none: '없음',
  allTested: '모두 테스트됨',
  codeTree: '코드 트리',

  // BS detector
  bsDetector: 'BS 감지기',
  bsScanResult: 'BS 스캔 결과',
  bsScore: 'BS 점수:',
  criticalFixNow: 'CRITICAL (즉시 수정 필요)',
  warningRecommended: 'WARNING (권장 수정)',
  minorCount: (n) => `MINOR (${n}건)`,

  bsEmptyCatch: '빈 catch 블록 — 예외를 완전히 무시',
  bsExceptPass: 'except: pass — Python 예외 은폐',
  bsExceptExceptionPass: 'except Exception: pass — 모든 예외 무시',
  bsFakeReturn: '하드코딩된 성공 반환 — 실제 로직 없이 true/ok 반환',
  bsHardcodedSecret: '하드코딩된 비밀키/토큰 패턴',
  bsDebugger: 'debugger 문 잔류',
  bsTodoFixme: 'TODO/FIXME + 빈 구현 (pass/return/throw)',
  bsConsoleLog: 'console.log 잔류 — 프로덕션 코드에 디버그 출력',
  bsAsAny: 'as any — 타입 안전성 우회',
  bsAnyType: ': any 타입 사용 — 타입 안전성 부재',
  bsNonNullAssertion: 'non-null assertion (!) — null 체크 없이 단언',
  bsEval: 'eval() 사용 — 코드 인젝션 위험',
  bsFakeUrl: 'example.com 등 가짜 URL — 실 운영 불가',
  bsMagicNumber: '매직 넘버 — 의미 불명확한 하드코딩 숫자',
  bsLongLine: '200자 이상 긴 줄 — 가독성 저하',

  // Annotate
  annotating: '어노테이션:',
  deprecatedStatus: 'Deprecated',
  statusChanged: '상태 변경됨',
  tagAdded: '태그:',
  tagRemoved: '태그 제거:',
  noteAdded: '노트 추가됨',
  noChanges: '변경 없음. --deprecate, --status, --tag, --note, --risk, --warn 사용',
  updatedState: '변경 후 상태:',
  entityNotFound: (name) => `엔티티를 찾을 수 없음: "${name}"`,
  useQualifiedName: '정규명(file::name) 또는 cxt check --search <query>로 검색',
  multipleMatches: (name) => `"${name}"에 대한 복수 결과:`,
  useFullQualifiedName: '정규명을 사용하여 특정 엔티티를 지정하세요.',
  invalidStatus: (status, valid) => `잘못된 상태: ${status}. 사용 가능: ${valid}`,
  invalidRisk: (risk, valid) => `잘못된 리스크: ${risk}. 사용 가능: ${valid}`,
  invalidWarnFormat: '잘못된 경고 형식. 사용법: severity/category: message',
  warnExample: '예시: --warn "error/security: SQL injection risk"',

  // Inject
  injectHeader: (name) => `[Code Registry] ${name} — skip exploratory Read/Grep, use this map`,
  highRiskHeader: 'High-risk (untested + complex):',
};

const locales: Record<Locale, Messages> = { en, ko };

let currentLocale: Locale = 'en';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/** Detect locale from environment (LANG, LC_ALL, LANGUAGE) */
export function detectLocale(): Locale {
  const envLang = process.env.LC_ALL || process.env.LANG || process.env.LANGUAGE || '';
  if (/^ko/i.test(envLang)) return 'ko';
  return 'en';
}

export function t(): Messages {
  return locales[currentLocale];
}
