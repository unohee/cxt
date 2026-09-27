import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StructuralFinding } from '../src/analysis/astRules.js';
import { analyzeSemanticRules } from '../src/analysis/semanticRules.js';
import { builtInRulePack } from '../src/analysis/rulePack.js';

const schema = z.object({ id: z.string().min(1), language: z.enum(['typescript', 'python', 'rust']), file: z.string().min(1),
  source: z.string().min(1), rule: z.string().min(1), lines: z.array(z.number().int().positive()) }).strict();
export type RuleFixture = z.infer<typeof schema>;
export function loadRuleCorpus(): RuleFixture[] {
  const fixtures = z.array(schema).min(1).parse(JSON.parse(readFileSync(new URL('./corpus/rules.json', import.meta.url), 'utf8')));
  if (new Set(fixtures.map(f => f.id)).size !== fixtures.length) throw new Error('Duplicate rule fixture IDs');
  for (const rule of builtInRulePack.rules) {
    const positive = fixtures.find(f => f.id === rule.fixtures.positive), negative = fixtures.find(f => f.id === rule.fixtures.negative);
    if (!positive || positive.rule !== rule.id || !positive.lines.length || !negative || negative.rule !== rule.id || negative.lines.length) throw new Error(`Missing positive/negative contract: ${rule.id}`);
  }
  for (const fixture of fixtures) if (!builtInRulePack.rules.some(rule => rule.id === fixture.rule)) throw new Error(`Unknown fixture rule: ${fixture.rule}`);
  return fixtures;
}

export function scoreRule(fixture: RuleFixture, findings: StructuralFinding[]) {
  const labels = [...fixture.lines]; let tp = 0, fp = 0, invalidSpans = 0;
  for (const finding of findings) {
    const index = finding.rule.id === fixture.rule ? labels.indexOf(finding.span.line) : -1;
    if (index < 0) fp++; else { tp++; labels.splice(index, 1); }
    const { span } = finding, before = fixture.source.slice(0, span.startOffset), end = fixture.source.slice(0, span.endOffset);
    const line = before.split('\n').length, column = before.length - before.lastIndexOf('\n');
    if (span.startOffset < 0 || span.endOffset <= span.startOffset || span.endOffset > fixture.source.length
      || line !== span.line || column !== span.column || end.split('\n').length !== span.endLine || end.length - end.lastIndexOf('\n') !== span.endColumn) invalidSpans++;
  }
  return { tp, fp, fn: labels.length, invalidSpans };
}
export const ruleFixturePass = (score: ReturnType<typeof scoreRule>) => score.fp === 0 && score.fn === 0 && score.invalidSpans === 0;

function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const fixtures = loadRuleCorpus(), start = performance.now();
  const results = builtInRulePack.rules.map(rule => {
    const selected = fixtures.filter(f => f.rule === rule.id), totals = { tp: 0, fp: 0, fn: 0, invalidSpans: 0 }, failures: string[] = [];
    const partialAnalyses: string[] = [];
    for (const fixture of selected) {
      try {
        const analysis = analyzeSemanticRules(fixture.source, fixture.file, fixture.language);
        if (analysis.completeness === 'partial') partialAnalyses.push(fixture.id);
        const findings = analysis.findings.filter(finding => finding.rule.id === fixture.rule);
        const score = scoreRule(fixture, findings);
        for (const key of ['tp', 'fp', 'fn', 'invalidSpans'] as const) totals[key] += score[key];
        if (!ruleFixturePass(score)) failures.push(fixture.id);
      } catch (error) { failures.push(`${fixture.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const precision = totals.tp / (totals.tp + totals.fp || 1), recall = totals.tp / (totals.tp + totals.fn || 1);
    return { rule: rule.id, fixtures: selected.length, languages: [...new Set(selected.map(f => f.language))], ...totals, precision, recall,
      f1: 2 * precision * recall / (precision + recall || 1), partialAnalyses, failures, pass: !failures.length && ruleFixturePass(totals) };
  });
  const report = { schemaVersion: 1, factFamily: 'structural-rules', tier: 'synthetic-development',
    corpusSha256: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'), generatedAt: new Date().toISOString(),
    durationMs: performance.now() - start, processMaxRssKiB: process.resourceUsage().maxRSS, results, pass: results.every(result => result.pass) };
  const json = JSON.stringify(report, null, 2) + '\n'; if (values.output) writeFileSync(values.output, json);
  console.log(json); if (!report.pass) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
