import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { extractFile } from '../src/registry/entityScanner.js';
import { reachableNodes, type ControlFlowGraph } from '../src/analysis/cfg.js';

const languages = ['typescript', 'python', 'rust'] as const;
const fixtureSchema = z.object({ id: z.string().min(1), language: z.enum(languages), source: z.string().min(1),
  complexity: z.number().int().positive(), completeness: z.enum(['complete', 'partial']),
  paths: z.array(z.tuple([z.string().min(1), z.string().min(1), z.boolean()])) });
export type CfgFixture = z.infer<typeof fixtureSchema>;
export function loadCfgCorpus(): CfgFixture[] {
  const fixtures = z.array(fixtureSchema).min(1).parse(JSON.parse(readFileSync(new URL('./corpus/cfg.json', import.meta.url), 'utf8')));
  if (new Set(fixtures.map(f => f.id)).size !== fixtures.length) throw new Error('Duplicate CFG fixture IDs');
  for (const language of languages) if (!fixtures.some(f => f.language === language)) throw new Error(`Missing CFG corpus language: ${language}`);
  return fixtures;
}
export function scoreCfg(fixture: CfgFixture, graph: ControlFlowGraph | undefined) {
  let pathCorrect = 0;
  for (const [from, to, expected] of fixture.paths) {
    const starts = graph?.nodes.filter(n => n.text === from) ?? [];
    const ends = graph?.nodes.filter(n => n.text === to) ?? [];
    // An absent label is never a successful negative reachability assertion.
    if (!graph || !starts.length || !ends.length) continue;
    const actual = starts.some(start => ends.some(end => reachableNodes(graph, start.id).has(end.id)));
    if (actual === expected) pathCorrect++;
  }
  return { constructed: graph ? 1 : 0, completenessCorrect: graph?.completeness === fixture.completeness ? 1 : 0,
    complexityCorrect: graph?.structuralComplexity === fixture.complexity ? 1 : 0, pathCorrect, paths: fixture.paths.length };
}
export function cfgGate(counts: ReturnType<typeof scoreCfg>, fixtures: number): boolean {
  return fixtures > 0 && counts.constructed / fixtures >= 0.98 && counts.completenessCorrect === fixtures
    && counts.complexityCorrect / fixtures >= 0.95 && counts.pathCorrect === counts.paths;
}
function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const corpus = loadCfgCorpus();
  const started = performance.now();
  const results = languages.map(language => {
    const fixtures = corpus.filter(f => f.language === language);
    const counts = { constructed: 0, completenessCorrect: 0, complexityCorrect: 0, pathCorrect: 0, paths: 0 };
    const failures: Array<{ id: string; error?: string; measured?: typeof counts }> = [];
    let complete = 0, partial = 0;
    for (const fixture of fixtures) {
      let graph: ControlFlowGraph | undefined;
      try {
        const path = language === 'typescript' ? 'x.ts' : language === 'python' ? 'x.py' : 'x.rs';
        graph = extractFile(fixture.source, path, language, 'ast').controlFlow?.find(g => g.owner === `${path}::f`);
        if (graph?.completeness === 'complete') complete++;
        else if (graph?.completeness === 'partial') partial++;
      } catch (error) { failures.push({ id: fixture.id, error: error instanceof Error ? error.message : String(error) }); }
      const measured = scoreCfg(fixture, graph);
      for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += measured[key];
      if (!cfgGate(measured, 1)) failures.push({ id: fixture.id, measured });
    }
    return { language, fixtures: fixtures.length, complete, partial, ...counts,
      constructionRate: counts.constructed / fixtures.length, complexityAccuracy: counts.complexityCorrect / fixtures.length,
      reachabilityAccuracy: counts.paths ? counts.pathCorrect / counts.paths : 1,
      failures, pass: !failures.some(f => f.error) && cfgGate(counts, fixtures.length) };
  });
  const report = { schemaVersion: 1, factFamily: 'control-flow', tier: 'synthetic-development',
    corpusSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'), generatedAt: new Date().toISOString(),
    node: process.version, durationMs: performance.now() - started, processMaxRssKiB: process.resourceUsage().maxRSS,
    pass: results.every(r => r.pass), results };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, json);
  console.log(json);
  if (!report.pass) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
