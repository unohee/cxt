import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { loadFlowCorpus } from './dataflow-accuracy.js';

/**
 * Emit a reviewer-only held-out bundle. It intentionally contains labels and
 * source, but no analyzer output, so a second reviewer can inspect the facts
 * independently of the engine's result.
 */
export function buildReviewBundle() {
  const corpusPath = new URL('./corpus/held-out/dataflow.json', import.meta.url);
  const provenancePath = new URL('./corpus/held-out/provenance.json', import.meta.url);
  const bytes = readFileSync(corpusPath);
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as { labelsSha256?: string; reviewStatus?: string };
  const fixtures = loadFlowCorpus('held-out-review');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const lines = [
    '# cxt held-out dataflow review bundle',
    '',
    'This bundle contains source and hand-written labels only. Do not run or include cxt output in the review record.',
    '',
    `- tier: held-out-review`,
    `- fixtures: ${fixtures.length}`,
    `- labelsSha256: ${digest}`,
    `- provenanceSha256: ${provenance.labelsSha256 ?? '(missing)'}`,
    `- currentStatus: ${provenance.reviewStatus ?? '(missing)'}`,
    '',
    '## Reviewer sign-off template',
    '',
    '- reviewer ID:',
    '- role: primary or secondary',
    '- reviewed fixture IDs: every ID below, exactly once',
    `- labelsSha256 reviewed: ${digest}`,
    '- decision: pending / accepted / changes requested',
    '- notes:',
  ];
  for (const fixture of fixtures) {
    lines.push('', `## ${fixture.id} (${fixture.language})`, '', '### Source', '', '```', fixture.source, '```', '', '### Expected labels', '', '```json', JSON.stringify({
      parameters: fixture.parameters, atoms: fixture.atoms, completeness: fixture.completeness, reads: fixture.reads, ownership: fixture.ownership ?? [],
    }, null, 2), '```');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const bundle = buildReviewBundle();
  if (values.output) writeFileSync(resolve(values.output), bundle);
  else process.stdout.write(bundle);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
