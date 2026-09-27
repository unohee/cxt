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
const fixtureSchema = z.object({ id: z.string().min(1), language: z.enum(languages), source: z.string().min(1),
  parameters: z.array(z.string()), atoms: z.array(z.string()).optional(), completeness: z.enum(['complete', 'partial']),
  reads: z.array(z.tuple([z.number().int().positive(), z.number().int().positive(), z.string().min(1), z.array(z.number().int().positive()), z.boolean()])) });
export type FlowFixture = z.infer<typeof fixtureSchema>;
export function loadFlowCorpus(): FlowFixture[] {
  const fixtures = z.array(fixtureSchema).min(1).parse(JSON.parse(readFileSync(new URL('./corpus/dataflow.json', import.meta.url), 'utf8')));
  if (new Set(fixtures.map(f => f.id)).size !== fixtures.length) throw new Error('Duplicate dataflow fixture IDs');
  for (const language of languages) if (!fixtures.some(f => f.language === language)) throw new Error(`Missing dataflow corpus language: ${language}`);
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
  return { tp, fp: [...predicted].filter(p => !labels.has(p)).length, fn: [...labels].filter(p => !predicted.has(p)).length,
    statusCorrect: result?.completeness === fixture.completeness ? 1 : 0,
    readStatusCorrect, reads: fixture.reads.length,
    valueCorrect: fixture.atoms === undefined || (result && JSON.stringify(sorted(result.returns.flatMap(r => r.value.atoms))) === JSON.stringify(sorted(fixture.atoms))) ? 1 : 0 };
}
export function flowGate(counts: ReturnType<typeof scoreFlow>, fixtures: number): boolean {
  return fixtures > 0 && counts.fp === 0 && counts.fn === 0 && counts.statusCorrect === fixtures
    && counts.readStatusCorrect === counts.reads && counts.valueCorrect === fixtures;
}
export function evaluateFlowFixture(fixture: FlowFixture) {
  const path = fixture.language === 'typescript' ? 'x.ts' : fixture.language === 'python' ? 'x.py' : 'x.rs';
  const graph = extractFile(fixture.source, path, fixture.language, 'ast').controlFlow?.find(g => g.owner === `${path}::f`);
  return { graph, result: graph && analyzeDataflow(graph) };
}
function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const corpus = loadFlowCorpus(); const started = performance.now();
  const results = languages.map(language => {
    const fixtures = corpus.filter(f => f.language === language);
    const counts = { tp: 0, fp: 0, fn: 0, statusCorrect: 0, readStatusCorrect: 0, reads: 0, valueCorrect: 0 };
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
  const report = { schemaVersion: 1, factFamily: 'intraprocedural-dataflow', tier: 'synthetic-development',
    corpusSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'), generatedAt: new Date().toISOString(),
    node: process.version, durationMs: performance.now() - started, processMaxRssKiB: process.resourceUsage().maxRSS,
    pass: results.every(r => r.pass), results };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, json);
  console.log(json); if (!report.pass) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
