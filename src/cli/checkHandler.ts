// ============================================
// ctx - CLI Check Handler
// Created: 2026-04-11
// Purpose: `cxt check` 명령어 — 코드 레지스트리 조회
// ============================================

import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { scanRepository } from '../registry/entityScanner.js';
import { t } from '../i18n.js';
import type {
  CodeEntity, EntityKind, EntityStatus, RiskLevel, WarningSeverity, WarningCategory,
} from '../registry/schema.js';
import { escapeTerminal, pathMatchesDir, resolveProjectDirFilter } from './outputSafety.js';

const VALID_KINDS: EntityKind[] = ['function', 'class', 'module', 'type', 'constant'];

export function isBsScanPassing(result: { critical: number; errors: string[] }): boolean {
  return result.critical === 0 && result.errors.length === 0;
}

function listAllEntities(store: ReturnType<typeof getRegistryStore>, projectId: string, kind?: EntityKind): CodeEntity[] {
  const entities: CodeEntity[] = [];
  const pageSize = 5_000;
  for (let offset = 0; ; offset += pageSize) {
    const page = store.listEntities({ projectId, kind: kind ? [kind] : undefined, limit: pageSize, offset }).entities;
    entities.push(...page);
    if (page.length < pageSize) return entities;
  }
}

/** package.json name → Cargo.toml → go.mod → 폴더명 순으로 프로젝트 ID 추론 */
export function resolveProjectId(projectPath: string): string {
  const pkgPath = join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      if (pkg.name && typeof pkg.name === 'string') {
        return pkg.name.replace(/^@[^/]+\//, '');
      }
    } catch { /* ignore */ } // cxt-ignore: exception_hiding — package.json 파싱 실패 시 다음 fallback(Cargo.toml)으로 진행
  }

  const cargoPath = join(projectPath, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    try {
      const cargo = readFileSync(cargoPath, 'utf-8');
      const nameMatch = cargo.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (nameMatch) return nameMatch[1];
    } catch { /* ignore */ } // cxt-ignore: exception_hiding — Cargo.toml 파싱 실패 시 다음 fallback(go.mod)으로 진행
  }

  const goModPath = join(projectPath, 'go.mod');
  if (existsSync(goModPath)) {
    try {
      const goMod = readFileSync(goModPath, 'utf-8');
      const modMatch = goMod.match(/^module\s+(\S+)/m);
      if (modMatch) {
        const lastSegment = modMatch[1].split('/').pop();
        if (lastSegment) return lastSegment;
      }
    } catch { /* ignore */ } // cxt-ignore: exception_hiding — go.mod 파싱 실패 시 폴더명 fallback으로 진행
  }

  return basename(projectPath) || 'unknown';
}

// 색상 헬퍼 (ANSI)
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function statusBadge(status: string): string {
  switch (status) {
    case 'active': return `${c.green}●${c.reset} active`;
    case 'deprecated': return `${c.red}✗${c.reset} deprecated`;
    case 'experimental': return `${c.yellow}◎${c.reset} experimental`;
    case 'planned': return `${c.blue}○${c.reset} planned`;
    case 'broken': return `${c.red}⚠${c.reset} broken`;
    default: return status;
  }
}

function riskBadge(risk: string): string {
  switch (risk) {
    case 'high': return `${c.red}HIGH${c.reset}`;
    case 'medium': return `${c.yellow}MED${c.reset}`;
    case 'low': return `${c.green}LOW${c.reset}`;
    default: return risk;
  }
}

function severityBadge(sev: string): string {
  switch (sev) {
    case 'critical': return `${c.red}${c.bold}CRITICAL${c.reset}`;
    case 'error': return `${c.red}ERROR${c.reset}`;
    case 'warning': return `${c.yellow}WARNING${c.reset}`;
    case 'info': return `${c.blue}INFO${c.reset}`;
    default: return sev;
  }
}

