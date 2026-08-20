#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = resolve(SCRIPT_DIR, '..');
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const SNAPSHOT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts'];
const SNAPSHOT_DIRECTORIES = ['src', 'dist'];

export const TASKS = {
  callgraph: {
    prompt: "The signature of rowsToEntities may change. List every transitively affected function or class in this repository. Return only entity names in items; do not modify files.",
    oracle: async ({ runCxt }) => {
      const parsed = JSON.parse(await runCxt(['impact', 'rowsToEntities', '--json']));
      return parsed.impacted.map((item) => item.name);
    },
    score(items, expected) {
      return setF1(items.filter((item) => IDENTIFIER.test(item)), expected);
    },
  },
  locate: {
    prompt: "Locate the definitions of rowsToEntities, resolveRelations, handleImpact, and handleExport. Return items as 'name — repository-relative filepath'. Do not modify files.",
    expected: [
      'rowsToEntities — src/registry/sqliteStore.ts',
      'resolveRelations — src/registry/entityScanner.ts',
      'handleImpact — src/cli/relationHandler.ts',
      'handleExport — src/cli/exportHandler.ts',
    ],
    score(items, expected) {
      const normalized = items.map((item) => item.replace(/\s*[-—:]\s*/, ' — '));
      return setF1(normalized, expected);
    },
  },
  explain: {
    prompt: "Read resolveRelations and summarize its behavior in exactly three concise items. Do not modify files.",
    expected: ['entit', 'resolv', 'edge'],
    score(items, expected) {
      if (items.length !== 3) return 0;
      const text = items.join(' ').toLowerCase();
      return expected.filter((term) => text.includes(term)).length / expected.length;
    },
  },
};

export function parseArgs(argv) {
  const options = {
    target: DEFAULT_TARGET,
    tasks: Object.keys(TASKS),
    runs: 1,
    model: '',
    timeoutSeconds: 300,
    outdir: '',
    dryRun: false,
    keepTemp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--keep-temp') options.keepTemp = true;
    else if (arg === '--target') options.target = resolve(argv[++i]);
    else if (arg === '--tasks') options.tasks = argv[++i].split(',').filter(Boolean);
    else if (arg === '--runs') options.runs = positiveInt(argv[++i], '--runs');
    else if (arg === '--model') options.model = argv[++i];
    else if (arg === '--timeout') options.timeoutSeconds = positiveInt(argv[++i], '--timeout');
    else if (arg === '--outdir') options.outdir = resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const task of options.tasks) {
    if (!TASKS[task]) throw new Error(`Unknown task: ${task}`);
  }
  return options;
}

export function parseCodexEvents(text) {
  const events = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const commands = events
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'command_execution')
    .map((event) => event.item.command ?? '');
  const completed = [...events].reverse().find((event) => event.type === 'turn.completed');
  const finalMessage = [...events].reverse().find(
    (event) => event.type === 'item.completed' && event.item?.type === 'agent_message',
  );
  return {
    commands,
    totalTools: commands.length,
    exploreTools: commands.filter(isExplorationCommand).length,
    cxtTools: commands.filter((command) => /(^|[\s/;&|"'()])cxt(?:\s|$)/.test(command)).length,
    usage: completed?.usage ?? {},
    completed: Boolean(completed),
    finalText: finalMessage?.item?.text ?? '',
  };
}

export function gradeFinal(text, task, expected) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.items) || !parsed.items.every((item) => typeof item === 'string')) return 0;
    return task.score(parsed.items, expected);
  } catch {
    return 0;
  }
}

export function summarize(rows) {
  const paired = [];
  const keys = [...new Set(rows.map((row) => `${row.task}:${row.run}`))];
  for (const key of keys) {
    const [task, runText] = key.split(':');
    const on = rows.find((row) => row.task === task && row.run === Number(runText) && row.condition === 'on');
    const off = rows.find((row) => row.task === task && row.run === Number(runText) && row.condition === 'off');
    if (!on || !off) continue;
    paired.push({
      task,
      run: Number(runText),
      onTools: on.totalTools,
      offTools: off.totalTools,
      savedTools: off.totalTools - on.totalTools,
      onScore: on.score,
      offScore: off.score,
      onCompleted: on.completed,
      offCompleted: off.completed,
      onExitCode: on.exitCode,
      offExitCode: off.exitCode,
      onSourceIntact: on.sourceIntact,
      offSourceIntact: off.sourceIntact,
      qualityDelta: on.score - off.score,
    });
  }
  const eligible = paired.filter((row) => isQualityEligible(row));
  const savings = eligible.map((row) => row.savedTools);
  const interval95 = confidenceInterval95(savings);
  return {
    generatedAt: new Date().toISOString(),
    pairs: paired.length,
    eligiblePairs: eligible.length,
    meanSavedTools: mean(savings),
    medianSavedTools: median(savings),
    confidenceInterval95: interval95,
    onWins: savings.filter((value) => value > 0).length,
    ties: savings.filter((value) => value === 0).length,
    offWins: savings.filter((value) => value < 0).length,
    meaningful: eligible.length >= 20 && interval95?.lower > 0,
    paired,
  };
}

