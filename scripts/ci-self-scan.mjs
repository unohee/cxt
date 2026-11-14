import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeRegistryStore, getRegistryStore, scanRepository, scanOutcome } from '../dist/index.js';

const repoPath = resolve('.');
const tempPath = mkdtempSync(join(tmpdir(), 'cxt-ci-'));
const projectPath = join(tempPath, 'project');
const sourceRelativePath = 'src/analysis/report.ts';
mkdirSync(join(projectPath, 'src/analysis'), { recursive: true });
copyFileSync(join(repoPath, sourceRelativePath), join(projectPath, sourceRelativePath));
const dbPath = join(tempPath, 'registry.db');
const projectId = 'cxt-ci-self-scan';

try {
  getRegistryStore(dbPath);
  const result = await scanRepository(projectPath, projectId);
  const outcome = scanOutcome(result);
  const factViews = {};
  for (const view of ['flows', 'summaries', 'taints']) {
    const rows = getRegistryStore(dbPath).queryFacts(projectId, { view });
    factViews[view] = { rows: rows.length, readable: true };
  }
  const report = {
    source: sourceRelativePath,
    scanned: result.scanned,
    registered: result.registered,
    errors: result.errors,
    snapshotCommitted: result.cache.committed,
    outcome: outcome.status,
    exitCode: outcome.exitCode,
    factViews,
    flow: {
      total: result.dataflow.total,
      complete: result.dataflow.complete,
      partial: result.dataflow.partial,
    },
    summaries: result.summaries,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (result.errors.length > 0 || !result.cache.committed || result.scanned === 0 || outcome.status === 'failed'
    || Object.values(factViews).some(view => !view.readable)) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`self-scan failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  closeRegistryStore();
}