function formatEntity(e: CodeEntity, verbose = true): string {
  const safe = escapeTerminal;
  const lines: string[] = [];
  const loc = e.lineStart ? `:${e.lineStart}${e.lineEnd ? `-${e.lineEnd}` : ''}` : '';
  const testIcon = e.hasTests ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;

  lines.push(
    `  ${c.bold}${safe(e.kind)}${c.reset} ${c.cyan}${safe(e.name)}${c.reset}${c.dim}${loc}${c.reset}` +
    `  ${statusBadge(safe(e.status))}  test:${testIcon}  risk:${riskBadge(safe(e.riskLevel))}`
  );

  if (verbose) {
    if (e.signature) lines.push(`    ${c.dim}sig: ${safe(e.signature)}${c.reset}`);
    if (e.author) lines.push(`    ${c.dim}author: ${safe(e.author)}${c.reset}`);
    if (e.description) lines.push(`    ${c.dim}${safe(e.description)}${c.reset}`);
    if (e.deprecatedReason) lines.push(`    ${c.red}reason: ${safe(e.deprecatedReason)}${c.reset}`);
    if (e.tags.length > 0) {
      lines.push(`    ${c.magenta}tags: ${e.tags.map(t => t.value ? `${safe(t.tag)}=${safe(t.value)}` : safe(t.tag)).join(', ')}${c.reset}`);
    }
    for (const w of e.warnings.filter(w => !w.resolved)) {
      lines.push(`    ${severityBadge(safe(w.severity))} [${safe(w.category)}] ${safe(w.message)}`);
    }
  }

  return lines.join('\n');
}

function formatEntityCompact(e: CodeEntity): string {
  const loc = e.lineStart ? `:${e.lineStart}` : '';
  const testIcon = e.hasTests ? '✓' : '✗';
  return `  ${escapeTerminal(e.kind).padEnd(9)} ${escapeTerminal(e.name).padEnd(30)} ${escapeTerminal(e.filePath)}${loc}  ${escapeTerminal(e.status).padEnd(12)} test:${testIcon}  risk:${escapeTerminal(e.riskLevel)}`;
}