function setF1(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const matches = [...actualSet].filter((item) => expectedSet.has(item)).length;
  if (actualSet.size === 0 || expectedSet.size === 0 || matches === 0) return 0;
  const precision = matches / actualSet.size;
  const recall = matches / expectedSet.size;
  return (2 * precision * recall) / (precision + recall);
}

function isExplorationCommand(command) {
  return /(^|[\s;&|"'()])(rg|grep|find|sed|cat|head|tail|awk|ls)(\s|$)/.test(command);
}

function positiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function confidenceInterval95(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { lower: average - margin, upper: average + margin };
}

function isQualityEligible(pair) {
  return (pair.onCompleted ?? true) && (pair.offCompleted ?? true) &&
    (pair.onExitCode ?? 0) === 0 && (pair.offExitCode ?? 0) === 0 &&
    (pair.onSourceIntact ?? true) && (pair.offSourceIntact ?? true) &&
    pair.onScore >= 0.8 && pair.onScore >= pair.offScore - 0.05;
}

function usageValue(usage, key) {
  return Number(usage?.[key] ?? 0);
}

async function runProcess(command, args, { cwd, env, timeoutSeconds = 30 }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutSeconds * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

async function writeWrapper(path, body) {
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

async function snapshotHash(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  for (const directory of SNAPSHOT_DIRECTORIES) await walk(join(root, directory));
  for (const file of SNAPSHOT_FILES) files.push(join(root, file));
  files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function createSourceSnapshot(target, snapshot) {
  const paths = ['src', ...SNAPSHOT_FILES];
  for (const item of paths) {
    await cp(join(target, item), join(snapshot, item), { recursive: true, force: false });
  }
}

export async function buildSnapshot(snapshot) {
  const result = await runProcess('npm', ['run', 'build'], { cwd: snapshot, env: process.env, timeoutSeconds: 120 });
  if (result.code !== 0) throw new Error(`snapshot build failed: ${result.stderr || result.stdout}`);
}

export async function createRunSnapshot(template, snapshot, nodeModules) {
  await createSourceSnapshot(template, snapshot);
  await cp(join(template, 'dist'), join(snapshot, 'dist'), { recursive: true, force: false });
  await symlink(nodeModules, join(snapshot, 'node_modules'), 'dir');
}

async function createSessionWorkspace(template, workspace, nodeModules, registryBackup, condition) {
  await mkdir(workspace, { recursive: true });
  await createRunSnapshot(template, workspace, nodeModules);
  await mkdir(join(workspace, '.cxt'));
  await copyFile(registryBackup, join(workspace, '.cxt', 'registry.db'));
  const bin = join(workspace, '.bench-bin');
  await mkdir(bin);
  const body = condition === 'on'
    ? `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(workspace, 'dist', 'cli.js'))} "$@"`
    : `echo 'cxt is disabled for this benchmark condition' >&2\nexit 127`;
  await writeWrapper(join(bin, 'cxt'), body);
  return bin;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node testing/cxt_bench_codex.mjs [options]\n\n` +
      `  --tasks callgraph,locate,explain  Task subset\n` +
      `  --runs N                         Paired repetitions (default: 1)\n` +
      `  --model MODEL                    Codex model (default: account default)\n` +
      `  --timeout SECONDS                Per-session timeout (default: 300)\n` +
      `  --target PATH                    Repository under test\n` +
      `  --outdir PATH                    Result directory\n` +
      `  --dry-run                        Validate setup without model calls\n` +
      `  --keep-temp                      Preserve isolated CODEX_HOME`);
    return;
  }

  const target = options.target;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const outdir = options.outdir || join(SCRIPT_DIR, `codex_bench_${stamp}`);
  const tempRoot = await mkdtemp(join(tmpdir(), 'cxt-codex-bench-'));
  const codexHome = join(tempRoot, 'codex-home');
  const snapshot = join(tempRoot, 'baseline');
  const registryBackup = join(tempRoot, 'registry.db');
  const schemaPath = join(tempRoot, 'answer.schema.json');
  await Promise.all([
    mkdir(outdir, { recursive: true }),
    mkdir(codexHome),
    mkdir(snapshot),
    mkdir(join(tempRoot, 'sessions')),
  ]);
  await copyFile(join(homedir(), '.codex', 'auth.json'), join(codexHome, 'auth.json'));
  await createSourceSnapshot(target, snapshot);
  await symlink(join(target, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
  await buildSnapshot(snapshot);
  const backup = await runProcess('sqlite3', [join(homedir(), '.cxt', 'registry.db'), `.backup '${registryBackup.replaceAll("'", "''")}'`], {
    cwd: target,
    env: process.env,
  });
  if (backup.code !== 0) throw new Error(`registry backup failed: ${backup.stderr}`);
  await mkdir(join(snapshot, '.cxt'));
  await copyFile(registryBackup, join(snapshot, '.cxt', 'registry.db'));
  await writeFile(schemaPath, JSON.stringify({
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'string' } } },
    required: ['items'],
    additionalProperties: false,
  }, null, 2));
  const oracleEnv = { ...process.env, CODEX_HOME: codexHome, HOME: snapshot };
  const runCxt = async (args) => {
    const result = await runProcess('node', [join(snapshot, 'dist', 'cli.js'), ...args], { cwd: snapshot, env: oracleEnv });
    if (result.code !== 0) throw new Error(`cxt oracle failed: ${result.stderr}`);
    return result.stdout;
  };
  const expectedByTask = {};
  for (const taskName of options.tasks) {
    const task = TASKS[taskName];
    expectedByTask[taskName] = task.oracle ? await task.oracle({ runCxt }) : task.expected;
  }
  const initialSnapshotHash = await snapshotHash(snapshot);
  await writeFile(join(outdir, 'manifest.json'), JSON.stringify({
    options: { ...options, target },
    expectedByTask,
    snapshotIncludes: ['src', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts'],
    snapshotBuild: 'npm run build',
    initialSnapshotHash,
  }, null, 2));
  if (options.dryRun) {
    console.log(`dry-run OK: ${outdir}`);
    if (!options.keepTemp) await rm(tempRoot, { recursive: true, force: true });
    return;
  }

  const rows = [];
  for (let run = 1; run <= options.runs; run += 1) {
    const order = run % 2 === 1 ? ['on', 'off'] : ['off', 'on'];
    for (const taskName of options.tasks) {
      for (const condition of order) {
        const task = TASKS[taskName];
        const label = `${taskName}_${condition}_r${run}`;
        const workspace = join(tempRoot, 'sessions', label);
        const bin = await createSessionWorkspace(snapshot, workspace, join(target, 'node_modules'), registryBackup, condition);
        const note = condition === 'on'
          ? `The current checkout's cxt command is available at ${join(bin, 'cxt')}. Invoke that exact absolute path when it reduces repository exploration.`
          : 'The cxt command is unavailable. Use ordinary read-only repository inspection.';
        const prompt = `${task.prompt}\n\n${note}`;
        const args = ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--json', '--sandbox', 'workspace-write', '--cd', workspace, '--output-schema', schemaPath];
        if (options.model) args.push('--model', options.model);
        args.push(prompt);
        const env = { ...process.env, CODEX_HOME: codexHome, HOME: workspace, PATH: `${bin}:${process.env.PATH}` };
        const started = Date.now();
        console.log(`[${rows.length + 1}/${options.tasks.length * options.runs * 2}] ${label}`);
        const result = await runProcess('codex', args, { cwd: workspace, env, timeoutSeconds: options.timeoutSeconds });
        const durationMs = Date.now() - started;
        await Promise.all([
          writeFile(join(outdir, `${label}.jsonl`), result.stdout),
          writeFile(join(outdir, `${label}.stderr.log`), result.stderr),
        ]);
        let parsed;
        try {
          parsed = parseCodexEvents(result.stdout);
        } catch (error) {
          parsed = { commands: [], totalTools: 0, exploreTools: 0, cxtTools: 0, usage: {}, completed: false, finalText: '' };
          result.stderr += `\nparse error: ${error.message}`;
        }
        rows.push({
          task: taskName,
          condition,
          run,
          exitCode: result.code,
          signal: result.signal,
          durationMs,
          completed: parsed.completed,
          totalTools: parsed.totalTools,
          exploreTools: parsed.exploreTools,
          cxtTools: parsed.cxtTools,
          inputTokens: usageValue(parsed.usage, 'input_tokens'),
          cachedInputTokens: usageValue(parsed.usage, 'cached_input_tokens'),
          outputTokens: usageValue(parsed.usage, 'output_tokens'),
          score: gradeFinal(parsed.finalText, task, expectedByTask[taskName]),
          commands: parsed.commands,
          finalText: parsed.finalText,
        });
        const sourceIntact = (await snapshotHash(workspace)) === initialSnapshotHash;
        rows.at(-1).sourceIntact = sourceIntact;
        if (!sourceIntact) throw new Error(`benchmark agent modified prepared workspace ${workspace}; aborting contaminated run`);
        await writeFile(join(outdir, 'results.json'), JSON.stringify(rows, null, 2));
      }
    }
  }
  const summary = summarize(rows);
  await writeFile(join(outdir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`results: ${outdir}`);
  if (options.keepTemp) console.log(`isolated CODEX_HOME: ${tempRoot}`);
  else await rm(tempRoot, { recursive: true, force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
