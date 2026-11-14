import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { analyzeSemanticRules } from '../src/analysis/semanticRules.js';
import { builtInRulePack } from '../src/analysis/rulePack.js';
import { scoreRule, ruleFixturePass } from './rule-accuracy.js';
import type { RuleFixture } from './rule-accuracy.js';

const root = new URL('./corpus/real-world/', import.meta.url);
const language = z.enum(['typescript', 'python', 'rust']);
const fixtureSchema = z.object({ id: z.string().min(1), language, file: z.string().regex(/^[A-Za-z0-9_.-]+$/), startLine: z.number().int().positive(), endLine: z.number().int().positive(), rule: z.string().min(1), lines: z.array(z.number().int().positive()) }).strict();
const corpusSchema = z.object({ schemaVersion: z.literal(1), selection: z.string().min(1), fixtures: z.array(fixtureSchema).min(1) }).strict();

function loadCorpus() {
  const bytes = readFileSync(new URL('./corpus/real-world-rule-labels.json', import.meta.url));
  const corpus = corpusSchema.parse(JSON.parse(bytes.toString()));
  const provenance = z.object({ sources: z.array(z.object({ language, path: z.string(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) })) }).parse(JSON.parse(readFileSync(new URL('provenance.json', root), 'utf8')));
  for (const fixture of corpus.fixtures) {
    if (!builtInRulePack.rules.some(rule => rule.id === fixture.rule)) throw new Error(`Unknown rule: ${fixture.rule}`);
    const source = readFileSync(new URL(fixture.file, root));
    const origin = provenance.sources.find(candidate => candidate.path === fixture.file && candidate.language === fixture.language);
    if (!origin || createHash('sha256').update(source).digest('hex') !== origin.sourceSha256) throw new Error(`Source provenance mismatch: ${fixture.id}`);
    if (fixture.startLine > fixture.endLine || fixture.lines.some(line => line < fixture.startLine || line > fixture.endLine)) throw new Error(`Invalid rule scope: ${fixture.id}`);
  }
  return { corpus, labelsSha256: createHash('sha256').update(bytes).digest('hex') };
}

function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const { corpus, labelsSha256 } = loadCorpus();
  const started = performance.now();
  const results = corpus.fixtures.map(fixture => {
    const source = readFileSync(new URL(fixture.file, root), 'utf8');
    const findings = analyzeSemanticRules(source, fixture.file, fixture.language).findings.filter(finding => finding.rule.id === fixture.rule && finding.span.line >= fixture.startLine && finding.span.line <= fixture.endLine);
    const normalized: RuleFixture = { id: fixture.id, language: fixture.language, file: fixture.file, source, rule: fixture.rule, lines: fixture.lines };
    const measured = scoreRule(normalized, findings);
    return { id: fixture.id, language: fixture.language, file: fixture.file, rule: fixture.rule, scope: [fixture.startLine, fixture.endLine], labels: fixture.lines.length, measured, pass: ruleFixturePass(measured) };
  });
  const report = { schemaVersion: 1, tier: 'real-world', factFamily: 'structural-rules', engine: 'ast', scopePolicy: 'only preselected contiguous scopes are scored', labelsSha256, generatedAt: new Date().toISOString(), node: process.version, durationMs: performance.now() - started, processMaxRssKiB: process.resourceUsage().maxRSS, pass: results.every(r => r.pass), results };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, json);
  console.log(json);
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
