import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { extractFile } from '../src/registry/entityScanner.js';
import { resolveSymbols } from '../src/analysis/resolveSymbols.js';
import type { ResolvedCallSite } from '../src/analysis/symbols.js';

const languages = ['typescript', 'python', 'rust'] as const;
const position = z.number().int().positive();
const labelSchema = z.tuple([z.string().min(1), position, position, z.string().min(1).nullable(),
  z.enum(['resolved', 'unresolved', 'external']).optional(), position.optional(), position.optional()]);
const fixtureSchema = z.object({ id: z.string().min(1), language: z.enum(languages),
  files: z.record(z.string().min(1), z.string()), expected: z.array(labelSchema) });
export type CallFixture = z.infer<typeof fixtureSchema>;

export function loadCallCorpus(): CallFixture[] {
  const raw = z.array(z.object({ expected: z.array(z.array(z.unknown())) }).passthrough()).parse(
    JSON.parse(readFileSync(new URL('./corpus/calls.json', import.meta.url), 'utf8')));
  const fixtures = z.array(fixtureSchema).min(1).parse(raw.map(f => ({ ...f,
    expected: f.expected.map(label => [...label, ...Array(Math.max(0, 7 - label.length)).fill(undefined)]) })));
  if (new Set(fixtures.map(f => f.id)).size !== fixtures.length) throw new Error('Duplicate call fixture IDs');
  for (const language of languages) if (!fixtures.some(f => f.language === language)) throw new Error(`Missing call corpus language: ${language}`);
  for (const fixture of fixtures) {
    if (!Object.keys(fixture.files).length) throw new Error(`Empty source files: ${fixture.id}`);
    const keys = new Set<string>();
    for (const [file, line, column, target, resolution, endLine, endColumn] of fixture.expected) {
      const lines = fixture.files[file]?.split('\n');
      if (!lines || !lines[line - 1] || column > lines[line - 1].length
        || (endLine === undefined) !== (endColumn === undefined)
        || (endLine !== undefined && (endLine < line || !lines[endLine - 1] || endColumn! > lines[endLine - 1].length + 1))) {
        throw new Error(`Invalid labeled call span: ${fixture.id}:${file}:${line}:${column}`);
      }
      if (resolution && (resolution === 'resolved') !== (target !== null)) throw new Error(`Inconsistent resolution: ${fixture.id}`);
      const key = JSON.stringify([file, line, column, endLine, endColumn]);
      if (keys.has(key)) throw new Error(`Duplicate call label: ${fixture.id}:${key}`);
      keys.add(key);
    }
  }
  return fixtures;
}

export function countCallMatches(expected: CallFixture['expected'], actual: ResolvedCallSite[]) {
  const remaining = [...expected];
  let tp = 0, fp = 0, fn = 0, sitesMatched = 0, extraSites = 0, resolutionCorrect = 0;
  for (const site of actual) {
    const index = remaining.findIndex(([file, line, column, , , endLine, endColumn]) => file === site.filePath
      && line === site.line && column === site.column && (endLine === undefined || (endLine === site.endLine && endColumn === site.endColumn)));
    if (index < 0) { extraSites++; if (site.target) fp++; continue; }
    const label = remaining.splice(index, 1)[0];
    sitesMatched++;
    const correct = label[3] === (site.target ?? null);
    if (site.target) { if (correct) tp++; else fp++; }
    if (label[3] && !correct) fn++;
    if (correct && site.resolution === (label[4] ?? (label[3] ? 'resolved' : 'unresolved'))) resolutionCorrect++;
  }
  fn += remaining.filter(label => label[3] !== null).length;
  return { tp, fp, fn, sitesMatched, extraSites, missingSites: remaining.length, resolutionCorrect };
}

export function callMetrics(counts: ReturnType<typeof countCallMatches>) {
  const precision = counts.tp + counts.fp ? counts.tp / (counts.tp + counts.fp) : 1;
  const recall = counts.tp + counts.fn ? counts.tp / (counts.tp + counts.fn) : 1;
  const total = counts.sitesMatched + counts.extraSites + counts.missingSites;
  return { ...counts, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    siteAccuracy: total ? counts.sitesMatched / total : 1,
    resolutionAccuracy: total ? counts.resolutionCorrect / total : 1 };
}
const gateSchema = z.object({ precision: z.number().min(0).max(1), recall: z.number().min(0).max(1),
  siteAccuracy: z.number().min(0).max(1), resolutionAccuracy: z.number().min(0).max(1) });
export function checkCallGate(measured: ReturnType<typeof callMetrics>, gate: z.infer<typeof gateSchema>): boolean {
  return Object.entries(gateSchema.parse(gate)).every(([metric, minimum]) =>
    Number.isFinite(measured[metric as keyof typeof measured]) && measured[metric as keyof typeof measured] >= minimum);
}

function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'no-gate': { type: 'boolean', default: false } } });
  const corpus = loadCallCorpus();
  const gates = z.object({ typescript: gateSchema, python: gateSchema, rust: gateSchema }).parse(
    JSON.parse(readFileSync(new URL('./call-gates.json', import.meta.url), 'utf8')));
  const started = performance.now();
  const results = languages.map(language => {
    const fixtures = corpus.filter(f => f.language === language);
    const counts = { tp: 0, fp: 0, fn: 0, sitesMatched: 0, extraSites: 0, missingSites: 0, resolutionCorrect: 0 };
    const failures: Array<{ id: string; error?: string; counts?: typeof counts }> = [];
    for (const fixture of fixtures) {
      let actual: ResolvedCallSite[] = [];
      try {
        const facts = Object.entries(fixture.files).map(([file, source]) => extractFile(source, file, language, 'ast').symbols!);
        actual = resolveSymbols(facts).calls;
      } catch (error) { failures.push({ id: fixture.id, error: error instanceof Error ? error.message : String(error) }); }
      const measured = countCallMatches(fixture.expected, actual);
      for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += measured[key];
      if (measured.fp || measured.fn || measured.extraSites || measured.missingSites || measured.resolutionCorrect !== measured.sitesMatched) {
        failures.push({ id: fixture.id, counts: measured });
      }
    }
    const measured = callMetrics(counts);
    return { language, fixtures: fixtures.length, ...measured, failures,
      pass: !failures.some(f => f.error) && checkCallGate(measured, gates[language]) };
  });
  const report = { schemaVersion: 1, factFamily: 'call-sites', engine: 'ast', tier: 'synthetic-development',
    corpusSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'), generatedAt: new Date().toISOString(),
    node: process.version, durationMs: performance.now() - started, processMaxRssKiB: process.resourceUsage().maxRSS,
    pass: results.every(r => r.pass), gateEnforced: !values['no-gate'], results };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, json);
  console.log(json);
  if (!values['no-gate'] && !report.pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
