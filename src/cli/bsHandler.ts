// ============================================
// cxt - CLI BS Handler
// Created: 2026-06-11
// Purpose: cxt bs 독립 핸들러 — --json/--dir 지원 (INT-1485)
// Dependencies: registry/bsDetector
// ============================================

import { scanRepository } from '../registry/bsDetector.js';
import { t } from '../i18n.js';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
};

export interface BsOptions {
  verbose?: boolean;
  json?: boolean;
  dir?: string;
}

export async function handleBs(opts: BsOptions): Promise<void> {
  const m = t();
  const projectPath = process.cwd();

  if (!opts.json) {
    console.log(`\n${c.bold}${m.bsDetector}${c.reset} — scanning for bad code patterns...`);
    if (opts.dir) console.log(`  ${c.dim}dir: ${opts.dir}${c.reset}`);
    console.log(`  ${c.dim}path: ${projectPath}${c.reset}\n`);
  }

  const result = await scanRepository(projectPath, { verbose: opts.verbose, dir: opts.dir });

  if (opts.json) {
    console.log(JSON.stringify({
      filesScanned: result.filesScanned,
      bsScore: result.bsScore,
      critical: result.critical,
      warning: result.warning,
      minor: result.minor,
      issues: result.issues.map(i => ({
        file: i.filePath,
        line: i.line,
        severity: i.severity,
        category: i.category,
        message: i.message,
        matched: i.matchedText,
      })),
    }, null, 2));
    if (result.critical > 0) process.exitCode = 1;
    return;
  }

  const statusColor = result.critical > 0 ? c.red : result.warning > 0 ? c.yellow : c.green;
  const statusText = result.critical > 0 ? 'FAIL' : result.warning > 0 ? 'WARN' : 'CLEAN';

  console.log(`${c.bold}${m.bsScanResult}${c.reset}`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`  ${m.filesScanned.padEnd(16)}${c.bold}${result.filesScanned}${c.reset}`);
  console.log(`  ${m.bsScore.padEnd(16)}${statusColor}${c.bold}${result.bsScore.toFixed(1)}${c.reset} / 5.0`);
  console.log(`  Status:        ${statusColor}${c.bold}${statusText}${c.reset}`);
  console.log(`  CRITICAL:      ${result.critical > 0 ? c.red : c.green}${result.critical}${c.reset}`);
  console.log(`  WARNING:       ${result.warning > 0 ? c.yellow : c.green}${result.warning}${c.reset}`);
  console.log(`  MINOR:         ${result.minor > 0 ? c.dim : c.green}${result.minor}${c.reset}`);

  if (result.issues.length > 0) {
    const criticals = result.issues.filter(i => i.severity === 'critical');
    if (criticals.length > 0) {
      console.log(`\n  ${c.red}${c.bold}${m.criticalFixNow}${c.reset}`);
      for (const issue of criticals) {
        console.log(`    ${c.red}${issue.filePath}:${issue.line}${c.reset} — ${issue.message}`);
        console.log(`      ${c.dim}${issue.matchedText}${c.reset}`);
      }
    }

    const warnings = result.issues.filter(i => i.severity === 'warning');
    if (warnings.length > 0) {
      console.log(`\n  ${c.yellow}${m.warningRecommended}${c.reset}`);
      for (const issue of warnings.slice(0, 30)) {
        console.log(`    ${c.yellow}${issue.filePath}:${issue.line}${c.reset} — ${issue.message}`);
      }
      if (warnings.length > 30) {
        console.log(`    ${c.dim}${m.andMore(warnings.length - 30)}${c.reset}`);
      }
    }

    const minors = result.issues.filter(i => i.severity === 'minor');
    if (minors.length > 0) {
      console.log(`\n  ${c.dim}${m.minorCount(minors.length)}${c.reset}`);
      for (const issue of minors.slice(0, 10)) {
        console.log(`    ${c.dim}${issue.filePath}:${issue.line} — ${issue.message}${c.reset}`);
      }
      if (minors.length > 10) {
        console.log(`    ${c.dim}${m.andMore(minors.length - 10)}${c.reset}`);
      }
    }
  }

  console.log();
}
