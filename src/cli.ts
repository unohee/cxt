#!/usr/bin/env node
// ============================================
// ctx - CLI entry point
// Created: 2026-04-11
// Purpose: Code context toolkit CLI
// ============================================

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getRegistryStore, closeRegistryStore } from './registry/sqliteStore.js';
import { resolveProjectId } from './cli/checkHandler.js';
import { t, setLocale, detectLocale } from './i18n.js';
import { escapeTerminal } from './cli/outputSafety.js';

// dist/cli.js → ../package.json (npm packs dist/ + package.json side by side)
const PKG_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch { // cxt-ignore: exception_hiding — package.json 읽기/파싱 실패 시 기본 버전으로 fallback
    return '0.0.0';
  }
})();

const program = new Command();
let initialLocale: string = detectLocale();
const valueOptions = new Set([
  '--search', '--tag', '--dir', '--kind', '--project', '--status', '--untag', '--note',
  '--risk', '--warn', '--output', '-o', '--ext', '--target', '--path', '--type', '--depth',
  '--days', '--keep-days',
]);
const protectedValues = new Map<string, string>();
function findExplicitLang(args: string[]): { found: boolean; value?: string } {
  let found = false;
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') break;
    if (valueOptions.has(args[i])) {
      if (args[i + 1] === '--') break;
      i++;
      continue;
    }
    if (args[i] === '--lang') { found = true; value = args[++i]; }
    else if (args[i].startsWith('--lang=')) { found = true; value = args[i].slice('--lang='.length); }
  }
  return { found, value };
}
function protectLanguageLikeOptionValues(argv: string[]): string[] {
  const protectedArgv = argv.slice();
  for (let i = 2; i + 1 < protectedArgv.length; i++) {
    if (protectedArgv[i] === '--') break;
    if (valueOptions.has(protectedArgv[i]) && protectedArgv[i + 1].startsWith('--lang')) {
      const token = `__cxt_${randomUUID()}__`;
      protectedValues.set(token, protectedArgv[i + 1]);
      if (protectedArgv[i].startsWith('--')) protectedArgv.splice(i, 2, `${protectedArgv[i]}=${token}`);
      else protectedArgv[i + 1] = token;
    }
  }
  return protectedArgv;
}
function restoreProtectedOptionValues(command: Command): void {
  const opts = command.opts() as Record<string, unknown>;
  for (const [key, value] of Object.entries(opts)) {
    if (typeof value === 'string' && protectedValues.has(value)) opts[key] = protectedValues.get(value);
  }
  for (const child of command.commands) restoreProtectedOptionValues(child);
}
const preparedArgv = protectLanguageLikeOptionValues(process.argv);
const registrationLang = findExplicitLang(preparedArgv.slice(2));
if (registrationLang.found) initialLocale = registrationLang.value ?? '';
setLocale(initialLocale === 'ko' ? 'ko' : 'en');
const h = (english: string, korean: string): string => initialLocale === 'ko' ? korean : english;

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

