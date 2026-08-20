import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { handleAudit } from '../../src/cli/auditHandler.js';
import { getRegistryStore, closeRegistryStore } from '../../src/registry/sqliteStore.js';

let projectDir: string;
let dbDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let logs: string[];
let prevExitCode: number | undefined;

function captureLogs() {
  logs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  });
}

function flushed(): string {
  return logs.join('\n');
}

function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function write(rel: string, content: string): void {
  const abs = join(projectDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  closeRegistryStore();
  prevExitCode = process.exitCode;
  process.exitCode = undefined;

  projectDir = mkdtempSync(join(tmpdir(), 'cxt-audit-proj-'));
  dbDir = mkdtempSync(join(tmpdir(), 'cxt-audit-db-'));

  // package.json + tsconfig.json → ts 트랙으로 감지되어야 함
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'aud-proj' }));
  writeFileSync(join(projectDir, 'tsconfig.json'), '{}');

  const store = getRegistryStore(join(dbDir, 'registry.db'));
  store.registerEntity({
    projectId: 'aud-proj',
    kind: 'function',
    name: 'clean',
    filePath: 'src/clean.ts',
    lineStart: 1,
    riskLevel: 'low',
    hasTests: true,
    complexityScore: 1,
  });
  store.registerEntity({
    projectId: 'aud-proj',
    kind: 'function',
    name: 'untestedFn',
    filePath: 'src/untested.ts',
    lineStart: 1,
    riskLevel: 'low',
    hasTests: false,
    complexityScore: 2,
  });

  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
});

afterEach(() => {
  logSpy?.mockRestore();
  cwdSpy.mockRestore();
  closeRegistryStore();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
  process.exitCode = prevExitCode;
});

describe('handleAudit — JSON mode', () => {
  it('emits valid JSON with tracks, bs, registry and pass=true on clean repo', async () => {
    write('src/clean.ts', 'export const x = 1;\n');
    captureLogs();

    await handleAudit({ json: true });
    const parsed = JSON.parse(flushed());

    expect(parsed.project).toBe('aud-proj');
    expect(parsed.tracks).toContain('ts');
    expect(parsed.bs.critical).toBe(0);
    expect(parsed.pass).toBe(true);
    expect(parsed.registry.total).toBe(2);
    expect(parsed.registry.untested).toBe(1);
    expect(process.exitCode).not.toBe(1);
  });

  it('sets pass=false and exitCode 1 when a critical BS issue exists', async () => {
    // 하드코딩된 시크릿 → critical (빈 catch는 INT-1486 이후 warning)
    write('src/dirty.ts', 'const apiKey = "sk_live_abcdef1234567890";\n');
    captureLogs();

    await handleAudit({ json: true });
    const parsed = JSON.parse(flushed());

    expect(parsed.bs.critical).toBeGreaterThanOrEqual(1);
    expect(parsed.pass).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

describe('handleAudit — human report', () => {
  it('prints header, track, BS score, and registry section', async () => {
    write('src/clean.ts', 'export const x = 1;\n');
    captureLogs();

    await handleAudit({});
    const out = plain(flushed());

    expect(out).toMatch(/코드 감사|Code Audit/);
    expect(out).toContain('aud-proj');
    expect(out).toMatch(/트랙:|Tracks:/);
    expect(out).toMatch(/BS 점수:|BS Score:/);
    // registry 섹션 (untested 1)
    expect(out).toMatch(/테스트 없음:|Untested:/);
  });

  it('--quick skips the registry section', async () => {
    write('src/clean.ts', 'export const x = 1;\n');
    captureLogs();

    await handleAudit({ quick: true });
    const out = plain(flushed());

    expect(out).toMatch(/BS 점수:|BS Score:/);
    expect(out).not.toMatch(/레지스트리 현황|Registry Status/);
  });
});

describe('handleAudit — dir filter', () => {
  it('restricts BS issues to the given directory prefix', async () => {
    write('src/keep/dirty.ts', 'const apiKey = "sk_live_abcdef1234567890";\n');
    write('other/also-dirty.ts', 'const token = "ghp_zzzzzzzzzzzzzzzzzzzz";\n');
    captureLogs();

    await handleAudit({ json: true, dir: 'src/keep' });
    const parsed = JSON.parse(flushed());

    expect(parsed.bs.critical).toBe(1);
  });
});
