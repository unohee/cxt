import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { extractFile, type ExtractedEntity } from '../src/registry/entityScanner.js';
import { countMatches, metrics, checkGate } from './accuracy.js';

const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const language = z.enum(['typescript', 'python', 'rust']);
const path = z.string().regex(/^[A-Za-z0-9_.-]+$/).refine(value => value !== '.' && value !== '..');
const entitySchema = z.object({ kind: z.enum(['function', 'class', 'module', 'type', 'constant']), name: z.string().min(1),
  lineStart: z.number().int().positive(), lineEnd: z.number().int().positive(), scopedName: z.string().min(1),
  isExported: z.boolean(), paramCount: z.number().int().nonnegative() }).strict();
const fixtureSchema = z.object({ id: z.string().min(1), language, filePath: path, entities: z.array(entitySchema).min(1) }).strict();
const labelsSchema = z.object({ schemaVersion: z.literal(1), authoredAt: z.iso.datetime(), engineEvaluated: z.boolean(),
  labelProvenance: z.string().min(1), exportContract: z.string().min(1), parameterContract: z.string().min(1), fixtures: z.array(fixtureSchema).min(1) }).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const provenanceSchema = z.object({ schemaVersion: z.literal(1), tier: z.literal('real-world'), selectedBeforeFirstEvaluation: z.literal(true), selection: z.string().min(1),
  labelsSha256: digest, sources: z.array(z.object({ language, id: z.string().min(1), path, start: z.number().int().positive(), end: z.number().int().positive(),
    version: z.string().min(1), upstream: z.url(), upstreamBlobSha1: z.string().regex(/^[a-f0-9]{40}$/), upstreamVerifiedAt: z.iso.datetime(),
    license: z.string().min(1), licensePath: path, originalSha256: digest, sourceSha256: digest, licenseSha256: digest }).strict()).min(1) }).strict();
export type ExternalFixture = z.infer<typeof fixtureSchema> & { source: string; sourceSha256: string };

export function loadExternalCorpus(root = new URL('./corpus/real-world/', import.meta.url)): ExternalFixture[] {
  const labelsBytes = readFileSync(new URL('expected.json', root));
  const labels = labelsSchema.parse(JSON.parse(labelsBytes.toString()));
  const provenance = provenanceSchema.parse(JSON.parse(readFileSync(new URL('provenance.json', root), 'utf8')));
  if (sha256(labelsBytes) !== provenance.labelsSha256) throw new Error('Frozen label integrity mismatch');
  if (new Set(labels.fixtures.map(f => f.id)).size !== labels.fixtures.length || new Set(provenance.sources.map(s => s.id)).size !== provenance.sources.length
    || labels.fixtures.length !== provenance.sources.length) throw new Error('Duplicate or missing provenance/fixture');
  return labels.fixtures.map(fixture => {
    const origin = provenance.sources.find(source => source.id === fixture.id);
    if (!origin || origin.language !== fixture.language || origin.path !== fixture.filePath) throw new Error(`Source provenance mismatch: ${fixture.id}`);
    const source = readFileSync(new URL(origin.path, root), 'utf8');
    if (sha256(source) !== origin.sourceSha256 || sha256(readFileSync(new URL(origin.licensePath, root))) !== origin.licenseSha256) throw new Error(`Source/license integrity mismatch: ${fixture.id}`);
    const lineCount = source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
    if (lineCount !== origin.end - origin.start + 1) throw new Error(`Source slice length mismatch: ${fixture.id}`);
    if (fixture.entities.some(e => e.lineEnd < e.lineStart || e.lineEnd > lineCount)
      || new Set(fixture.entities.map(e => `${e.kind}:${e.name}:${e.lineStart}`)).size !== fixture.entities.length) throw new Error(`Invalid label span or duplicate: ${fixture.id}`);
    return { ...fixture, source, sourceSha256: origin.sourceSha256 };
  });
}

export function scoreExternalFixture(fixture: ExternalFixture, actual: ExtractedEntity[]) {
  const counts = countMatches(fixture.entities.map(e => [e.kind, e.name, e.lineStart, e.lineEnd, e.scopedName]), actual);
  let exportCorrect = 0, parameterCorrect = 0;
  const remaining = [...actual];
  for (const expected of fixture.entities) {
    const index = remaining.findIndex(e => e.kind === expected.kind && e.name === expected.name && e.lineStart === expected.lineStart);
    if (index < 0) continue;
    const entity = remaining.splice(index, 1)[0];
    if (entity.isExported === expected.isExported) exportCorrect++;
    if (entity.paramCount === expected.paramCount) parameterCorrect++;
  }
  return { ...metrics(counts), exportCorrect, parameterCorrect,
    exportAccuracy: exportCorrect / fixture.entities.length, parameterAccuracy: parameterCorrect / fixture.entities.length };
}

export function externalGate(measured: ReturnType<typeof scoreExternalFixture>): boolean {
  return checkGate(measured, { precision: 0.98, recall: 0.98, spanAccuracy: 0.98, scopeAccuracy: 0.98 })
    && measured.exportAccuracy === 1 && measured.parameterAccuracy === 1;
}

function main(): void {
  const { values } = parseArgs({ options: { engine: { type: 'string', default: 'ast' }, 'no-gate': { type: 'boolean', default: false }, output: { type: 'string' } } });
  const engine = z.enum(['ast', 'lexical']).parse(values.engine), fixtures = loadExternalCorpus(), start = performance.now();
  const results = fixtures.map(fixture => {
    let actual: ExtractedEntity[] = [], error: string | undefined;
    try { actual = extractFile(fixture.source, fixture.filePath, fixture.language, engine).entities; }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    const measured = scoreExternalFixture(fixture, actual);
    return { id: fixture.id, language: fixture.language, sourceSha256: fixture.sourceSha256, labels: fixture.entities.length,
      measured, error, pass: !error && externalGate(measured), actual };
  });
  const report = { schemaVersion: 1, tier: 'real-world', engine, factFamily: 'entities-with-metadata',
    corpusSha256: sha256(JSON.stringify(fixtures)), generatedAt: new Date().toISOString(), node: process.version,
    durationMs: performance.now() - start, processMaxRssKiB: process.resourceUsage().maxRSS,
    gateEnforced: !values['no-gate'], pass: results.every(r => r.pass), results };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, json);
  console.log(json);
  if (!values['no-gate'] && !report.pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