program
  .name('cxt')
  .version(PKG_VERSION)
  .description(h('Code context toolkit — entity registry, BS detector, and AI context injection', '코드 컨텍스트 도구 — 엔티티 레지스트리, BS 탐지, AI 컨텍스트 주입'))
  .option('--lang <locale>', h('Language: en, ko (default: auto-detect from LANG)', '언어: en, ko (기본값: LANG에서 자동 감지)'))
  .hook('preAction', (thisCommand, actionCommand) => {
    restoreProtectedOptionValues(program);
    const lang = program.opts().lang as string | undefined;
    if (lang && lang !== 'en' && lang !== 'ko') {
      thisCommand.error(`error: unsupported language '${escapeTerminal(lang)}' (expected en or ko)`);
    }
    setLocale(lang ?? detectLocale());
  })
  .addHelpText('after', () => {
    // lazy eval so --lang can take effect
    const lang = program.opts().lang as string | undefined;
    if (lang && lang !== 'en' && lang !== 'ko') {
      program.error(`error: unsupported language '${escapeTerminal(lang)}' (expected en or ko)`);
    }
    setLocale(lang ?? detectLocale());
    const m = t();
    return `
${c.bold}${h('Examples:', '예시:')}${c.reset}
  ${c.cyan}cxt scan${c.reset}                          ${m.helpScan}
  ${c.cyan}cxt scan -v${c.reset}                       ${m.helpScanVerbose}
  ${c.cyan}cxt check --stats${c.reset}                 ${m.helpCheckStats}
  ${c.cyan}cxt check src/index.ts${c.reset}            ${m.helpCheckFile}
  ${c.cyan}cxt check --search handleCheck${c.reset}    ${m.helpCheckSearch}
  ${c.cyan}cxt check --untested${c.reset}              ${m.helpCheckUntested}
  ${c.cyan}cxt check --high-risk${c.reset}             ${m.helpCheckHighRisk}
  ${c.cyan}cxt check --tree${c.reset}                  ${m.helpCheckTree}
  ${c.cyan}cxt check --ci${c.reset}                    ${m.helpCheckCi}
  ${c.cyan}cxt bs${c.reset}                            ${m.helpBs}
  ${c.cyan}cxt bs -v${c.reset}                         ${m.helpBsVerbose}
  ${c.cyan}cxt audit${c.reset}                         ${h('BS scan + registry integrity audit', 'BS 스캔 + 레지스트리 무결성 감사')}
  ${c.cyan}cxt audit --json${c.reset}                  ${h('Audit in CI mode (exit 1 on critical)', 'CI 모드 감사 (치명적 문제 시 종료 코드 1)')}
  ${c.cyan}cxt annotate file::fn --deprecate "reason"${c.reset}
  ${c.cyan}cxt annotate file::fn --tag team=backend${c.reset}
  ${c.cyan}cxt inject${c.reset}                        ${m.helpInject}
  ${c.cyan}cxt export -o .cxt/structure.gql${c.reset}  ${h('Export SDL snapshot for LLMs', 'LLM용 SDL 스냅샷 내보내기')}
  ${c.cyan}cxt loc${c.reset}                           ${h('File LOC report (sorted by size)', '파일 LOC 보고서 (크기순)')}
  ${c.cyan}cxt loc --dir src --no-blank${c.reset}      ${h('LOC excluding blank lines', '빈 줄을 제외한 LOC')}
  ${c.cyan}cxt who-calls <name>${c.reset}              ${h('Entities that call/extend <name>', '<name>을 호출/확장하는 엔티티')}
  ${c.cyan}cxt calls <name>${c.reset}                  ${h('Entities that <name> calls/extends', '<name>이 호출/확장하는 엔티티')}
  ${c.cyan}cxt impact <name>${c.reset}                 ${h('Transitive callers (change impact)', '전이 호출자 (변경 영향)')}
  ${c.cyan}cxt projects${c.reset}                      ${h('List registered projects', '등록 프로젝트 목록')}
  ${c.cyan}cxt project rm <id|path>${c.reset}          ${h('Remove a project from the registry', '레지스트리에서 프로젝트 제거')}
  ${c.cyan}cxt prune${c.reset}                         ${h('Delete broken (zombie) entities', '손상된(좀비) 엔티티 삭제')}
  ${c.cyan}cxt prune --events --days 7${c.reset}       ${h('Delete events older than 7 days', '7일보다 오래된 이벤트 삭제')}
  ${c.cyan}cxt vacuum${c.reset}                        ${h('Compact registry DB (VACUUM)', '레지스트리 DB 압축(VACUUM)')}

${c.bold}${m.helpSupportedLangs}:${c.reset}
  TypeScript/JS  Python  Go  Rust  Java  C/C++  C#

${c.bold}${m.helpStorage}:${c.reset}
  ${c.dim}~/.cxt/registry.db${c.reset} ${m.helpStorageDesc}
`;
  });

