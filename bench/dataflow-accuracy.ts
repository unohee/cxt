import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { extractFile } from '../src/registry/entityScanner.js';
import type { ControlFlowGraph } from '../src/analysis/cfg.js';
import { analyzeDataflow, type DataflowResult } from '../src/analysis/dataflow.js';

const languages = ['typescript', 'python', 'rust'] as const;
export type FlowTier = 'synthetic-development' | 'held-out-review';
export interface FlowCorpusOptions { requireIndependentReview?: boolean }
export interface HeldOutReviewer { id?: string; role?: string; fixtureIds?: string[]; labelsSha256?: string }
export interface HeldOutProvenance { schemaVersion?: number; tier?: string; reviewStatus?: string; labelsSha256?: string;
  fixtures?: Array<{ id: string; language: string }>; reviewers?: HeldOutReviewer[] }
export function validateHeldOutStatus(provenance: HeldOutProvenance, requireIndependentReview: boolean): void {
  const pending = provenance.reviewStatus?.includes('pending') ?? false;
  if (provenance.schemaVersion !== 1 || provenance.tier !== 'held-out-review'
    || requireIndependentReview === pending) {
    throw new Error(requireIndependentReview
      ? 'Independent second-reviewer sign-off is required for this gate'
      : 'Held-out provenance is incomplete');
  }
}
export function validateIndependentReview(provenance: HeldOutProvenance, labels: Map<string, string>, labelsDigest: string): void {
  const reviewers = provenance.reviewers ?? [];
  const ids = new Set(reviewers.map(reviewer => reviewer.id).filter((id): id is string => !!id));
  const primary = reviewers.filter(reviewer => reviewer.role === 'primary');
  const secondary = reviewers.filter(reviewer => reviewer.role === 'secondary');
  const covers = reviewers.every(reviewer => {
    const fixtureIds = new Set(reviewer.fixtureIds ?? []);
    return fixtureIds.size === labels.size && fixtureIds.size === (reviewer.fixtureIds ?? []).length
      && [...fixtureIds].every(id => labels.has(id)) && reviewer.labelsSha256 === labelsDigest;
  });
  if (ids.size < 2 || primary.length !== 1 || secondary.length !== 1 || primary[0].id === secondary[0].id
    || !covers || provenance.reviewStatus?.includes('pending')) {
    throw new Error('Independent second-reviewer sign-off is required for this gate');
  }
}
const fixtureSchema = z.object({ id: z.string().min(1), language: z.enum(languages), source: z.string().min(1),
  parameters: z.array(z.string()), atoms: z.array(z.string()).optional(), completeness: z.enum(['complete', 'partial']),
  reads: z.array(z.tuple([z.number().int().positive(), z.number().int().positive(), z.string().min(1), z.array(z.number().int().positive()), z.boolean()])),
  ownership: z.array(z.tuple([z.number().int().positive(), z.number().int().positive(), z.string().min(1), z.literal('use-after-move'), z.enum(['definite', 'possible'])])).optional() });
