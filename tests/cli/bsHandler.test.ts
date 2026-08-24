import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { handleBs } from '../../src/cli/bsHandler.js';

let projectDir: string;
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
  prevExitCode = process.exitCode;
  process.exitCode = undefined;
  projectDir = mkdtempSync(join(tmpdir(), 'cxt-bs-cli-'));
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'bs-proj' }));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
});

afterEach(() => {
  logSpy?.mockRestore();
  cwdSpy.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
  process.exitCode = prevExitCode;
});

// `cxt bs` routes through this handler, not through checkHandler. A rationale that
// reaches the detector but not this serializer is invisible to every caller, so the
// wiring is asserted at the CLI boundary rather than only at the detector.
describe('handleBs — critical rationale reaches the CLI surface', () => {
  it('serializes the rationale in JSON mode', async () => {
    write('src/auth.ts', 'const api_key = "live-secret-123456789";\n');
    captureLogs();

    await handleBs({ json: true });
    const parsed = JSON.parse(flushed());

    const issue = parsed.issues.find((i: { category: string }) => i.category === 'hardcoded_secret');
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('critical');
    expect(issue.rationale).toBeTruthy();
  });

  it('prints the rationale under the finding in text mode', async () => {
    write('src/auth.ts', 'const api_key = "live-secret-123456789";\n');
    captureLogs();

    await handleBs({});
    const out = plain(flushed());

    expect(out).toContain('src/auth.ts:1');
    expect(out).toMatch(/version history|형상 이력/);
  });

  it('omits the rationale field for non-critical findings', async () => {
    write('src/noisy.ts', 'console.log("hi");\n');
    captureLogs();

    await handleBs({ json: true });
    const parsed = JSON.parse(flushed());

    const nonCritical = parsed.issues.filter((i: { severity: string }) => i.severity !== 'critical');
    expect(nonCritical.length).toBeGreaterThan(0);
    expect(nonCritical.every((i: { rationale?: string }) => i.rationale === undefined)).toBe(true);
  });
});