// ---- check ----
program
  .command('check')
  .description(h('Check code registry for a file or show registry stats', '파일의 코드 레지스트리를 확인하거나 레지스트리 통계를 표시'))
  .argument('[filePath]', h('File path to inspect (relative to project root)', '확인할 파일 경로 (프로젝트 루트 기준 상대 경로)'))
  .option('--stats', h('Show overall registry statistics', '전체 레지스트리 통계 표시'))
  .option('--deprecated', h('List all deprecated entities', '사용 중단 엔티티 목록'))
  .option('--untested', h('List all untested entities', '테스트 없는 엔티티 목록'))
  .option('--high-risk', h('List all high-risk entities', '고위험 엔티티 목록'))
  .option('--tag <tag>', h('List entities with a specific tag', '특정 태그의 엔티티 목록'))
  .option('--search <query>', h('Full-text search entities', '엔티티 전문 검색'))
  .option('--scan', h('Scan entire repository and sync to registry', '저장소 전체를 스캔하고 레지스트리와 동기화'))
  .option('--bs', h('Scan for BS patterns (bad code smells)', 'BS 패턴(나쁜 코드 냄새) 스캔'))
  .option('--tree', h('Display codebase tree with entity counts and risk', '엔티티 수와 위험도를 포함한 코드 트리 표시'))
  .option('--dir <path>', h('Filter by directory prefix (combine with --tree or alone)', '디렉터리 접두사로 필터링'))
  .option('--kind <kind>', h('Filter by entity kind (function|class|module|type|constant)', '엔티티 종류로 필터링 (function|class|module|type|constant)'))
  .option('--ci', h('CI/CD mode: JSON output, exit 1 on critical issues', 'CI/CD 모드: JSON 출력, 치명적 문제 시 종료 코드 1'))
  .option('-v, --verbose', h('Verbose output (with --scan)', '상세 출력 (--scan과 함께 사용)'))
  .option('--project <id>', h('Filter by project ID', '프로젝트 ID로 필터링'))
  .option('--global', h('With --stats: aggregate across all projects (default: current project only)', '--stats에서 모든 프로젝트 집계 (기본값: 현재 프로젝트만)'))
  .action(async (filePath, opts) => {
    const { handleCheck } = await import('./cli/checkHandler.js');
    await handleCheck(filePath, opts);
  });

// ---- scan (shortcut) ----
program
  .command('scan')
  .description(h('Scan codebase and sync entities to registry', '코드베이스를 스캔하고 엔티티를 레지스트리와 동기화'))
  .option('-v, --verbose', h('Verbose output', '상세 출력'))
  .option('--project <id>', h('Project ID override', '프로젝트 ID 재정의'))
  .action(async (opts) => {
    const { handleCheck } = await import('./cli/checkHandler.js');
    await handleCheck(undefined, { scan: true, verbose: opts.verbose, project: opts.project });
  });

// ---- bs (shortcut) ----
// INT-1485: --json/--dir 옵션 추가
program
  .command('bs')
  .description(h('Scan for BS patterns (bad code smells)', 'BS 패턴(나쁜 코드 냄새) 스캔'))
  .option('-v, --verbose', h('Verbose output', '상세 출력'))
  .option('--json', h('JSON output (machine-readable)', 'JSON 출력 (기계 판독용)'))
  .option('--dir <path>', h('Limit scan to a directory prefix', '지정 디렉터리로 스캔 제한'))
  .action(async (opts) => {
    const { handleBs } = await import('./cli/bsHandler.js');
    await handleBs({ verbose: opts.verbose, json: opts.json, dir: opts.dir });
  });

// ---- annotate ----
program
  .command('annotate')
  .description(h('Annotate entity metadata', '엔티티 메타데이터 주석'))
  .argument('<qualifiedName>', h('Entity qualified name (file::name)', '엔티티 정규 이름 (file::name)'))
  .option('--deprecate [reason]', h('Mark as deprecated', '사용 중단으로 표시'))
  .option('--status <status>', h('Change status (active|deprecated|experimental|planned|broken)', '상태 변경 (active|deprecated|experimental|planned|broken)'))
  .option('--tag <tag>', h('Add tag (key or key=value)', '태그 추가 (key 또는 key=value)'))
  .option('--untag <tag>', h('Remove tag', '태그 제거'))
  .option('--note <text>', h('Add a note', '메모 추가'))
  .option('--risk <level>', h('Set risk level (low|medium|high)', '위험도 설정 (low|medium|high)'))
  .option('--warn <spec>', h('Add warning (severity/category: message)', '경고 추가 (severity/category: message)'))
  .action(async (qualifiedName, opts) => {
    const { handleAnnotate } = await import('./cli/checkHandler.js');
    await handleAnnotate(qualifiedName, opts);
  });

