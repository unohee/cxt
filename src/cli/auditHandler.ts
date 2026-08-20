// ============================================
// cxt - CLI Audit Handler
// Created: 2026-06-09
// Purpose: `cxt audit` — BS 패턴 + 레지스트리 무결성 종합 감사 (/audit 스킬 이관)
// ============================================

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { resolveProjectId } from './checkHandler.js';
import { t } from '../i18n.js';
import { escapeTerminal, resolveProjectDirFilter } from './outputSafety.js';

// 색상 헬퍼 (ANSI) — checkHandler 와 동일 팔레트
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

/** 마커 파일로 언어 트랙 감지. /audit 의 Detect-then-Apply 원칙을 그대로 이관. */
function detectTracks(projectPath: string): string[] {
  const tracks: string[] = [];
  if (existsSync(join(projectPath, 'Cargo.toml'))) tracks.push('rust');
  if (existsSync(join(projectPath, 'package.json'))) {
    tracks.push(existsSync(join(projectPath, 'tsconfig.json')) ? 'ts' : 'js');
  }
  if (existsSync(join(projectPath, 'go.mod'))) tracks.push('go');
  if (
    existsSync(join(projectPath, 'pyproject.toml')) ||
    existsSync(join(projectPath, 'setup.py')) ||
    existsSync(join(projectPath, 'requirements.txt'))
  ) {
    tracks.push('python');
  }
  return tracks;
}

export interface AuditResult {
  project: string;
  path: string;
  tracks: string[];
  bs: {
    filesScanned: number;
    score: number;
    critical: number;
    warning: number;
    minor: number;
    errors: string[];
  };
  registry: {
    total: number;
    deprecated: number;
    untested: number;
    highRisk: number;
    warnings: number;
  };
  pass: boolean;
}