export type FlowFixture = z.infer<typeof fixtureSchema>;
export function loadFlowCorpus(tier: FlowTier = 'synthetic-development', options: FlowCorpusOptions = {}): FlowFixture[] {
  const source = tier === 'held-out-review' ? './corpus/held-out/dataflow.json' : './corpus/dataflow.json';
  const sourceBytes = readFileSync(new URL(source, import.meta.url));
  const fixtures = z.array(fixtureSchema).min(1).parse(JSON.parse(sourceBytes.toString('utf8')));
  if (new Set(fixtures.map(f => f.id)).size !== fixtures.length) throw new Error('Duplicate dataflow fixture IDs');
  for (const language of languages) if (!fixtures.some(f => f.language === language)) throw new Error(`Missing dataflow corpus language: ${language}`);
  if (tier === 'held-out-review') {
    const provenance = JSON.parse(readFileSync(new URL('./corpus/held-out/provenance.json', import.meta.url), 'utf8')) as HeldOutProvenance;
    validateHeldOutStatus(provenance, options.requireIndependentReview ?? false);
    const labelsDigest = createHash('sha256').update(sourceBytes).digest('hex');
    if (!/^[a-f0-9]{64}$/i.test(provenance.labelsSha256 ?? '') || labelsDigest !== provenance.labelsSha256)
      throw new Error('Held-out label bytes do not match provenance');
    const labels = new Map((provenance.fixtures ?? []).map(fixture => [fixture.id, fixture.language]));
    if (labels.size !== fixtures.length || fixtures.some(fixture => labels.get(fixture.id) !== fixture.language)) throw new Error('Held-out provenance does not cover the corpus');
    if (options.requireIndependentReview) validateIndependentReview(provenance, labels, labelsDigest);
    const synthetic = loadFlowCorpus('synthetic-development');
    if (fixtures.some(fixture => synthetic.some(other => other.id === fixture.id || other.source === fixture.source))) throw new Error('Held-out corpus overlaps synthetic corpus');
  }
  return fixtures;
}
const sorted = (items: string[]) => [...new Set(items)].sort();
export function scoreFlow(fixture: FlowFixture, graph?: ControlFlowGraph, result?: DataflowResult) {
  const expected = fixture.parameters.map(p => `return-parameter:${p}`);
  const actual = sorted(result?.returns.flatMap(r => r.value.parameters.map(p => `return-parameter:${p.slice(p.lastIndexOf(':') + 1)}`)) ?? []);
  let readStatusCorrect = 0;
  for (const [line, column, name, definitions, uninitialized] of fixture.reads) {
    const prefix = `${line}:${column}:${name}`;
    expected.push(...definitions.map(definition => `${prefix}<-${definition}`));
    const uses = result?.uses.filter(use => graph?.nodes[use.node].span.line === line && graph.nodes[use.node].span.column === column && use.variable.endsWith(`:${name}`)) ?? [];
    for (const use of uses) for (const id of use.definitions) {
      const definition = result!.definitions.find(d => d.id === id);
      actual.push(`${prefix}<-${definition ? graph!.nodes[definition.node].span.line : 'missing-definition'}`);
    }
    if (uses.length === 1 && uses[0].mayBeUninitialized === uninitialized) readStatusCorrect++;
  }
  const labels = new Set(expected), predicted = new Set(actual);
  const tp = [...predicted].filter(p => labels.has(p)).length;
  const expectedOwnership = (fixture.ownership ?? []).map(([line, column, name, kind, certainty]) => `${line}:${column}:${name}:${kind}:${certainty}`);
  const actualOwnership = (result?.ownershipFindings ?? []).map(finding => {
    const node = graph?.nodes[finding.node];
    return `${node?.span.line}:${node?.span.column}:${finding.variable.slice(finding.variable.lastIndexOf(':') + 1)}:${finding.kind}:${finding.certainty}`;
  });
  const ownershipCorrect = JSON.stringify(sorted(actualOwnership)) === JSON.stringify(sorted(expectedOwnership)) ? 1 : 0;
  return { tp, fp: [...predicted].filter(p => !labels.has(p)).length, fn: [...labels].filter(p => !predicted.has(p)).length,
    statusCorrect: result?.completeness === fixture.completeness ? 1 : 0,
    readStatusCorrect, reads: fixture.reads.length, ownershipCorrect,
    valueCorrect: fixture.atoms === undefined || (result && JSON.stringify(sorted(result.returns.flatMap(r => r.value.atoms))) === JSON.stringify(sorted(fixture.atoms))) ? 1 : 0 };
}
export function flowGate(counts: ReturnType<typeof scoreFlow>, fixtures: number): boolean {
  return fixtures > 0 && counts.fp === 0 && counts.fn === 0 && counts.statusCorrect === fixtures
    && counts.readStatusCorrect === counts.reads && counts.ownershipCorrect === fixtures && counts.valueCorrect === fixtures;
}
export function evaluateFlowFixture(fixture: FlowFixture) {
  const path = fixture.language === 'typescript' ? 'x.ts' : fixture.language === 'python' ? 'x.py' : 'x.rs';
  const graph = extractFile(fixture.source, path, fixture.language, 'ast').controlFlow?.find(g => g.owner === `${path}::f`);
  return { graph, result: graph && analyzeDataflow(graph) };
}
export function runFlowCorpus(corpus: FlowFixture[], tier: FlowTier) {
  const started = performance.now();
  const results = languages.map(language => {
    const fixtures = corpus.filter(f => f.language === language);
    const counts = { tp: 0, fp: 0, fn: 0, statusCorrect: 0, readStatusCorrect: 0, reads: 0, ownershipCorrect: 0, valueCorrect: 0 };
    const failures: Array<{ id: string; error?: string; measured?: typeof counts }> = [];
    for (const fixture of fixtures) {
      let graph: ControlFlowGraph | undefined, result: DataflowResult | undefined;
      try { ({ graph, result } = evaluateFlowFixture(fixture)); }
      catch (error) { failures.push({ id: fixture.id, error: error instanceof Error ? error.message : String(error) }); }
      const measured = scoreFlow(fixture, graph, result);
      for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += measured[key];
      if (!flowGate(measured, 1)) failures.push({ id: fixture.id, measured });
    }
    return { language, fixtures: fixtures.length, ...counts, precision: counts.tp / (counts.tp + counts.fp || 1), recall: counts.tp / (counts.tp + counts.fn || 1),
      failures, pass: !failures.some(f => f.error) && flowGate(counts, fixtures.length) };
  });
  return { schemaVersion: 1, factFamily: 'intraprocedural-dataflow', tier,
    corpusSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'), generatedAt: new Date().toISOString(),
    node: process.version, durationMs: performance.now() - started, processMaxRssKiB: process.resourceUsage().maxRSS,
    pass: results.every(r => r.pass), results };
}
function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, tier: { type: 'string', default: 'synthetic-development' }, 'require-independent-review': { type: 'boolean', default: false } } });
  if (values.tier !== 'synthetic-development' && values.tier !== 'held-out-review') throw new Error(`Unknown flow tier: ${values.tier}`);
  const corpus = loadFlowCorpus(values.tier, { requireIndependentReview: values['require-independent-review'] }); const report = runFlowCorpus(corpus, values.tier);
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, json);
  console.log(json); if (!report.pass) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