// ---- inject ----
program
  .command('inject')
  .description(h('Output concise registry summary for Claude Code SessionStart hook', 'Claude Code SessionStart 훅용 간결한 레지스트리 요약 출력'))
  .option('--project <id>', h('Project ID override', '프로젝트 ID 재정의'))
  .action(async (opts) => {
    try {
      const m = t();
      const store = getRegistryStore();
      const projectPath = process.cwd();
      const projectId = opts.project ?? resolveProjectId(projectPath);
      const projectName = basename(projectPath) || 'unknown';
      const stats = store.getStats(projectId);

      console.log(escapeTerminal(m.injectHeader(projectName)));
      console.log(`  ${m.totalEntities.padEnd(17)}${stats.total}`);
      console.log(`  ${m.deprecated.padEnd(17)}${stats.deprecated}`);
      console.log(`  ${m.untested.padEnd(17)}${stats.untested}`);
      console.log(`  ${m.highRisk.padEnd(17)}${stats.highRisk}`);

      // 관계 그래프 가용성 — LLM에게 who-calls/impact 사용 가능 여부를 알린다.
      const relCount = store.countRelations(projectId);
      if (relCount > 0) {
        console.log(`  ${m.callGraph.padEnd(17)}${m.callGraphReady(relCount)}`);
      } else if (stats.total > 0) {
        console.log(`  ${m.callGraph.padEnd(17)}${m.callGraphMissing}`);
      }

      if (stats.byKind.length > 0) {
        console.log(`  ${m.byKind}`);
        for (const { kind, count } of stats.byKind) {
          console.log(`    ${escapeTerminal(kind).padEnd(12)} ${count}`);
        }
      }

      const highRisk = store.highRiskEntities(projectId, 10);
      if (highRisk.length > 0) {
        console.log(`\n${m.highRiskHeader}`);
        for (const e of highRisk) {
          const loc = e.lineStart ? `${e.lineStart}${e.lineEnd ? `-${e.lineEnd}` : ''}` : '';
          const testIcon = `${m.injectTest}:${e.hasTests ? '✓' : '✗'}`;
          console.log(`  ${escapeTerminal(e.kind)} ${escapeTerminal(e.name)}:${loc}  ● ${escapeTerminal(e.status)}  ${testIcon}  ${m.injectRiskHigh}`);
        }
        if (stats.highRisk > highRisk.length) {
          console.log(`  ${m.andMore(stats.highRisk - highRisk.length)}`);
        }
      }
    } finally {
      closeRegistryStore();
    }
  });

// ---- export ----
program
  .command('export')
  .description(h('Export codebase structure as GraphQL-like SDL snapshot (LLM-friendly)', '코드베이스 구조를 GraphQL 유사 SDL 스냅샷으로 내보내기'))
  .option('-o, --output <path>', h('Write to file (default: stdout)', '파일에 쓰기 (기본값: stdout)'))
  .option('--project <id>', h('Project ID override', '프로젝트 ID 재정의'))
  .option('--dir <path>', h('Limit to entities under this directory prefix', '지정 디렉터리 아래 엔티티로 제한'))
  .action(async (opts) => {
    const { handleExport } = await import('./cli/exportHandler.js');
    await handleExport(opts);
  });

// ---- loc ----
program
  .command('loc')
  .description(h('Show LOC (lines of code) per file, sorted by size', '파일별 LOC를 크기순으로 표시'))
  .option('--dir <path>', h('Limit to files under this directory prefix', '지정 디렉터리 아래 파일로 제한'))
  .option('--ext <exts>', h('Comma-separated extensions to include (e.g. ts,py)', '포함할 확장자 목록 (쉼표 구분, 예: ts,py)'))
  .option('--no-blank', h('Exclude blank lines from count', '집계에서 빈 줄 제외'))
  .option('--no-comments', h('Exclude comment lines from count', '집계에서 주석 줄 제외'))
  .option('--entities', h('Show registered entity count per file (requires prior scan)', '파일별 등록 엔티티 수 표시 (사전 스캔 필요)'))
  .option('--project <id>', h('Project ID override (used with --entities)', '프로젝트 ID 재정의 (--entities와 사용)'))
  .action(async (opts) => {
    const { handleLoc } = await import('./cli/locHandler.js');
    await handleLoc({
      dir: opts.dir,
      ext: opts.ext,
      noBlank: opts.blank === false,
      noComments: opts.comments === false,
      entities: opts.entities,
      project: opts.project,
    });
  });

// ---- init ----
program
  .command('init')
  .description(h('Inject cxt usage guide into AI agent instruction files (claude/codex/gemini)', 'AI 에이전트 지침 파일에 cxt 사용 안내 주입'))
  .option('--target <list>', h('Targets: claude,codex,gemini,local-claude,local-agent,local-agents,all (default: claude)', '대상: claude,codex,gemini,local-claude,local-agent,local-agents,all (기본값: claude)'))
  .option('--path <file>', h('Custom file path (overrides --target)', '사용자 지정 파일 경로 (--target 재정의)'))
  .option('--remove', h('Remove cxt section from target files', '대상 파일에서 cxt 섹션 제거'))
  .option('--dry', h('Preview changes without writing', '쓰기 없이 변경 미리보기'))
  .action(async (opts) => {
    const { handleInit } = await import('./cli/initHandler.js');
    await handleInit(opts);
  });

