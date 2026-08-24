import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { handleCheck, isBsScanPassing } from '../../src/cli/checkHandler.js';
import { getRegistryStore, closeRegistryStore } from '../../src/registry/sqliteStore.js';

describe('check CI policy', () => {
  it('fails closed on critical findings or incomplete BS scans', () => {
    expect(isBsScanPassing({ critical: 0, errors: [] })).toBe(true);
    expect(isBsScanPassing({ critical: 1, errors: [] })).toBe(false);
    expect(isBsScanPassing({ critical: 0, errors: ['unreadable source'] })).toBe(false);
  });
});

// `check --ci` runs the same detector as `bs` and `audit`. The injected guide
// promises that every critical states why it is critical, so a CI surface that
// serialized only counts would make that promise false on the one path a
// pipeline actually reads.
describe('handleCheck --ci — critical findings and rationale', () => {
  let projectDir: string;
  let dbDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];
  let prevExitCode: number | undefined;

  function write(rel: string, content: string): void {
    const abs = join(projectDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  beforeEach(() => {
    closeRegistryStore();
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
    projectDir = mkdtempSync(join(tmpdir(), 'cxt-ci-proj-'));
    dbDir = mkdtempSync(join(tmpdir(), 'cxt-ci-db-'));
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'ci-proj' }));
    getRegistryStore(join(dbDir, 'registry.db'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
    });
  });

  afterEach(() => {
    logSpy?.mockRestore();
    cwdSpy.mockRestore();
    closeRegistryStore();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
    process.exitCode = prevExitCode;
  });

  it('serializes each critical with its rationale', async () => {
    write('src/auth.ts', 'const api_key = "live-secret-123456789";\n');

    await handleCheck(undefined, { ci: true });
    const parsed = JSON.parse(logs.join('\n'));

    expect(parsed.bs.critical).toBe(1);
    expect(parsed.bs.criticals).toHaveLength(1);
    const [finding] = parsed.bs.criticals;
    expect(finding.file).toBe('src/auth.ts');
    expect(finding.line).toBe(1);
    expect(finding.category).toBe('hardcoded_secret');
    expect(finding.rationale).toBeTruthy();
    expect(parsed.pass).toBe(false);
  });

  it('reports an empty criticals list on a clean repository', async () => {
    write('src/clean.ts', 'export const x = 1;\n');

    await handleCheck(undefined, { ci: true });
    const parsed = JSON.parse(logs.join('\n'));

    expect(parsed.bs.critical).toBe(0);
    expect(parsed.bs.criticals).toEqual([]);
    expect(parsed.pass).toBe(true);
  });
});
