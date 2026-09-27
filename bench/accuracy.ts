import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { extractFile } from '../src/registry/entityScanner.js';
import type { ExtractedEntity } from '../src/registry/entityScanner.js';

const kind = z.enum(['function', 'class', 'module', 'type', 'constant']);
const language = z.enum(['typescript', 'python', 'rust']);
const label = z.tuple([kind, z.string().min(1), z.number().int().positive(), z.number().int().positive(), z.string().optional()]);
const fixtureSchema = z.object({
  id: z.string().min(1), language, filePath: z.string().min(1), source: z.string(),
  expected: z.array(label),
});
export type Fixture = z.infer<typeof fixtureSchema>;

export function loadCorpus(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const lang of language.options) {
    const raw = JSON.parse(readFileSync(new URL(`./corpus/${lang}.json`, import.meta.url), 'utf8')) as Array<Record<string, unknown>>;
    // JSON omits an optional trailing tuple member; normalize it without inferring any label.
    const normalized = raw.map(f => ({ ...f, expected: (f.expected as unknown[][]).map(e => e.length === 4 ? [...e, undefined] : e) }));
    const parsed = z.array(fixtureSchema).min(1).parse(normalized);
    for (const fixture of parsed) {
      if (fixture.language !== lang) throw new Error(`Wrong corpus language: ${fixture.id}`);
      const lines = fixture.source.split('\n').length;
      for (const [, , start, end] of fixture.expected) {
        if (end < start || end > lines) throw new Error(`Invalid labeled span: ${fixture.id}`);
      }
    }
    fixtures.push(...parsed);
  }
  if (new Set(fixtures.map(f => f.id)).size !== fixtures.length) throw new Error('Duplicate fixture IDs');
  return fixtures;
}

export function countMatches(expected: Fixture['expected'], actual: ExtractedEntity[]) {
  const remaining = [...expected];
  let tp = 0, fp = 0, spanCorrect = 0, scopeCorrect = 0;
  for (const entity of actual) {
    const index = remaining.findIndex(([kind, name, line]) => kind === entity.kind && name === entity.name && line === entity.lineStart);
    if (index < 0) { fp++; continue; }
    const match = remaining.splice(index, 1)[0];
    tp++;
    if (match[3] === entity.lineEnd) spanCorrect++;
    if ((match[4] ?? match[1]) === (entity.scopedName ?? entity.name)) scopeCorrect++;
  }
  return { tp, fp, fn: remaining.length, spanCorrect, scopeCorrect };
}

export function metrics(counts: ReturnType<typeof countMatches>) {
  const precision = counts.tp + counts.fp ? counts.tp / (counts.tp + counts.fp) : 1;
  const recall = counts.tp + counts.fn ? counts.tp / (counts.tp + counts.fn) : 1;
  return { ...counts, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    spanAccuracy: counts.tp ? counts.spanCorrect / counts.tp : counts.fn ? 0 : 1,
    scopeAccuracy: counts.tp ? counts.scopeCorrect / counts.tp : counts.fn ? 0 : 1 };
}

const gateSchema = z.object({
  precision: z.number().min(0).max(1), recall: z.number().min(0).max(1),
  spanAccuracy: z.number().min(0).max(1), scopeAccuracy: z.number().min(0).max(1),
});
export function checkGate(measured: ReturnType<typeof metrics>, gate: z.infer<typeof gateSchema>): boolean {
  return Object.entries(gateSchema.parse(gate)).every(([metric, minimum]) =>
    Number.isFinite(measured[metric as keyof typeof measured]) && measured[metric as keyof typeof measured] >= minimum);
}

function main() {
  const { values } = parseArgs({ options: { engine: { type: 'string', default: 'ast' },
    'no-gate': { type: 'boolean', default: false }, output: { type: 'string' } } });
  const engine = z.enum(['ast', 'lexical']).parse(values.engine);
  const corpus = loadCorpus();
  const gates = z.object({ typescript: gateSchema, python: gateSchema, rust: gateSchema }).parse(
    JSON.parse(readFileSync(new URL('./gates.json', import.meta.url), 'utf8')));
  const started = performance.now();
  const results = language.options.map(lang => {
    const fixtures = corpus.filter(f => f.language === lang);
    const counts = { tp: 0, fp: 0, fn: 0, spanCorrect: 0, scopeCorrect: 0 };
    const failures: Array<{ id: string; error?: string; counts?: typeof counts }> = [];
    for (const fixture of fixtures) {
      let actual: ExtractedEntity[];
      try { actual = extractFile(fixture.source, fixture.filePath, fixture.language, engine).entities; }
      catch (error) {
        actual = [];
        failures.push({ id: fixture.id, error: error instanceof Error ? error.message : String(error) });
      }
      const measured = countMatches(fixture.expected, actual);
      for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += measured[key];
      if (measured.fp || measured.fn || measured.spanCorrect !== measured.tp || measured.scopeCorrect !== measured.tp) {
        failures.push({ id: fixture.id, counts: measured });
      }
    }
    const measured = metrics(counts);
    return { language: lang, fixtures: fixtures.length, ...measured, failures,
      pass: !failures.some(f => f.error) && checkGate(measured, gates[lang]) };
  });
  const report = { schemaVersion: 1, engine, factFamily: 'entities', tier: 'synthetic',
    corpusSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
    generatedAt: new Date().toISOString(), node: process.version,
    durationMs: performance.now() - started, processMaxRssKiB: process.resourceUsage().maxRSS,
    pass: results.every(r => r.pass), gateEnforced: !values['no-gate'], results };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, json);
  console.log(json);
  if (!values['no-gate'] && !report.pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
