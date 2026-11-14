import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

type Gate = { name: string; script: string; args?: string[]; output?: boolean };

const gates: Gate[] = [
  { name: 'accuracy', script: 'bench:accuracy' },
  { name: 'calls', script: 'bench:calls' },
  { name: 'cfg', script: 'bench:cfg' },
  { name: 'flow', script: 'bench:flow' },
  { name: 'impact', script: 'bench:impact' },
  { name: 'rules', script: 'bench:rules' },
  { name: 'external', script: 'bench:external' },
  { name: 'self', script: 'bench:self' },
  { name: 'calls-real-world', script: 'bench:calls:real-world' },
  { name: 'flow-real-world', script: 'bench:flow:real-world' },
  { name: 'rules-real-world', script: 'bench:rules:real-world' },
  { name: 'packed-package', script: 'test:package', output: false },
  { name: 'self-scan', script: 'ci:self-scan', output: false },
];

const requireIndependentReview = process.argv.includes('--require-independent-review');
const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && !outputPath) {
  console.error('--output requires a path');
  process.exit(2);
}

if (requireIndependentReview) {
  gates.push({
    name: 'flow-held-out-independent',
    script: 'bench:flow',
    args: ['--tier', 'held-out-review', '--require-independent-review'],
  });
}

const tempRoot = await mkdtemp(join(tmpdir(), 'cxt-bench-all-'));
const startedAt = new Date().toISOString();
const results: Array<Record<string, unknown>> = [];
try {
  for (const gate of gates) {
    const gateOutput = join(tempRoot, `${gate.name}.json`);
    const args = ['run', gate.script];
    if (gate.output !== false) args.push('--', '--output', gateOutput);
    if (gate.args?.length) args.push('--', ...gate.args);
    const started = Date.now();
    const result = spawnSync('npm', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const status = result.error ? 'spawn-error' : result.status === 0 ? 'passed' : 'failed';
    const record: Record<string, unknown> = {
      name: gate.name,
      script: gate.script,
      status,
      exitCode: result.status,
      durationMs: Date.now() - started,
      stdoutTail: (result.stdout ?? '').slice(-2000),
      stderrTail: (result.stderr ?? '').slice(-2000),
    };
    if (result.error) record.error = result.error.message;
    try {
      record.report = JSON.parse(await readFile(gateOutput, 'utf8'));
    } catch {
      record.report = null;
    }
    results.push(record);
    console.log(`[bench:all] ${gate.name}: ${status}`);
  }

  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    requireIndependentReview,
    passed: results.every((result) => result.status === 'passed'),
    gates: results,
  };
  if (outputPath) {
    await mkdir(join(outputPath, '..'), { recursive: true }).catch(() => undefined);
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.exitCode = report.passed ? 0 : 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
