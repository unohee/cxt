import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const engineRoot = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);
const budgets = { scanMs: 60_000, warmMs: 15_000, scanMaxRssKiB: 1_048_576 };

if (process.argv[2] === '--worker') {
  const [, , , root, database, output] = process.argv;
  const { scanRepository } = await import('../dist/registry/entityScanner.js');
  const { getRegistryStore, closeRegistryStore } = await import('../dist/registry/sqliteStore.js');
  getRegistryStore(database);
  const loadBefore = loadavg(), cpuBefore = process.cpuUsage();
  const scan = await scanRepository(root, 'incremental-benchmark');
  const cpuUsage = process.cpuUsage(cpuBefore), loadAfter = loadavg();
  const scanMaxRssKiB = process.resourceUsage().maxRSS;
  closeRegistryStore();
  const db = new Database(database, { readonly: true });
  const hash = createHash('sha256');
  // UUID/time/cache bytes는 성능 최적화의 의미적 결과가 아니다. Facts는 모두 비교한다.
  for (const table of ['code_entities', 'code_call_sites', 'code_control_flow', 'code_dataflow', 'code_function_summaries', 'code_model_manifests', 'code_entity_relations']) {
    let sql;
    if (table === 'code_entities') sql = `SELECT project_id, qualified_name, kind, name, file_path, line_start, line_end, signature, status, has_tests, test_file, complexity_score, risk_level, is_exported, loc, nesting_depth, param_count FROM ${table} ORDER BY qualified_name`;
    else if (table === 'code_call_sites') sql = `SELECT c.file_path, c.line, c.column_number, c.end_line, c.end_column, c.source_offset, c.scope_id, c.expression, c.callee_json, c.resolution, c.reason, c.confidence, c.external_json, s.qualified_name AS caller, t.qualified_name AS target FROM ${table} c LEFT JOIN code_entities s ON s.id=c.caller_id LEFT JOIN code_entities t ON t.id=c.target_id ORDER BY c.file_path,c.line,c.column_number,c.end_line,c.end_column`;
    else if (table === 'code_entity_relations') sql = `SELECT s.qualified_name AS source,t.qualified_name AS target,r.relation_type FROM ${table} r JOIN code_entities s ON s.id=r.source_id JOIN code_entities t ON t.id=r.target_id ORDER BY source,target,r.relation_type`;
    else if (table === 'code_model_manifests') sql = `SELECT * FROM ${table} ORDER BY project_id`;
    else sql = `SELECT e.qualified_name AS owner, f.completeness, f.${table === 'code_control_flow' ? 'graph_json' : table === 'code_dataflow' ? 'result_json' : 'summary_json'} AS facts FROM ${table} f JOIN code_entities e ON e.id=f.owner_id ORDER BY owner`;
    hash.update(table);
    for (const row of db.prepare(sql).iterate()) hash.update(JSON.stringify(row)).update('\n');
  }
  db.close();
  const result = { scan, scanMaxRssKiB, cpuUsage, loadBefore, loadAfter, workerMaxRssKiB: process.resourceUsage().maxRSS, databaseBytes: statSync(database).size, factHash: hash.digest('hex') };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  process.exitCode = scan.errors.length || !scan.cache.committed ? 1 : 0;
} else {
  const source = resolve(process.argv[2] ?? engineRoot), count = Number(process.argv[3] ?? 5);
  assert.ok(Number.isInteger(count) && count >= 3 && count <= 10, 'samples must be 3..10');
  assert.ok(existsSync(join(engineRoot, 'dist/registry/entityScanner.js')), 'Run npm run build first');
  const artifacts = mkdtempSync(join(tmpdir(), 'cxt-incremental-bench-')), snapshot = join(artifacts, 'source');
  mkdirSync(snapshot);
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const sourceHash = createHash('sha256');
  for (const path of paths) {
    const input = join(source, path);
    if (!existsSync(input)) continue;
    assert.ok(lstatSync(input).isFile(), `Snapshot requires regular files: ${path}`);
    const bytes = readFileSync(input); sourceHash.update(path).update('\0').update(bytes).update('\0');
    mkdirSync(dirname(join(snapshot, path)), { recursive: true }); copyFileSync(input, join(snapshot, path));
  }
  const report = { timestamp: new Date().toISOString(), source, sourceHash: sourceHash.digest('hex'), artifacts, samplesPerMode: count, budgets,
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, cpuCount: cpus().length, memoryBytes: totalmem(), load: loadavg() }, samples: [] };
  writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(report, null, 2));
  console.log(`Frozen input and measurements: ${artifacts}`);
  let expected;
  for (let i = 0; i < count; i++) {
    const database = join(artifacts, `facts-${i}.db`);
    for (const mode of ['cold', 'warm']) {
      const output = join(artifacts, `${mode}-${i}.json`);
      const child = spawnSync(process.execPath, [script, '--worker', snapshot, database, output], { encoding: 'utf8', timeout: 75_000 });
      if (child.status !== 0) {
        report.pass = false;
        report.failure = { mode, sample: i, status: child.status, stderr: child.stderr, error: String(child.error ?? ''), output,
          scan: existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')).scan : null };
        writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      }
      assert.equal(child.status, 0, `${mode}/${i}: ${child.stderr} ${child.error ?? ''}; inspect ${output}`);
      const result = JSON.parse(readFileSync(output, 'utf8'));
      expected ??= { engine: result.scan.cache.engine, factHash: result.factHash };
      assert.equal(result.scan.cache.engine, expected.engine, 'Engine changed during benchmark');
      assert.equal(result.factHash, expected.factHash, 'Cold/warm semantic snapshot differs');
      assert.equal(result.scan.cache.frontendMisses, mode === 'warm' ? 0 : result.scan.scanned);
      if (mode === 'warm') assert.equal(result.scan.cache.summaryMisses, 0);
      report.samples.push({ mode, sample: i, durationMs: result.scan.durationMs, scanMaxRssKiB: result.scanMaxRssKiB,
        cpuUsage: result.cpuUsage, loadBefore: result.loadBefore, loadAfter: result.loadAfter,
        databaseBytes: result.databaseBytes, factHash: result.factHash, cache: result.scan.cache,
        scanned: result.scan.scanned, extracted: result.scan.extracted, dataflow: { complete: result.scan.dataflow.complete, partial: result.scan.dataflow.partial }, summaries: result.scan.summaries });
      writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(`${mode}/${i}: ${result.scan.durationMs}ms, RSS ${result.scanMaxRssKiB}KiB, equal facts`);
    }
  }
  const percentile = (items, fraction) => [...items].sort((a, b) => a - b)[Math.ceil(items.length * fraction) - 1];
  report.statistics = Object.fromEntries(['cold', 'warm'].map(mode => {
    const samples = report.samples.filter(sample => sample.mode === mode);
    return [mode, { p50Ms: percentile(samples.map(sample => sample.durationMs), 0.5), p95Ms: percentile(samples.map(sample => sample.durationMs), 0.95), maxRssKiB: Math.max(...samples.map(sample => sample.scanMaxRssKiB)) }];
  }));
  report.pass = report.samples.every(sample => sample.durationMs <= (sample.mode === 'warm' ? budgets.warmMs : budgets.scanMs) && sample.scanMaxRssKiB <= budgets.scanMaxRssKiB);
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ statistics: report.statistics, pass: report.pass }, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
