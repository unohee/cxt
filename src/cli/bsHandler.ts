// ============================================
// cxt - CLI BS Handler
// Created: 2026-06-11
// Purpose: cxt bs 독립 핸들러 — --json/--dir 지원 (INT-1485)
// Dependencies: registry/bsDetector
// ============================================

import { scanRepository } from '../registry/bsDetector.js';
import { assertOutputOptions, bsOutcome, failedBsScan } from '../analysis/report.js';
import { toSarif } from '../analysis/sarif.js';
import { t } from '../i18n.js';
import { escapeTerminal, resolveProjectDirFilter, findingLocation, findingEvidence } from './outputSafety.js';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
};

export interface BsOptions {
  verbose?: boolean;
  json?: boolean;
  sarif?: boolean;
  dir?: string;
}

export async function handleBs(opts: BsOptions): Promise<void> {
  assertOutputOptions(opts);
  const m = t();
  const projectPath = process.cwd();

  if (!opts.json && !opts.sarif) {
    console.log(`\n${c.bold}${m.bsDetector}${c.reset} — scanning for bad code patterns...`);
    if (opts.dir) console.log(`  ${c.dim}dir: ${escapeTerminal(opts.dir)}${c.reset}`);
    console.log(`  ${c.dim}path: ${escapeTerminal(projectPath)}${c.reset}\n`);
  }

  const result = await scanRepository(projectPath, { verbose: opts.verbose && !opts.json && !opts.sarif, dir: resolveProjectDirFilter(projectPath, opts.dir) }).catch(failedBsScan);
  const outcome = bsOutcome(result, true);
  if (outcome.exitCode) process.exitCode = outcome.exitCode;
  if (opts.sarif) {
    console.log(JSON.stringify(toSarif(result, projectPath, { outcome }), null, 2));
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({
      filesScanned: result.filesScanned,
      bsScore: result.bsScore,
      critical: result.critical,
      warning: result.warning,
      minor: result.minor,
      errors: result.errors,
      analysis: result.analysis,
      outcome,
      issues: result.issues.map(i => ({
        file: i.filePath,
        line: i.line,
        severity: i.severity,
        category: i.category,
        message: i.message,
        matched: i.matchedText,
        rationale: i.rationale,
        ruleId: i.ruleId, ruleVersion: i.ruleVersion, column: i.column, endLine: i.endLine, endColumn: i.endColumn,
        precision: i.precision, precisionBasis: i.precisionBasis, ruleRationale: i.ruleRationale,
        flow: i.flow,
        fingerprint: i.fingerprint,
      })),
    }, null, 2));
    return;
  }

  const scanFailed = !outcome.pass;
  const statusColor = scanFailed ? c.red : result.warning > 0 ? c.yellow : c.green;
  const statusText = outcome.status === 'complete' ? scanFailed ? 'FAIL' : 'CLEAN' : outcome.status.toUpperCase();

  console.log(`${c.bold}${m.bsScanResult}${c.reset}`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`  ${m.filesScanned.padEnd(16)}${c.bold}${result.filesScanned}${c.reset}`);
  console.log(`  ${m.bsScore.padEnd(16)}${statusColor}${c.bold}${result.bsScore.toFixed(1)}${c.reset} / 5.0`);
  console.log(`  Status:        ${statusColor}${c.bold}${statusText}${c.reset}`);
  console.log(`  CRITICAL:      ${result.critical > 0 ? c.red : c.green}${result.critical}${c.reset}`);
  console.log(`  WARNING:       ${result.warning > 0 ? c.yellow : c.green}${result.warning}${c.reset}`);
  console.log(`  MINOR:         ${result.minor > 0 ? c.dim : c.green}${result.minor}${c.reset}`);
  if (result.analysis) console.log(`  Analysis:      ${result.analysis.completeness} (${Object.entries(result.analysis.engines).map(([engine, count]) => `${engine}:${count}`).join(', ')})`);
  if (result.errors.length > 0) console.log(`  SCAN ERRORS:   ${c.red}${result.errors.length}${c.reset}`);
  for (const error of result.errors) console.log(`    ${escapeTerminal(error)}`);
  for (const diagnostic of result.analysis?.diagnostics.slice(0, 10) ?? []) console.log(`    [${escapeTerminal(diagnostic.code)}] ${escapeTerminal(diagnostic.filePath)}: ${escapeTerminal(diagnostic.message)}`);

  if (result.issues.length > 0) {
    const criticals = result.issues.filter(i => i.severity === 'critical');
    if (criticals.length > 0) {
      console.log(`\n  ${c.red}${c.bold}${m.criticalFixNow}${c.reset}`);
      for (const issue of criticals) {
        console.log(`    ${c.red}${findingLocation(issue)}${c.reset} — ${escapeTerminal(issue.message)}`);
        console.log(`      ${c.dim}${escapeTerminal(issue.matchedText)}${c.reset}`);
        if (issue.rationale) console.log(`      ${c.dim}${escapeTerminal(issue.rationale)}${c.reset}`);
      }
    }

    const warnings = result.issues.filter(i => i.severity === 'warning');
    if (warnings.length > 0) {
      console.log(`\n  ${c.yellow}${m.warningRecommended}${c.reset}`);
      for (const issue of warnings) {
        console.log(`    ${c.yellow}${findingLocation(issue)}${c.reset} — ${escapeTerminal(issue.message)}`);
        const evidence = findingEvidence(issue);
        if (evidence) console.log(evidence);
      }
    }

    const minors = result.issues.filter(i => i.severity === 'minor');
    if (minors.length > 0) {
      console.log(`\n  ${c.dim}${m.minorCount(minors.length)}${c.reset}`);
      for (const issue of minors) {
        console.log(`    ${c.dim}${findingLocation(issue)} — ${escapeTerminal(issue.message)}${c.reset}`);
      }
    }
  }

  console.log();
}
