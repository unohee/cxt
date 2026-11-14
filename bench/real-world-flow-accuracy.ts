import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { extractFile } from '../src/registry/entityScanner.js';
import { analyzeDataflow } from '../src/analysis/dataflow.js';
import { flowGate, scoreFlow } from './dataflow-accuracy.js';
import type { ControlFlowGraph } from '../src/analysis/cfg.js';
import type { DataflowResult } from '../src/analysis/dataflow.js';

const root = new URL('./corpus/real-world/', import.meta.url);
const language = z.enum(['typescript', 'python', 'rust']);
const read = z.tuple([z.number().int().positive(), z.number().int().positive(), z.string().min(1), z.array(z.number().int().positive()), z.boolean()]);
const fixtureSchema = z.object({ id: z.string().min(1), language, file: z.string().regex(/^[A-Za-z0-9_.-]+$/), owner: z.string().min(1), parameters: z.array(z.string()), atoms: z.array(z.string()).optional(), reads: z.array(read), completeness: z.enum(['complete', 'partial']) }).strict();
const corpusSchema = z.object({ schemaVersion: z.literal(1), selection: z.string().min(1), fixtures: z.array(fixtureSchema).min(1) }).strict();

function loadCorpus() {
  const bytes = readFileSync(new URL('./corpus/real-world-flow-labels.json', import.meta.url));
  const corpus = corpusSchema.parse(JSON.parse(bytes.toString()));
  const provenance = z.object({ sources: z.array(z.object({ language, path: z.string(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) })) }).parse(JSON.parse(readFileSync(new URL('provenance.json', root), 'utf8')));
  if (new Set(corpus.fixtures.map(f => f.id)).size !== corpus.fixtures.length) throw new Error('Duplicate real-world flow fixture IDs');
  for (const lang of language.options) if (!corpus.fixtures.some(f => f.language === lang)) throw new Error(`Missing real-world flow language: ${lang}`);
  for (const fixture of corpus.fixtures) {
    const source = readFileSync(new URL(fixture.file, root));
    const origin = provenance.sources.find(candidate => candidate.path === fixture.file && candidate.language === fixture.language);
    if (!origin || createHash('sha256').update(source).digest('hex') !== origin.sourceSha256) throw new Error(`Source provenance mismatch: ${fixture.id}`);
  }
  return { corpus, labelsSha256: createHash('sha256').update(bytes).digest('hex') };
}

function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const { corpus, labelsSha256 } = loadCorpus();
  const started = performance.now();
  const results = corpus.fixtures.map(fixture => {
    let graph: ControlFlowGraph | undefined;
    let result: DataflowResult | undefined;
    let error: string | undefined;
    try {
      const extracted = extractFile(readFileSync(new URL(fixture.file, root), 'utf8'), fixture.file, fixture.language, 'ast');
      graph = extracted.controlFlow?.find(candidate => candidate.owner === fixture.owner);
      if (!graph) throw new Error(`Missing control-flow owner: ${fixture.owner}`);
      result = analyzeDataflow(graph);
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    const measured = scoreFlow({ ...fixture, source: '' }, graph, result);
    return { id: fixture.id, language: fixture.language, file: fixture.file, owner: fixture.owner, labels: fixture.reads.length, measured, error, pass: !error && flowGate(measured, 1) };
  });
  const report = { schemaVersion: 1, tier: 'real-world', factFamily: 'intraprocedural-dataflow', engine: 'ast', scopePolicy: 'only the selected function owner is scored', labelsSha256, generatedAt: new Date().toISOString(), node: process.version, durationMs: performance.now() - started, processMaxRssKiB: process.resourceUsage().maxRSS, pass: results.every(r => r.pass), results };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, json);
  console.log(json);
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