export async function handleCheck(
  filePath: string | undefined,
  opts: {
    stats?: boolean;
    deprecated?: boolean;
    untested?: boolean;
    highRisk?: boolean;
    tag?: string;
    search?: string;
    project?: string;
    scan?: boolean;
    bs?: boolean;
    verbose?: boolean;
    tree?: boolean;
    ci?: boolean;
    dir?: string;
    kind?: string;
    global?: boolean;
  },
): Promise<void> {
  try {
    const store = getRegistryStore();

    // --scan
    if (opts.scan) {
      const projectPath = process.cwd();
      const projectId = opts.project ?? resolveProjectId(projectPath);

      const m = t();
      console.log(`\n${c.bold}${m.scanningRepo}${c.reset}`);
      console.log(`  ${c.dim}path: ${escapeTerminal(projectPath)}${c.reset}`);
      console.log(`  ${c.dim}project: ${escapeTerminal(projectId)}${c.reset}\n`);

      const result = await scanRepository(projectPath, projectId, {
        verbose: opts.verbose,
      });

      console.log(`${c.bold}${m.scanComplete}${c.reset}`);
      console.log(`${'─'.repeat(40)}`);
      console.log(`  ${m.filesScanned.padEnd(16)}${c.bold}${result.scanned}${c.reset}`);
      console.log(`  ${m.entitiesFound.padEnd(16)}${c.bold}${result.extracted}${c.reset}`);
      console.log(`  ${m.newRegistered.padEnd(16)}${c.green}+${result.registered}${c.reset}`);
      console.log(`  ${m.updated.padEnd(16)}${c.yellow}~${result.updated}${c.reset}`);
      console.log(`  ${m.markedBroken.padEnd(16)}${result.removed > 0 ? c.red : c.dim}${result.removed}${c.reset}`);
      console.log(`  ${m.testsMapped.padEnd(16)}${c.cyan}${result.testsMapped}${c.reset}`);
      console.log(`  ${'Relations'.padEnd(16)}${c.cyan}${result.relationsLoaded}${c.reset}`);
      console.log(`  ${m.duration.padEnd(16)}${c.dim}${result.durationMs}ms${c.reset}`);

      if (Object.keys(result.languageBreakdown).length > 0) {
        console.log(`\n  ${c.dim}${m.byLanguage}${c.reset}`);
        for (const [lang, count] of Object.entries(result.languageBreakdown).sort((a, b) => b[1] - a[1])) {
          console.log(`    ${escapeTerminal(lang).padEnd(12)} ${count} files`);
        }
      }

      if (result.errors.length > 0) {
        console.log(`\n  ${c.red}${m.errors} (${result.errors.length}):${c.reset}`);
        for (const err of result.errors.slice(0, 10)) {
          console.log(`    ${c.dim}${escapeTerminal(err)}${c.reset}`);
        }
        if (result.errors.length > 10) {
          console.log(`    ${c.dim}${m.andMore(result.errors.length - 10)}${c.reset}`);
        }
      }

      const stats = store.getStats(projectId);
      console.log(`\n${c.bold}${m.registryStatus}${c.reset}`);
      console.log(`  Total: ${stats.total}  deprecated: ${stats.deprecated}  untested: ${stats.untested}  high-risk: ${stats.highRisk}  warnings: ${stats.withWarnings}\n`);

      if (result.errors.length > 0) process.exitCode = 1;
      return;
    }

    // --bs
    if (opts.bs) {
      const { scanRepository: scanBs } = await import('../registry/bsDetector.js');
      const projectPath = process.cwd();

      const m = t();
      console.log(`\n${c.bold}${m.bsDetector}${c.reset} — scanning for bad code patterns...`);
      console.log(`  ${c.dim}path: ${escapeTerminal(projectPath)}${c.reset}\n`);

      const result = await scanBs(projectPath, {
        verbose: opts.verbose,
        dir: resolveProjectDirFilter(projectPath, opts.dir),
      });

      const scanPassing = isBsScanPassing(result);
      const statusColor = !scanPassing ? c.red : result.warning > 0 ? c.yellow : c.green;
      const statusText = !scanPassing ? 'FAIL' : result.warning > 0 ? 'WARN' : 'CLEAN';

      console.log(`${c.bold}${m.bsScanResult}${c.reset}`);
      console.log(`${'─'.repeat(50)}`);
      console.log(`  ${m.filesScanned.padEnd(16)}${c.bold}${result.filesScanned}${c.reset}`);
      console.log(`  ${m.bsScore.padEnd(16)}${statusColor}${c.bold}${result.bsScore.toFixed(1)}${c.reset} / 5.0`);
      console.log(`  Status:        ${statusColor}${c.bold}${statusText}${c.reset}`);
      console.log(`  CRITICAL:      ${result.critical > 0 ? c.red : c.green}${result.critical}${c.reset}`);
      console.log(`  WARNING:       ${result.warning > 0 ? c.yellow : c.green}${result.warning}${c.reset}`);
      console.log(`  MINOR:         ${result.minor > 0 ? c.dim : c.green}${result.minor}${c.reset}`);

      if (result.errors.length > 0) {
        console.log(`\n  ${c.red}${m.errors} (${result.errors.length}):${c.reset}`);
        for (const error of result.errors.slice(0, 10)) {
          console.log(`    ${c.dim}${escapeTerminal(error)}${c.reset}`);
        }
        if (result.errors.length > 10) {
          console.log(`    ${c.dim}${m.andMore(result.errors.length - 10)}${c.reset}`);
        }
      }

      if (result.issues.length > 0) {
        const criticals = result.issues.filter(i => i.severity === 'critical');
        if (criticals.length > 0) {
          console.log(`\n  ${c.red}${c.bold}${m.criticalFixNow}${c.reset}`);
          for (const issue of criticals) {
            console.log(`    ${c.red}${escapeTerminal(issue.filePath)}:${issue.line}${c.reset} — ${escapeTerminal(issue.message)}`);
            console.log(`      ${c.dim}${escapeTerminal(issue.matchedText)}${c.reset}`);
          }
        }

        const warnings = result.issues.filter(i => i.severity === 'warning');
        if (warnings.length > 0) {
          console.log(`\n  ${c.yellow}${m.warningRecommended}${c.reset}`);
          for (const issue of warnings.slice(0, 30)) {
            console.log(`    ${c.yellow}${escapeTerminal(issue.filePath)}:${issue.line}${c.reset} — ${escapeTerminal(issue.message)}`);
          }
          if (warnings.length > 30) {
            console.log(`    ${c.dim}${m.andMore(warnings.length - 30)}${c.reset}`);
          }
        }

        const minors = result.issues.filter(i => i.severity === 'minor');
        if (minors.length > 0) {
          console.log(`\n  ${c.dim}${m.minorCount(minors.length)}${c.reset}`);
          for (const issue of minors.slice(0, 10)) {
            console.log(`    ${c.dim}${escapeTerminal(issue.filePath)}:${issue.line} — ${escapeTerminal(issue.message)}${c.reset}`);
          }
          if (minors.length > 10) {
            console.log(`    ${c.dim}${m.andMore(minors.length - 10)}${c.reset}`);
          }
        }
      }

      console.log();
      if (!scanPassing) process.exitCode = 1;
      return;
    }

    // --kind
    if (opts.kind) {
      if (!VALID_KINDS.includes(opts.kind as EntityKind)) {
        console.error(`${c.red}Invalid kind: ${escapeTerminal(opts.kind)}. Valid: ${VALID_KINDS.join(', ')}${c.reset}`);
        process.exitCode = 1;
        return;
      }
      const projectId = opts.project ?? resolveProjectId(process.cwd());
      const entities = listAllEntities(store, projectId, opts.kind as EntityKind);
      const dirFilter = resolveProjectDirFilter(process.cwd(), opts.dir);
      const scoped = dirFilter ? entities.filter(e => pathMatchesDir(e.filePath, dirFilter)) : entities;
      console.log(`\n${c.bold}${escapeTerminal(opts.kind)} entities${c.reset} (${scoped.length}${opts.dir ? ` under ${escapeTerminal(opts.dir)}` : ''})\n`);
      if (scoped.length === 0) {
        console.log(`  ${c.dim}none${c.reset}\n`);
      } else {
        for (const e of scoped) console.log(formatEntityCompact(e));
        console.log();
      }
      return;
    }

    // --tree
    if (opts.tree) {
      const projectId = opts.project ?? resolveProjectId(process.cwd());
      const scopePath = opts.dir ? (resolveProjectDirFilter(process.cwd(), opts.dir) ?? '') : (filePath || '');
      const entities = listAllEntities(store, projectId);

      const tree = new Map<string, Map<string, { total: number; untested: number; highRisk: number; deprecated: number; kinds: Map<string, number> }>>();

      for (const e of entities) {
        if (scopePath && !pathMatchesDir(e.filePath, scopePath)) continue;
        const parts = e.filePath.split('/');
        const fileName = parts.pop()!;
        const dirPath = parts.join('/') || '.';

        if (!tree.has(dirPath)) tree.set(dirPath, new Map());
        const dir = tree.get(dirPath)!;

        if (!dir.has(fileName)) {
          dir.set(fileName, { total: 0, untested: 0, highRisk: 0, deprecated: 0, kinds: new Map() });
        }
        const file = dir.get(fileName)!;
        file.total++;
        if (!e.hasTests) file.untested++;
        if (e.riskLevel === 'high') file.highRisk++;
        if (e.status === 'deprecated') file.deprecated++;
        file.kinds.set(e.kind, (file.kinds.get(e.kind) || 0) + 1);
      }

      const sortedDirs = [...tree.keys()].sort();
      const totalFiles = [...tree.values()].reduce((s, d) => s + d.size, 0);
      const totalEntities = entities.filter(e => !scopePath || pathMatchesDir(e.filePath, scopePath)).length;

      console.log(`\n${c.bold}Code Tree${c.reset}${scopePath ? ` (${escapeTerminal(scopePath)})` : ''} — ${totalFiles} files, ${totalEntities} entities\n`);

      for (const dirPath of sortedDirs) {
        const files = tree.get(dirPath)!;
        const dirTotal = [...files.values()].reduce((s, f) => s + f.total, 0);
        const dirUntested = [...files.values()].reduce((s, f) => s + f.untested, 0);
        const dirHighRisk = [...files.values()].reduce((s, f) => s + f.highRisk, 0);

        const riskFlag = dirHighRisk > 0 ? ` ${c.red}${dirHighRisk} high-risk${c.reset}` : '';
        console.log(`${c.bold}${escapeTerminal(dirPath)}/${c.reset} ${c.dim}(${dirTotal} entities, ${dirUntested} untested${riskFlag})${c.reset}`);

        const sortedFiles = [...files.entries()].sort((a, b) => b[1].total - a[1].total);
        for (const [fileName, info] of sortedFiles) {
          const kindStr = [...info.kinds.entries()].map(([k, n]) => `${n} ${escapeTerminal(k)}`).join(', ');
          const flags: string[] = [];
          if (info.highRisk > 0) flags.push(`${c.red}${info.highRisk} high-risk${c.reset}`);
          if (info.deprecated > 0) flags.push(`${c.red}${info.deprecated} deprecated${c.reset}`);
          const flagStr = flags.length ? ' ' + flags.join(' ') : '';
          const testPct = info.total > 0 ? Math.round(((info.total - info.untested) / info.total) * 100) : 0;
          const testColor = testPct === 100 ? c.green : testPct > 50 ? c.yellow : c.red;

          console.log(`  ${c.cyan}${escapeTerminal(fileName)}${c.reset} ${c.dim}${kindStr}${c.reset} ${testColor}${testPct}% tested${c.reset}${flagStr}`);
        }
      }
      console.log();
      return;
    }

    // --ci
    if (opts.ci) {
      const projectPath = process.cwd();
      const projectId = opts.project ?? resolveProjectId(projectPath);
      const dirFilter = resolveProjectDirFilter(projectPath, opts.dir);

      const { scanRepository: scanBs } = await import('../registry/bsDetector.js');
      const bsResult = await scanBs(projectPath, { verbose: false, dir: dirFilter });

      const stats = store.getStats(projectId, dirFilter);

      const result = {
        project: projectId,
        path: projectPath,
        registry: {
          total: stats.total,
          deprecated: stats.deprecated,
          untested: stats.untested,
          highRisk: stats.highRisk,
          warnings: stats.withWarnings,
        },
        bs: {
          filesScanned: bsResult.filesScanned,
          score: bsResult.bsScore,
          critical: bsResult.critical,
          warning: bsResult.warning,
          minor: bsResult.minor,
          errors: bsResult.errors,
        },
        pass: isBsScanPassing(bsResult),
      };

      console.log(JSON.stringify(result, null, 2));

      if (!isBsScanPassing(bsResult)) {
        process.exitCode = 1;
      }
      return;
    }

    // --stats
    if (opts.stats) {
      const m = t();
      // Default scope: current project. --global opts into cross-project aggregation.
      // Explicit --project always wins. This keeps `--stats` consistent with
      // `--tree`, `--untested`, etc., which are all project-scoped by default.
      const scopeId = opts.global
        ? undefined
        : (opts.project ?? resolveProjectId(process.cwd()));
      const dirFilter = resolveProjectDirFilter(process.cwd(), opts.dir);
      const stats = store.getStats(scopeId, dirFilter);
      console.log(`\n${c.bold}${m.registryStats}${c.reset}`);
      console.log(`  ${c.dim}${escapeTerminal(scopeId ? m.statsScopeProject(scopeId) : m.statsScopeGlobal)}${c.reset}`);
      console.log(`${'─'.repeat(40)}`);
      console.log(`  ${m.totalEntities.padEnd(18)}${c.bold}${stats.total}${c.reset}`);
      console.log(`  ${m.deprecated.padEnd(18)}${stats.deprecated > 0 ? c.red : c.green}${stats.deprecated}${c.reset}`);
      console.log(`  ${m.untested.padEnd(18)}${stats.untested > 0 ? c.yellow : c.green}${stats.untested}${c.reset}`);
      console.log(`  ${m.highRisk.padEnd(18)}${stats.highRisk > 0 ? c.red : c.green}${stats.highRisk}${c.reset}`);
      console.log(`  ${m.withWarnings.padEnd(18)}${stats.withWarnings > 0 ? c.yellow : c.green}${stats.withWarnings}${c.reset}`);
      if (stats.byKind.length > 0) {
        console.log(`\n  ${c.dim}${m.byKind}${c.reset}`);
        for (const { kind, count } of stats.byKind) {
          console.log(`    ${escapeTerminal(kind).padEnd(12)} ${count}`);
        }
      }
      if (stats.byStatus.length > 0) {
        console.log(`\n  ${c.dim}${m.byStatus}${c.reset}`);
        for (const { status, count } of stats.byStatus) {
          console.log(`    ${escapeTerminal(status).padEnd(14)} ${count}`);
        }
      }
      console.log();
      return;
    }

    // --deprecated
    if (opts.deprecated) {
      const m = t();
      const projectId = opts.project ?? resolveProjectId(process.cwd());
      const dirFilter = resolveProjectDirFilter(process.cwd(), opts.dir);
      const allEntities = store.deprecatedEntities(projectId);
      const entities = dirFilter ? allEntities.filter((entity) => pathMatchesDir(entity.filePath, dirFilter)) : allEntities;
      console.log(`\n${c.bold}${m.deprecatedEntities}${c.reset} (${entities.length})\n`);
      if (entities.length === 0) {
        console.log(`  ${c.green}${m.none}${c.reset}\n`);
      } else {
        for (const e of entities) console.log(formatEntity(e));
        console.log();
      }
      return;
    }

    // --untested
    if (opts.untested) {
      const m = t();
      const projectId = opts.project ?? resolveProjectId(process.cwd());
      const dirFilter = resolveProjectDirFilter(process.cwd(), opts.dir);
      const allEntities = store.untestedEntities(projectId);
      const entities = dirFilter ? allEntities.filter((entity) => pathMatchesDir(entity.filePath, dirFilter)) : allEntities;
      console.log(`\n${c.bold}${m.untestedEntities}${c.reset} (${entities.length})\n`);
      if (entities.length === 0) {
        console.log(`  ${c.green}${m.allTested}${c.reset}\n`);
      } else {
        for (const e of entities) console.log(formatEntityCompact(e));
        console.log();
      }
      return;
    }

    // --high-risk
    if (opts.highRisk) {
      const m = t();
      const projectId = opts.project ?? resolveProjectId(process.cwd());
      const dirFilter = resolveProjectDirFilter(process.cwd(), opts.dir);
      const allEntities = store.highRiskEntities(projectId);
      const entities = dirFilter ? allEntities.filter((entity) => pathMatchesDir(entity.filePath, dirFilter)) : allEntities;
      console.log(`\n${c.bold}${m.highRiskEntities}${c.reset} (${entities.length})\n`);
      if (entities.length === 0) {
        console.log(`  ${c.green}${m.none}${c.reset}\n`);
      } else {
        for (const e of entities) console.log(formatEntity(e));
        console.log();
      }
      return;
    }

    // --tag
    if (opts.tag) {
      const m = t();
      const projectId = opts.project ?? resolveProjectId(process.cwd());
      const dirFilter = resolveProjectDirFilter(process.cwd(), opts.dir);
      const allEntities = store.entitiesByTag(opts.tag, undefined, projectId);
      const entities = dirFilter ? allEntities.filter((entity) => pathMatchesDir(entity.filePath, dirFilter)) : allEntities;
      console.log(`\n${c.bold}${escapeTerminal(m.entitiesTagged(opts.tag))}${c.reset} (${entities.length})\n`);
      if (entities.length === 0) {
        console.log(`  ${c.dim}${escapeTerminal(m.noEntitiesWithTag(opts.tag))}${c.reset}\n`);
      } else {
        for (const e of entities) console.log(formatEntityCompact(e));
        console.log();
      }
      return;
    }

    // --search — 기본은 현재 프로젝트 스코프, --global이면 전역.
    if (opts.search) {
      const m = t();
      const scopeId = opts.global ? undefined : (opts.project ?? resolveProjectId(process.cwd()));
      const dirFilter = resolveProjectDirFilter(process.cwd(), opts.dir);
      const entities = store.searchEntities(opts.search, 20, scopeId, dirFilter);
      const scopeNote = scopeId ? ` ${c.dim}[project: ${escapeTerminal(scopeId)}]${c.reset}` : ` ${c.dim}[global]${c.reset}`;
      console.log(`\n${c.bold}${escapeTerminal(m.searchResults(opts.search, entities.length))}${c.reset}${scopeNote}\n`);
      if (entities.length === 0) {
        console.log(`  ${c.dim}${m.noMatches}${c.reset}`);
        if (scopeId) console.log(`  ${c.dim}(다른 프로젝트까지 찾으려면 --global)${c.reset}`);
        console.log();
      } else {
        for (const e of entities) console.log(formatEntity(e));
        console.log();
      }
      return;
    }

    // 파일 경로 지정: fileBrief
    if (filePath) {
      const m = t();
      const projectId = opts.project ?? resolveProjectId(process.cwd());
      const brief = store.fileBrief(filePath, projectId);
      console.log(`\n${c.bold}${m.fileBrief}: ${escapeTerminal(filePath)}${c.reset}`);
      console.log(`${'─'.repeat(40)}`);
      console.log(`  ${c.dim}${escapeTerminal(brief.summary)}${c.reset}\n`);

      if (brief.entities.length === 0) {
        console.log(`  ${c.dim}${m.noRegisteredEntities}${c.reset}`);
        console.log(`  ${c.dim}${m.runScanFirst}${c.reset}\n`);
      } else {
        for (const e of brief.entities) console.log(formatEntity(e));
        console.log();
      }
      return;
    }

    // --dir 단독 호출: 현재 프로젝트의 해당 디렉터리 엔티티 목록.
    if (opts.dir) {
      const projectId = opts.project ?? resolveProjectId(process.cwd());
      const dirFilter = resolveProjectDirFilter(process.cwd(), opts.dir);
      const entities = listAllEntities(store, projectId).filter((entity) => pathMatchesDir(entity.filePath, dirFilter ?? ''));
      console.log(`\n${c.bold}${escapeTerminal(opts.dir)}${c.reset} (${entities.length})\n`);
      for (const entity of entities) console.log(formatEntityCompact(entity));
      console.log();
      return;
    }

    // 인자 없이 호출 시
    const m = t();
    const projectId = opts.project ?? resolveProjectId(process.cwd());
    const dirFilter = resolveProjectDirFilter(process.cwd(), opts.dir);
    const stats = store.getStats(projectId, dirFilter);
    if (stats.total === 0) {
      console.log(`\n${c.bold}${m.codeRegistry}${c.reset}: ${m.registryEmpty}`);
      console.log(`  ${c.dim}${m.runScan}${c.reset}\n`);
    } else {
      console.log(`\n${c.bold}${m.codeRegistry}${c.reset}: ${stats.total} entities`);
      console.log(`  ${stats.deprecated} deprecated, ${stats.untested} untested, ${stats.highRisk} high-risk, ${stats.withWarnings} with warnings`);
      console.log(`\n  ${c.dim}${m.usage}${c.reset}`);
      console.log(`  ${c.dim}  cxt check <file>       ${c.reset}${m.fileBrief}`);
      console.log(`  ${c.dim}  cxt check --stats       ${c.reset}${m.registryStats}`);
      console.log(`  ${c.dim}  cxt check --deprecated  ${c.reset}${m.deprecatedEntities}`);
      console.log(`  ${c.dim}  cxt check --untested    ${c.reset}${m.untestedEntities}`);
      console.log(`  ${c.dim}  cxt check --search <q>  ${c.reset}FTS search\n`);
    }
  } finally {
    closeRegistryStore();
  }
}

