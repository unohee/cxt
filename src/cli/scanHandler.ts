import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { scanRepository } from '../registry/entityScanner.js';
import { resolveProjectId } from './checkHandler.js';
import { t } from '../i18n.js';
import { escapeTerminal } from './outputSafety.js';
import { assertOutputOptions, scanOutcome, failedBsScan, bsOutcome } from '../analysis/report.js';
import { toSarif } from '../analysis/sarif.js';
const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

export async function handleScan(opts: { json?: boolean; sarif?: boolean; verbose?: boolean; project?: string; full?: boolean }): Promise<void> {
  assertOutputOptions(opts);
  try {
    const store = getRegistryStore();
    const projectPath = process.cwd();
    const projectId = opts.project ?? resolveProjectId(projectPath);

    const m = t();
    if (!opts.json && !opts.sarif) {
      console.log(`\n${c.bold}${m.scanningRepo}${c.reset}`);
      console.log(`  ${c.dim}path: ${escapeTerminal(projectPath)}${c.reset}`);
      console.log(`  ${c.dim}project: ${escapeTerminal(projectId)}${c.reset}\n`);

    }
    const result = await scanRepository(projectPath, projectId, {
      verbose: opts.verbose && !opts.json && !opts.sarif,
      full: opts.full,
    });

    const outcome = scanOutcome(result);
    if (outcome.exitCode) process.exitCode = outcome.exitCode;
    if (opts.json) { console.log(JSON.stringify({ ...result, outcome }, null, 2)); return; }
    if (opts.sarif) {
      const report = { issues: [], filesScanned: result.scanned, critical: 0, warning: 0, minor: 0, bsScore: 0, errors: result.errors,
        analysis: { completeness: outcome.status === 'complete' ? 'complete' as const : 'partial' as const,
          engines: result.parserBreakdown, diagnostics: [...result.diagnostics, ...result.dataflow.diagnostics] } };
      console.log(JSON.stringify(toSarif(report, projectPath, { outcome, properties: { scan: result } }), null, 2)); return;
    }
    console.log(`${c.bold}${outcome.status === 'complete' ? m.scanComplete : m.scanIncomplete}${c.reset}`);
    console.log(`  Analysis: ${outcome.status}`);
    console.log(`  Cache: frontend ${result.cache.frontendHits} reused / ${result.cache.frontendMisses} computed; summaries ${result.cache.summaryHits} reused / ${result.cache.summaryMisses} computed; committed=${result.cache.committed}`);
    console.log(`${'─'.repeat(40)}`);
    console.log(`  ${m.filesScanned.padEnd(16)}${c.bold}${result.scanned}${c.reset}`);
    console.log(`  ${m.entitiesFound.padEnd(16)}${c.bold}${result.extracted}${c.reset}`);
    console.log(`  ${m.newRegistered.padEnd(16)}${c.green}+${result.registered}${c.reset}`);
    console.log(`  ${m.updated.padEnd(16)}${c.yellow}~${result.updated}${c.reset}`);
    console.log(`  ${m.markedBroken.padEnd(16)}${result.removed > 0 ? c.red : c.dim}${result.removed}${c.reset}`);
    console.log(`  ${m.testsMapped.padEnd(16)}${c.cyan}${result.testsMapped}${c.reset}`);
    console.log(`  ${'Relations'.padEnd(16)}${c.cyan}${result.relationsLoaded}${c.reset}`);
    console.log(`  ${'Parsers'.padEnd(16)}${Object.entries(result.parserBreakdown).map(([engine, count]) => `${engine}: ${count}`).join(', ') || 'none'}`);
    console.log(`  ${'Call sites'.padEnd(16)}${result.callSites.total} (${result.callSites.resolved} resolved, ${result.callSites.unresolved} unresolved, ${result.callSites.external} external)`);
    console.log(`  ${'CFGs'.padEnd(16)}${result.controlFlow.total} (${result.controlFlow.complete} complete, ${result.controlFlow.partial} partial)`);
    console.log(`  ${'Dataflow'.padEnd(16)}${result.dataflow.total} (${result.dataflow.complete} complete, ${result.dataflow.partial} partial)`);
    console.log(`  ${'Summaries'.padEnd(16)}${result.summaries.total} (${result.summaries.complete} complete, ${result.summaries.partial} partial)`);
    console.log(`  ${'Library models'.padEnd(16)}${result.models.calls.applied ?? 0} applied; ${result.models.manifest.configured ? 'project-declared versions/assumptions' : 'no project version/assumption declaration'}`);
    for (const diagnostic of result.dataflow.diagnostics.slice(0, 10)) {
      console.log(`  [${diagnostic.code}] ${escapeTerminal(diagnostic.owner)}: ${escapeTerminal(diagnostic.message)}`);
    }
    for (const diagnostic of result.controlFlow.diagnostics.slice(0, 10)) {
      console.log(`    ${escapeTerminal(diagnostic.filePath)}:${diagnostic.span.line} [${diagnostic.code}] ${escapeTerminal(diagnostic.message)}`);
    }
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

    if (result.diagnostics.length > 0) {
      console.log(`\n  Parser diagnostics (${result.diagnostics.length}):`);
      for (const diagnostic of result.diagnostics.slice(0, 10)) {
        console.log(`    ${escapeTerminal(diagnostic.filePath)}: ${escapeTerminal(diagnostic.code)} — ${escapeTerminal(diagnostic.message)}`);
      }
    }

    const stats = store.getStats(projectId);
    console.log(`\n${c.bold}${m.registryStatus}${c.reset}`);
    console.log(`  Total: ${stats.total}  deprecated: ${stats.deprecated}  untested: ${stats.untested}  high-risk: ${stats.highRisk}  warnings: ${stats.withWarnings}\n`);

  } catch (error) {
    const report = failedBsScan(error), outcome = bsOutcome(report);
    process.exitCode = outcome.exitCode;
    if (opts.sarif) console.log(JSON.stringify(toSarif(report, process.cwd(), { outcome }), null, 2));
    else if (opts.json) console.log(JSON.stringify({ errors: report.errors, outcome }, null, 2));
    else console.error(report.errors.map(escapeTerminal).join('\n'));
  } finally { closeRegistryStore(); }
}
