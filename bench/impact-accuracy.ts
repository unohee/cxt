import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { extractFile } from '../src/registry/entityScanner.js';
import { entityQualifiedName } from '../src/frontend/types.js';
import { SqliteRegistryStore } from '../src/registry/sqliteStore.js';
import { resolveSymbols } from '../src/analysis/resolveSymbols.js';
import { analyzeSummaries } from '../src/analysis/summaries.js';
import { parameterImpact, type ParameterImpact } from '../src/analysis/parameterImpact.js';
import type { ControlFlowGraph } from '../src/analysis/cfg.js';

const languages = ['typescript', 'python', 'rust'] as const;
const schema = z.object({ id: z.string().min(1), language: z.enum(languages), source: z.string().min(1), target: z.string().min(1),
  parameter: z.string().min(1), expected: z.array(z.string().min(1)), completeness: z.enum(['complete', 'partial']),
  pathCalls: z.array(z.tuple([z.string().min(1), z.string().min(1)])) });
export type ImpactFixture = z.infer<typeof schema>;
export function loadImpactCorpus(): ImpactFixture[] {
  const fixtures = z.array(schema).min(1).parse(JSON.parse(readFileSync(new URL('./corpus/impact.json', import.meta.url), 'utf8')));
  if (new Set(fixtures.map(f => f.id)).size !== fixtures.length) throw new Error('Duplicate impact fixture IDs');
  for (const language of languages) if (!fixtures.some(f => f.language === language)) throw new Error(`Missing impact corpus language: ${language}`);
  return fixtures;
}
const pathFor = (fixture: ImpactFixture) => fixture.language === 'typescript' ? 'x.ts' : fixture.language === 'python' ? 'x.py' : 'x.rs';
export function countImpact(expected: string[], actual: string[]) {
  const labels = new Set(expected), seen = new Set<string>(); let tp = 0, fp = 0;
  for (const prediction of actual) { if (labels.has(prediction) && !seen.has(prediction)) tp++; else fp++; seen.add(prediction); }
  return { tp, fp, fn: [...labels].filter(label => !seen.has(label)).length };
}
export function scoreImpact(fixture: ImpactFixture, result: ParameterImpact, graphs: ControlFlowGraph[]) {
  const prefix = `${pathFor(fixture)}::`;
  const counts = countImpact(fixture.expected.map(name => prefix + name), result.impacted.map(item => item.owner));
  let pathsCorrect = 0;
  for (const [owner, callText] of fixture.pathCalls) {
    const item = result.impacted.find(item => item.owner === prefix + owner), last = item?.path.at(-1);
    const node = last && graphs.find(g => g.owner === last.caller)?.nodes[last.callNode];
    if (last && node?.text === callText && JSON.stringify(last.span) === JSON.stringify(node.span)) pathsCorrect++;
  }
  return { ...counts, pathsCorrect, paths: fixture.pathCalls.length, statusCorrect: result.completeness === fixture.completeness ? 1 : 0 };
}
export function evaluateImpact(fixture: ImpactFixture) {
  const file = pathFor(fixture), extracted = extractFile(fixture.source, file, fixture.language, 'ast');
  const sites = resolveSymbols([extracted.symbols!]).calls;
  const analysis = analyzeSummaries(extracted.controlFlow!, sites);
  const result = parameterImpact(analysis.graphs, analysis.flows, analysis.summaries, `${file}::${fixture.target}`, fixture.parameter);
  // 기존 실제 store의 getImpactSet 후보를 동일한 parameter-value 정답에 대조한다.
  const store = new SqliteRegistryStore(':memory:');
  let baseline: string[];
  try {
    for (const entity of extracted.entities) store.registerEntity({ projectId: 'p', kind: entity.kind, name: entity.name,
      filePath: file, qualifiedName: entityQualifiedName(entity) });
    store.replaceCallSitesForProject('p', sites);
    store.replaceRelationsForProject('p', store.getCallSiteRelations('p'));
    const target = store.findEntityByQualifiedName(`${file}::${fixture.target}`, 'p')!;
    baseline = store.getImpactSet(target.id, 5).map(item => store.getEntity(item.id)!.qualifiedName);
  } finally { store.close(); }
  return { result, graphs: analysis.graphs, baseline, measured: scoreImpact(fixture, result, analysis.graphs),
    baselineCounts: countImpact(fixture.expected.map(name => `${file}::${name}`), baseline) };
}
export function impactFixturePass(counts: ReturnType<typeof scoreImpact>): boolean {
  return counts.fp === 0 && counts.fn === 0 && counts.statusCorrect === 1 && counts.pathsCorrect === counts.paths;
}
function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const corpus = loadImpactCorpus(), started = performance.now();
  const results = languages.map(language => {
    const fixtures = corpus.filter(f => f.language === language), failures: string[] = [];
    const totals = { tp: 0, fp: 0, fn: 0 }, baseline = { tp: 0, fp: 0, fn: 0 };
    for (const fixture of fixtures) {
      try {
        const result = evaluateImpact(fixture);
        if (!impactFixturePass(result.measured)) failures.push(fixture.id);
        // partial fixture는 completeness/path 회귀로 검사하며 정밀도 분모와 분리한다.
        if (fixture.completeness === 'complete') for (const key of ['tp', 'fp', 'fn'] as const) {
          totals[key] += result.measured[key]; baseline[key] += result.baselineCounts[key];
        }
      } catch (error) { failures.push(`${fixture.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const precision = totals.tp / (totals.tp + totals.fp || 1), recall = totals.tp / (totals.tp + totals.fn || 1);
    const baselinePrecision = baseline.tp / (baseline.tp + baseline.fp || 1);
    const precisionGain = precision - baselinePrecision;
    return { language, fixtures: fixtures.length, precisionFixtures: fixtures.filter(f => f.completeness === 'complete').length,
      ...totals, precision, recall, baseline, baselinePrecision, precisionGain, failures,
      pass: failures.length === 0 && precision === 1 && recall === 1 && precisionGain >= 0.15 };
  });
  const report = { schemaVersion: 1, factFamily: 'parameter-value-impact', tier: 'synthetic-development',
    corpusSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'), generatedAt: new Date().toISOString(),
    durationMs: performance.now() - started, processMaxRssKiB: process.resourceUsage().maxRSS, pass: results.every(r => r.pass), results };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, json);
  console.log(json); if (!report.pass) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