// ---- who-calls (역방향 관계) ----
program
  .command('who-calls <name>')
  .alias('callers')
  .description(h('Show entities that reference (call/extend) the given entity', '지정 엔티티를 참조(호출/확장)하는 엔티티 표시'))
  .option('--project <id>', h('Project ID override', '프로젝트 ID 재정의'))
  .option('--type <type>', h('Filter by relation type: calls | extends | implements | uses | overrides', '관계 유형 필터: calls | extends | implements | uses | overrides'))
  .option('--json', h('JSON output', 'JSON 출력'))
  .action(async (name, opts) => {
    const { handleWhoCalls } = await import('./cli/relationHandler.js');
    await handleWhoCalls(name, opts);
  });

// ---- calls (정방향 관계) ----
program
  .command('calls <name>')
  .alias('callees')
  .description(h('Show entities referenced (called/extended) by the given entity', '지정 엔티티가 참조(호출/확장)하는 엔티티 표시'))
  .option('--project <id>', h('Project ID override', '프로젝트 ID 재정의'))
  .option('--type <type>', h('Filter by relation type: calls | extends | implements | uses | overrides', '관계 유형 필터: calls | extends | implements | uses | overrides'))
  .option('--json', h('JSON output', 'JSON 출력'))
  .action(async (name, opts) => {
    const { handleCalls } = await import('./cli/relationHandler.js');
    await handleCalls(name, opts);
  });

// ---- impact (transitive 역방향) ----
program
  .command('impact <name>')
  .description(h('Transitive impact analysis: all entities affected if <name> changes', '전이 영향 분석: <name> 변경 시 영향을 받는 모든 엔티티'))
  .option('--project <id>', h('Project ID override', '프로젝트 ID 재정의'))
  .option('--depth <n>', h('Max BFS depth (default: 5)', '최대 BFS 깊이 (기본값: 5)'))
  .option('--json', h('JSON output', 'JSON 출력'))
  .action(async (name, opts) => {
    const { handleImpact } = await import('./cli/relationHandler.js');
    await handleImpact(name, opts);
  });

program
  .command('preflight <name>')
  .description(h('Build a deterministic change-review checklist from impact, risk, tests, and warnings', '영향도·위험도·테스트·경고 기반의 결정론적 변경 점검표 생성'))
  .option('--project <id>', h('Project ID override', '프로젝트 ID 재정의'))
  .option('--depth <n>', h('Max impact depth (default: 5)', '최대 영향 깊이 (기본값: 5)'))
  .option('--json', h('JSON output', 'JSON 출력'))
  .option('--strict', h('Exit 1 when impacted candidates are high-risk, untested, or warned', '영향 후보에 고위험·미테스트·경고가 있으면 종료 코드 1'))
  .action(async (name, opts) => {
    const { handlePreflight } = await import('./cli/preflightHandler.js');
    await handlePreflight(name, opts);
  });

// ---- 레지스트리 위생 명령 (INT-1476/1479) ----
// 스펙 명칭 top-level: projects / prune / vacuum. project 그룹은 호환 유지.

program
  .command('projects')
  .description(h('List registered projects with entity counts', '등록 프로젝트와 엔티티 수 표시'))
  .action(async () => {
    const { handleProjectList } = await import('./cli/projectHandler.js');
    await handleProjectList();
  });

program
  .command('prune')
  .description(h('Prune registry: broken (zombie) entities by default, old events with --events', '레지스트리 정리: 기본은 손상 엔티티, --events는 오래된 이벤트'))
  .option('--events', h('Prune old events instead of broken entities', '손상 엔티티 대신 오래된 이벤트 정리'))
  .option('--days <n>', h('With --events: delete events older than N days (default: 30)', '--events 사용 시 N일보다 오래된 이벤트 삭제 (기본값: 30)'), '30')
  .option('--project <id>', h('Limit broken-entity prune to a specific project', '손상 엔티티 정리를 특정 프로젝트로 제한'))
  .option('--yes', h('Skip confirmation prompt', '확인 프롬프트 생략'))
  .action(async (opts: { events?: boolean; days?: string; project?: string; yes?: boolean }) => {
    const { handleProjectPrune } = await import('./cli/projectHandler.js');
    await handleProjectPrune(opts);
  });

