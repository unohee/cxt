import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCheck, resolveProjectId } from '../../src/cli/checkHandler.js';
import {
  getRegistryStore,
  closeRegistryStore,
} from '../../src/registry/sqliteStore.js';

let projectDir: string;
let dbDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let logs: string[];

function captureLogs() {
  logs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' '));
  });
}

function flushed(): string {
  return logs.join('\n');
}

// Strip ANSI for stable matching
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

beforeEach(() => {
  closeRegistryStore();
  projectDir = mkdtempSync(join(tmpdir(), 'cxt-check-proj-'));
  dbDir = mkdtempSync(join(tmpdir(), 'cxt-check-db-'));

  // package.json so resolveProjectId returns a stable id
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'proj-a' }),
  );

  const store = getRegistryStore(join(dbDir, 'registry.db'));

  // Seed proj-a (current cwd) with 2 entities
  store.registerEntity({
    projectId: 'proj-a',
    kind: 'function',
    name: 'aHelper',
    filePath: 'src/a.ts',
    lineStart: 1,
    riskLevel: 'low',
    hasTests: true,
    complexityScore: 1,
  });
  store.registerEntity({
    projectId: 'proj-a',
    kind: 'class',
    name: 'AService',
    filePath: 'src/a.ts',
    lineStart: 30,
    riskLevel: 'low',
    hasTests: false,
    complexityScore: 2,
  });

  // Seed an unrelated project — must NOT show up in default --stats
  for (let i = 0; i < 5; i++) {
    store.registerEntity({
      projectId: 'proj-b',
      kind: 'function',
      name: `bFn${i}`,
      filePath: `src/b${i}.ts`,
      lineStart: 1,
      riskLevel: 'high',
      hasTests: false,
      complexityScore: 9,
    });
  }

  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
});

afterEach(() => {
  logSpy?.mockRestore();
  cwdSpy.mockRestore();
  closeRegistryStore();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

describe('resolveProjectId', () => {
  it('reads name from package.json and strips npm scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cxt-resolve-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@scope/foo' }));
    expect(resolveProjectId(dir)).toBe('foo');
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to folder name when no manifest exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cxt-resolve-bare-'));
    const id = resolveProjectId(dir);
    expect(id).toBe(dir.split('/').pop());
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('handleCheck --stats', () => {
  it('defaults to current project scope (does not aggregate other projects)', async () => {
    captureLogs();
    await handleCheck(undefined, { stats: true });
    const out = plain(flushed());

    // proj-a has 2 entities; proj-b's 5 must be excluded
    expect(out).toMatch(/전체 엔티티:\s*2|Total entities:\s*2/);
    // Scope label visible
    expect(out).toContain('proj-a');
    // Must NOT show proj-b's high-risk count
    expect(out).not.toMatch(/고위험:\s*5|High risk:\s*5/);
  });

  it('--global aggregates across all projects', async () => {
    captureLogs();
    await handleCheck(undefined, { stats: true, global: true });
    const out = plain(flushed());

    // proj-a (2) + proj-b (5) = 7
    expect(out).toMatch(/전체 엔티티:\s*7|Total entities:\s*7/);
    // proj-b high-risk visible
    expect(out).toMatch(/고위험:\s*5|High risk:\s*5/);
    // Scope label flips to global
    expect(out).toMatch(/전체 프로젝트|ALL projects/);
  });

  it('explicit --project overrides cwd-based default', async () => {
    captureLogs();
    await handleCheck(undefined, { stats: true, project: 'proj-b' });
    const out = plain(flushed());

    expect(out).toMatch(/전체 엔티티:\s*5|Total entities:\s*5/);
    expect(out).toContain('proj-b');
  });
});
