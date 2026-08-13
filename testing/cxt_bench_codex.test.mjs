import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TASKS, buildSnapshot, createRunSnapshot, createSourceSnapshot, gradeFinal, parseArgs, parseCodexEvents, summarize } from './cxt_bench_codex.mjs';

test('parseCodexEvents counts completed commands and usage', () => {
  const text = [
    { type: 'item.completed', item: { type: 'command_execution', command: '/bin/zsh -lc cxt impact x' } },
    { type: 'item.completed', item: { type: 'command_execution', command: '/bin/zsh -lc "rg -n x src"' } },
    { type: 'item.completed', item: { type: 'agent_message', text: '{"items":["x"]}' } },
    { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } },
  ].map(JSON.stringify).join('\n');
  const parsed = parseCodexEvents(text);
  assert.equal(parsed.totalTools, 2);
  assert.equal(parsed.exploreTools, 1);
  assert.equal(parsed.cxtTools, 1);
  assert.equal(parsed.completed, true);
  assert.equal(parsed.finalText, '{"items":["x"]}');
});

test('gradeFinal uses F1 and rejects non-schema output', () => {
  assert.equal(gradeFinal('{"items":["a","b"]}', { score: TASKS.callgraph.score }, ['a', 'b']), 1);
  assert.equal(gradeFinal('a, b', TASKS.callgraph, ['a', 'b']), 0);
  assert.ok(gradeFinal('{"items":["a","extra"]}', TASKS.callgraph, ['a', 'b']) < 1);
});

test('summarize requires completed, quality-eligible evidence and a sufficient sample', () => {
  const rows = [];
  for (let run = 1; run <= 20; run += 1) {
    rows.push(
      { task: 'x', run, condition: 'on', totalTools: 1, score: 1, completed: true, exitCode: 0 },
      { task: 'x', run, condition: 'off', totalTools: 4, score: 1, completed: true, exitCode: 0 },
    );
  }
  rows.push(
    { task: 'y', run: 1, condition: 'on', totalTools: 0, score: 0, completed: true, exitCode: 0 },
    { task: 'y', run: 1, condition: 'off', totalTools: 5, score: 1, completed: true, exitCode: 0 },
  );
  const summary = summarize(rows);
  assert.equal(summary.eligiblePairs, 20);
  assert.equal(summary.meanSavedTools, 3);
  assert.equal(summary.medianSavedTools, 3);
  assert.equal(summary.confidenceInterval95.lower, 3);
  assert.equal(summary.meaningful, true);
});

test('parseArgs validates task names and positive runs', () => {
  assert.deepEqual(parseArgs(['--tasks', 'callgraph,explain', '--runs', '2']).tasks, ['callgraph', 'explain']);
  assert.throws(() => parseArgs(['--tasks', 'missing']), /Unknown task/);
  assert.throws(() => parseArgs(['--runs', '0']), /positive integer/);
});

test('builds the isolated snapshot instead of reusing target dist', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'cxt-bench-source-'));
  const snapshot = join(project, 'snapshot');
  t.after(() => rm(project, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(project, 'src'), { recursive: true }),
    mkdir(join(project, 'dist'), { recursive: true }),
    mkdir(snapshot),
  ]);
  await Promise.all([
    writeFile(join(project, 'src', 'marker.txt'), 'fresh source'),
    writeFile(join(project, 'dist', 'cli.js'), 'stale target build'),
    writeFile(join(project, 'package-lock.json'), '{}'),
    writeFile(join(project, 'tsconfig.json'), '{}'),
    writeFile(join(project, 'vitest.config.ts'), 'export default {}'),
    writeFile(join(project, 'package.json'), JSON.stringify({
      scripts: { build: 'node -e "const fs=require(\'fs\');fs.mkdirSync(\'dist\',{recursive:true});fs.copyFileSync(\'src/marker.txt\',\'dist/cli.js\')"' },
    })),
  ]);
  await createSourceSnapshot(project, snapshot);
  await assert.rejects(readFile(join(snapshot, 'dist', 'cli.js'), 'utf8'), { code: 'ENOENT' });
  await buildSnapshot(snapshot);
  assert.equal(await readFile(join(snapshot, 'dist', 'cli.js'), 'utf8'), 'fresh source');
});

test('creates a fresh prepared workspace for each condition', async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'cxt-bench-session-'));
  const template = join(project, 'template');
  const first = join(project, 'first');
  const second = join(project, 'second');
  t.after(() => rm(project, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(project, 'src'), { recursive: true }),
    mkdir(join(project, 'node_modules'), { recursive: true }),
    mkdir(template),
    mkdir(first),
    mkdir(second),
  ]);
  await Promise.all([
    writeFile(join(project, 'src', 'marker.txt'), 'baseline'),
    writeFile(join(project, 'package-lock.json'), '{}'),
    writeFile(join(project, 'tsconfig.json'), '{}'),
    writeFile(join(project, 'vitest.config.ts'), 'export default {}'),
    writeFile(join(project, 'package.json'), JSON.stringify({
      scripts: { build: 'node -e "const fs=require(\'fs\');fs.mkdirSync(\'dist\',{recursive:true});fs.copyFileSync(\'src/marker.txt\',\'dist/cli.js\')"' },
    })),
  ]);
  await createSourceSnapshot(project, template);
  await buildSnapshot(template);
  await createRunSnapshot(template, first, join(project, 'node_modules'));
  await createRunSnapshot(template, second, join(project, 'node_modules'));
  await writeFile(join(first, 'src', 'marker.txt'), 'contaminated');
  assert.equal(await readFile(join(second, 'src', 'marker.txt'), 'utf8'), 'baseline');
  assert.equal(await readFile(join(second, 'dist', 'cli.js'), 'utf8'), 'baseline');
});