program
  .command('vacuum')
  .description(h('Compact registry DB (SQLite VACUUM)', '레지스트리 DB 압축 (SQLite VACUUM)'))
  .option('--keep-days <n>', h('Also prune events older than N days before VACUUM', 'VACUUM 전에 N일보다 오래된 이벤트도 정리'))
  .option('--yes', h('Skip confirmation prompt', '확인 프롬프트 생략'))
  .action(async (opts: { keepDays?: string; yes?: boolean }) => {
    const { handleProjectVacuum } = await import('./cli/projectHandler.js');
    await handleProjectVacuum(opts);
  });

const projectCmd = program
  .command('project')
  .description(h('Project registry management (list / rm / prune / vacuum)', '프로젝트 레지스트리 관리 (list / rm / prune / vacuum)'));

projectCmd
  .command('list')
  .description(h('List registered projects with entity counts', '등록 프로젝트와 엔티티 수 표시'))
  .action(async () => {
    const { handleProjectList } = await import('./cli/projectHandler.js');
    await handleProjectList();
  });

projectCmd
  .command('rm <projectIdOrPath>')
  .description(h('Remove a project (by ID or directory path) and all its entities', '프로젝트(ID 또는 디렉터리 경로)와 모든 엔티티 제거'))
  .option('--yes', h('Skip confirmation prompt', '확인 프롬프트 생략'))
  .action(async (projectIdOrPath: string, opts: { yes?: boolean }) => {
    const { handleProjectRm } = await import('./cli/projectHandler.js');
    await handleProjectRm(projectIdOrPath, opts);
  });

projectCmd
  .command('prune')
  .description(h('Delete all broken (zombie) entities from the registry', '레지스트리의 모든 손상(좀비) 엔티티 삭제'))
  .option('--project <id>', h('Limit to a specific project', '특정 프로젝트로 제한'))
  .option('--yes', h('Skip confirmation prompt', '확인 프롬프트 생략'))
  .action(async (opts: { project?: string; yes?: boolean }) => {
    const { handleProjectPrune } = await import('./cli/projectHandler.js');
    await handleProjectPrune(opts);
  });

projectCmd
  .command('vacuum')
  .description(h('Compact registry DB and clean up old events', '레지스트리 DB 압축 및 오래된 이벤트 정리'))
  .option('--keep-days <n>', h('Keep events newer than N days (default: 30)', 'N일 이내 이벤트 유지 (기본값: 30)'), '30')
  .option('--yes', h('Skip confirmation prompt', '확인 프롬프트 생략'))
  .action(async (opts: { keepDays?: string; yes?: boolean }) => {
    const { handleProjectVacuum } = await import('./cli/projectHandler.js');
    await handleProjectVacuum(opts);
  });

// ---- audit (BS + registry 종합 감사) ----
program
  .command('audit')
  .description(h('Code audit: BS pattern scan + registry integrity (untested/high-risk/deprecated)', '코드 감사: BS 패턴 스캔 + 레지스트리 무결성 (미테스트/고위험/사용 중단)'))
  .option('--json', h('JSON output, exit 1 on critical (CI mode)', 'JSON 출력, 치명적 문제 시 종료 코드 1 (CI 모드)'))
  .option('--quick', h('BS patterns only — skip registry stats', 'BS 패턴만 검사 — 레지스트리 통계 생략'))
  .option('--dir <path>', h('Limit to a directory prefix', '지정 디렉터리로 제한'))
  .option('--project <id>', h('Project ID override', '프로젝트 ID 재정의'))
  .option('-v, --verbose', h('Per-file issue detail', '파일별 문제 상세 출력'))
  .action(async (opts) => {
    const { handleAudit } = await import('./cli/auditHandler.js');
    await handleAudit(opts);
  });

const { found: hasExplicitLang, value: explicitLang } = findExplicitLang(process.argv.slice(2));
if (hasExplicitLang) {
  if (explicitLang !== 'en' && explicitLang !== 'ko') {
    program.error(`error: unsupported language '${escapeTerminal(explicitLang ?? '')}' (expected en or ko)`);
  }
}
program.parse(preparedArgv);
