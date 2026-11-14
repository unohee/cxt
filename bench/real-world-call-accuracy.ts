import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { extractFile } from '../src/registry/entityScanner.js';
import { resolveSymbols } from '../src/analysis/resolveSymbols.js';
import { countCallMatches, callMetrics, checkCallGate } from './call-accuracy.js';
import type { ResolvedCallSite } from '../src/analysis/symbols.js';

const root = new URL('./corpus/real-world/', import.meta.url);
const languages = z.enum(['typescript', 'python', 'rust']);
const label = z.tuple([z.string().min(1), z.number().int().positive(), z.number().int().positive(), z.string().min(1).nullable(), z.enum(['resolved', 'unresolved', 'external']), z.number().int().positive(), z.number().int().positive()]);
const fixtureSchema = z.object({ id: z.string().min(1), language: languages, file: z.string().regex(/^[A-Za-z0-9_.-]+$/), startLine: z.number().int().positive(), endLine: z.number().int().positive(), expected: z.array(label).min(1) }).strict();
const corpusSchema = z.object({ schemaVersion: z.literal(1), selection: z.string().min(1), fixtures: z.array(fixtureSchema).min(1) }).strict();

function loadCorpus() {
  const bytes = readFileSync(new URL('./corpus/real-world-call-labels.json', import.meta.url));
  const corpus = corpusSchema.parse(JSON.parse(bytes.toString()));
  const provenance = z.object({ sources: z.array(z.object({ language: languages, path: z.string(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) })) }).parse(JSON.parse(readFileSync(new URL('provenance.json', root), 'utf8')));
  if (new Set(corpus.fixtures.map(f => f.id)).size !== corpus.fixtures.length) throw new Error('Duplicate real-world call fixture IDs');
  for (const language of languages.options) if (!corpus.fixtures.some(f => f.language === language)) throw new Error(`Missing real-world call language: ${language}`);
  for (const fixture of corpus.fixtures) {
    const source = readFileSync(new URL(fixture.file, root));
    const origin = provenance.sources.find(candidate => candidate.path === fixture.file && candidate.language === fixture.language);
    if (!origin || createHash('sha256').update(source).digest('hex') !== origin.sourceSha256) throw new Error(`Source provenance mismatch: ${fixture.id}`);
    const lineCount = source.toString().split('\n').length - (source.toString().endsWith('\n') ? 1 : 0);
    if (fixture.startLine > fixture.endLine || fixture.endLine > lineCount) throw new Error(`Invalid scope: ${fixture.id}`);
  }
  return { corpus, labelsSha256: createHash('sha256').update(bytes).digest('hex') };
}

function inScope(site: ResolvedCallSite, fixture: z.infer<typeof fixtureSchema>) {
  return site.filePath === fixture.file && site.line >= fixture.startLine && site.line <= fixture.endLine;
}

function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'no-gate': { type: 'boolean', default: false } } });
  const { corpus, labelsSha256 } = loadCorpus();
  const started = performance.now();
  const results = corpus.fixtures.map(fixture => {
    const source = readFileSync(new URL(fixture.file, root), 'utf8');
    let actual: ResolvedCallSite[] = [];
    let error: string | undefined;
    try {
      const symbols = extractFile(source, fixture.file, fixture.language, 'ast').symbols;
      actual = resolveSymbols([symbols]).calls.filter(site => inScope(site, fixture));
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    const counts = countCallMatches(fixture.expected, actual);
    const measured = callMetrics(counts);
    const pass = !error && checkCallGate(measured, { precision: 1, recall: 1, siteAccuracy: 1, resolutionAccuracy: 1 });
    return { id: fixture.id, language: fixture.language, file: fixture.file, scope: [fixture.startLine, fixture.endLine], labels: fixture.expected.length, measured, error, pass };
  });
  const report = { schemaVersion: 1, tier: 'real-world', factFamily: 'call-sites', engine: 'ast', scopePolicy: 'only preselected contiguous scopes are scored', labelsSha256, generatedAt: new Date().toISOString(), node: process.version, durationMs: performance.now() - started, processMaxRssKiB: process.resourceUsage().maxRSS, gateEnforced: !values['no-gate'], pass: results.every(r => r.pass), results };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, json);
  console.log(json);
  if (!values['no-gate'] && !report.pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