export async function handleAudit(opts: {
  json?: boolean;
  quick?: boolean;
  verbose?: boolean;
  project?: string;
  dir?: string;
}): Promise<void> {
  const store = getRegistryStore();
  try {
    const projectPath = process.cwd();
    const projectId = opts.project ?? resolveProjectId(projectPath);
    const tracks = detectTracks(projectPath);
    const m = t();

    // ── BS 스캔 (항상 실행) ──
    const { scanRepository: scanBs } = await import('../registry/bsDetector.js');
    const dirFilter = resolveProjectDirFilter(projectPath, opts.dir);
    const bs = await scanBs(projectPath, { verbose: opts.verbose, dir: dirFilter });
    const issues = bs.issues;
    const { critical, warning, minor, filesScanned, bsScore: score } = bs;

    // ── 레지스트리 통계 (--quick 이면 skip) ──
    const stats = opts.quick
      ? { total: 0, deprecated: 0, untested: 0, highRisk: 0, withWarnings: 0 }
      : store.getStats(projectId, dirFilter);

    const pass = critical === 0 && bs.errors.length === 0;

    const result: AuditResult = {
      project: projectId,
      path: projectPath,
      tracks,
      bs: { filesScanned, score, critical, warning, minor, errors: bs.errors.map(escapeTerminal) },
      registry: {
        total: stats.total,
        deprecated: stats.deprecated,
        untested: stats.untested,
        highRisk: stats.highRisk,
        warnings: stats.withWarnings,
      },
      pass,
    };

    // ── JSON 모드 (CI 용) ──
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      if (!pass) process.exitCode = 1;
      return;
    }

    // ── 사람용 리포트 ──
    const statusColor = !pass ? c.red : warning > 0 ? c.yellow : c.green;
    const statusText = !pass ? 'FAIL' : warning > 0 ? 'WARN' : 'PASS';

    console.log(`\n${c.bold}${m.auditHeader}${c.reset} — ${escapeTerminal(projectId)}`);
    console.log(`  ${c.dim}${escapeTerminal(projectPath)}${c.reset}`);
    console.log(`  ${c.dim}${m.auditTracks} ${escapeTerminal(tracks.length ? tracks.join(', ') : m.none)}${c.reset}\n`);

    console.log(`${'─'.repeat(50)}`);
    console.log(`  ${m.filesScanned.padEnd(18)}${c.bold}${filesScanned}${c.reset}`);
    console.log(`  ${m.bsScore.padEnd(18)}${statusColor}${c.bold}${score.toFixed(1)}${c.reset} / 5.0`);
    console.log(`  ${'Status:'.padEnd(18)}${statusColor}${c.bold}${statusText}${c.reset}`);
    console.log(`  ${'CRITICAL:'.padEnd(18)}${critical > 0 ? c.red : c.green}${critical}${c.reset}`);
    console.log(`  ${'WARNING:'.padEnd(18)}${warning > 0 ? c.yellow : c.green}${warning}${c.reset}`);
    console.log(`  ${'MINOR:'.padEnd(18)}${minor > 0 ? c.dim : c.green}${minor}${c.reset}`);
    if (bs.errors.length > 0) {
      console.log(`  ${'SCAN ERRORS:'.padEnd(18)}${c.red}${bs.errors.length}${c.reset}`);
      for (const error of bs.errors.slice(0, 10)) console.log(`    ${c.dim}${escapeTerminal(error)}${c.reset}`);
    }

    if (!opts.quick && stats.total > 0) {
      console.log(`\n  ${c.bold}${m.registryStatus}${c.reset} ${c.dim}(${stats.total} ${m.totalEntities.replace(':', '').toLowerCase()})${c.reset}`);
      console.log(`  ${m.untested.padEnd(18)}${stats.untested > 0 ? c.yellow : c.green}${stats.untested}${c.reset}`);
      console.log(`  ${m.highRisk.padEnd(18)}${stats.highRisk > 0 ? c.red : c.green}${stats.highRisk}${c.reset}`);
      console.log(`  ${m.deprecated.padEnd(18)}${stats.deprecated > 0 ? c.yellow : c.green}${stats.deprecated}${c.reset}`);
      console.log(`  ${m.withWarnings.padEnd(18)}${stats.withWarnings > 0 ? c.yellow : c.green}${stats.withWarnings}${c.reset}`);
    }

    // ── 이슈 상세 ──
    const criticals = issues.filter(i => i.severity === 'critical');
    if (criticals.length > 0) {
      console.log(`\n  ${c.red}${c.bold}${m.criticalFixNow}${c.reset}`);
      for (const issue of criticals) {
        console.log(`    ${c.red}${escapeTerminal(issue.filePath)}:${issue.line}${c.reset} — ${escapeTerminal(issue.message)}`);
        console.log(`      ${c.dim}${escapeTerminal(issue.matchedText)}${c.reset}`);
      }
    }

    const warnings = issues.filter(i => i.severity === 'warning');
    if (warnings.length > 0) {
      console.log(`\n  ${c.yellow}${m.warningRecommended}${c.reset}`);
      for (const issue of warnings.slice(0, 30)) {
        console.log(`    ${c.yellow}${escapeTerminal(issue.filePath)}:${issue.line}${c.reset} — ${escapeTerminal(issue.message)}`);
      }
      if (warnings.length > 30) {
        console.log(`    ${c.dim}${m.andMore(warnings.length - 30)}${c.reset}`);
      }
    }

    const minors = issues.filter(i => i.severity === 'minor');
    if (minors.length > 0) {
      console.log(`\n  ${c.dim}${m.minorCount(minors.length)}${c.reset}`);
      for (const issue of minors.slice(0, 10)) {
        console.log(`    ${c.dim}${escapeTerminal(issue.filePath)}:${issue.line} — ${escapeTerminal(issue.message)}${c.reset}`);
      }
      if (minors.length > 10) {
        console.log(`    ${c.dim}${m.andMore(minors.length - 10)}${c.reset}`);
      }
    }

    console.log();
    if (!pass) process.exitCode = 1;
  } finally {
    closeRegistryStore();
  }
}