/**
 * ctx annotate <qualifiedName> — 엔티티 어노테이션
 */
export async function handleAnnotate(
  qualifiedName: string,
  opts: {
    deprecate?: string | boolean;
    status?: string;
    tag?: string;
    untag?: string;
    note?: string;
    risk?: string;
    warn?: string;
  },
): Promise<void> {
  try {
    const store = getRegistryStore();

    const m = t();
    const currentProjectId = resolveProjectId(process.cwd());
    let entity = store.getEntityByName(qualifiedName, currentProjectId);
    if (!entity) {
      const results = store.searchEntities(qualifiedName, 5);
      if (results.length === 0) {
        console.error(`${c.red}${escapeTerminal(m.entityNotFound(qualifiedName))}${c.reset}`);
        console.error(`${c.dim}${m.useQualifiedName}${c.reset}`);
        process.exitCode = 1;
        return;
      }
      if (results.length === 1) {
        entity = results[0];
      } else {
        console.log(`${c.yellow}${escapeTerminal(m.multipleMatches(qualifiedName))}${c.reset}\n`);
        for (const e of results) {
          console.log(`  ${c.cyan}${escapeTerminal(e.qualifiedName)}${c.reset}  ${escapeTerminal(e.kind)}  ${statusBadge(escapeTerminal(e.status))}`);
        }
        console.log(`\n${c.dim}${m.useFullQualifiedName}${c.reset}`);
        return;
      }
    }

    console.log(`\n${c.bold}${m.annotating}${c.reset} ${c.cyan}${escapeTerminal(entity.qualifiedName)}${c.reset}\n`);
    let changed = false;

    if (opts.deprecate !== undefined) {
      const reason = typeof opts.deprecate === 'string' ? opts.deprecate : undefined;
      store.deprecateEntity(entity.id, reason);
      console.log(`  ${c.red}✗${c.reset} ${m.deprecatedStatus}${reason ? `: ${escapeTerminal(reason)}` : ''}`);
      changed = true;
    }

    if (opts.status) {
      const validStatuses = ['active', 'deprecated', 'experimental', 'planned', 'broken'];
      if (!validStatuses.includes(opts.status)) {
        console.error(`  ${c.red}${escapeTerminal(m.invalidStatus(opts.status, validStatuses.join(', ')))}${c.reset}`);
      } else {
        store.changeEntityStatus(entity.id, opts.status as EntityStatus);
        console.log(`  ${statusBadge(opts.status)} ${m.statusChanged}`);
        changed = true;
      }
    }

    if (opts.tag) {
      const [tagKey, tagValue] = opts.tag.split('=', 2);
      store.addTag(entity.id, tagKey, tagValue);
      console.log(`  ${c.magenta}+${c.reset} ${m.tagAdded} ${escapeTerminal(tagKey)}${tagValue ? `=${escapeTerminal(tagValue)}` : ''}`);
      changed = true;
    }

    if (opts.untag) {
      store.removeTag(entity.id, opts.untag);
      console.log(`  ${c.dim}-${c.reset} ${m.tagRemoved} ${escapeTerminal(opts.untag)}`);
      changed = true;
    }

    if (opts.note) {
      store.addEvent(entity.id, 'note_added', { content: opts.note, actor: 'cli' });
      console.log(`  ${c.blue}${m.noteAdded}${c.reset}`);
      changed = true;
    }

    if (opts.risk) {
      const validRisks = ['low', 'medium', 'high'];
      if (!validRisks.includes(opts.risk)) {
        console.error(`  ${c.red}${escapeTerminal(m.invalidRisk(opts.risk, validRisks.join(', ')))}${c.reset}`);
      } else {
        store.updateEntity(entity.id, { riskLevel: opts.risk as RiskLevel }, 'cli');
        console.log(`  Risk: ${riskBadge(opts.risk)}`);
        changed = true;
      }
    }

    if (opts.warn) {
      const warnMatch = opts.warn.match(/^(info|warning|error|critical)\/(security|performance|correctness|style):\s*(.+)/);
      if (!warnMatch) {
        console.error(`  ${c.red}${m.invalidWarnFormat}${c.reset}`);
        console.error(`  ${c.dim}${m.warnExample}${c.reset}`);
      } else {
        store.addWarning(entity.id, warnMatch[1] as WarningSeverity, warnMatch[2] as WarningCategory, warnMatch[3]);
        console.log(`  ${severityBadge(warnMatch[1])} [${warnMatch[2]}] ${escapeTerminal(warnMatch[3])}`);
        changed = true;
      }
    }

    if (!changed) {
      console.log(`  ${c.dim}${m.noChanges}${c.reset}`);
    }

    if (changed) {
      const updated = store.getEntity(entity.id);
      if (updated) {
        console.log(`\n${c.dim}${m.updatedState}${c.reset}`);
        console.log(formatEntity(updated));
      }
    }
    console.log();
  } finally {
    closeRegistryStore();
  }
}
