import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBs } from '../../src/cli/bsHandler.js';
import { handleAudit } from '../../src/cli/auditHandler.js';
import { handleScan } from '../../src/cli/scanHandler.js';
import { getRegistryStore, closeRegistryStore } from '../../src/registry/sqliteStore.js';

let root: string, logs: string[], oldExit: typeof process.exitCode;
beforeEach(() => {
  oldExit = process.exitCode; process.exitCode = undefined; closeRegistryStore();
  root = mkdtempSync(join(tmpdir(), 'cxt-report-contract-'));
  mkdirSync(join(root, 'src')); getRegistryStore(join(root, 'facts.db'));
  vi.spyOn(process, 'cwd').mockReturnValue(root); logs = [];
  vi.spyOn(console, 'log').mockImplementation(message => { logs.push(String(message)); });
});
afterEach(() => {
  vi.restoreAllMocks(); closeRegistryStore(); process.exitCode = oldExit;
  rmSync(root, { recursive: true, force: true });
});
const output = () => JSON.parse(logs.join('\n'));
function reset() { logs.length = 0; process.exitCode = undefined; getRegistryStore(join(root, 'facts.db')); }

describe('CLI analysis output contract', () => {
  it('prints equivalent BS findings in JSON/SARIF and visible text while verbose preserves machine output', async () => {
    writeFileSync(join(root, 'src', 'x.py'), 'def read():\n print(x)\n x=1');
    await handleBs({ json: true, verbose: true });
    const json = output(); expect(process.exitCode).toBe(1);
    reset(); await handleBs({ sarif: true, verbose: true });
    const sarif = output(); expect(process.exitCode).toBe(1);
    expect(sarif.runs[0].results.map((r: { ruleId: string }) => r.ruleId)).toEqual(json.issues.map((r: { ruleId: string }) => r.ruleId));
    expect(sarif.runs[0].results[0].partialFingerprints.primaryLocationLineHash).toBe(json.issues[0].fingerprint);
    reset(); await handleBs({}); expect(logs.join('\n')).toContain('src/x.py:2'); expect(process.exitCode).toBe(1);
    reset(); await handleAudit({ json: true, quick: true });
    expect(output().issues[0].ruleId).toBe(json.issues[0].ruleId);
    // audit의 warning은 정책 실패가 아니지만 finding은 동일하게 보존한다.
    expect(output().outcome).toMatchObject({ status: 'complete', findingsFail: false, pass: true });
    reset(); await handleAudit({ sarif: true, quick: true });
    expect(output().runs[0].results).toEqual(sarif.runs[0].results);
  });

  it.each(['bs', 'audit'] as const)('%s reports partial, syntax failure and configuration failure with distinct exit codes', async command => {
    const run = command === 'bs' ? handleBs : handleAudit;
    writeFileSync(join(root, 'src', 'x.ts'), 'function* f(){yield 1;}');
    await run({ json: true }); expect(output().outcome).toMatchObject({ status: 'partial', exitCode: 2, pass: false }); expect(process.exitCode).toBe(2);
    reset(); writeFileSync(join(root, 'src', 'x.ts'), 'function broken(');
    await run({ sarif: true }); expect(output().runs[0].invocations[0]).toMatchObject({ executionSuccessful: false, exitCode: 3 }); expect(process.exitCode).toBe(3);
    reset(); writeFileSync(join(root, '.cxt-rules.json'), '{');
    await run({ json: true }); expect(output().outcome.status).toBe('failed'); expect(process.exitCode).toBe(3);
  });

  it('reports actual scan completeness/failure in JSON and SARIF, preserving the prior snapshot on syntax failure', async () => {
    writeFileSync(join(root, 'src', 'x.ts'), 'export function read(x){return x;}');
    await handleScan({ json: true, project: 'p', verbose: true });
    expect(output().outcome).toMatchObject({ status: 'complete', exitCode: 0 }); expect(output().registered).toBe(1);
    reset(); writeFileSync(join(root, 'src', 'x.ts'), 'export function* read(){yield 1;}');
    await handleScan({ sarif: true, project: 'p' }); expect(output().runs[0].invocations[0].exitCode).toBe(2);
    reset(); writeFileSync(join(root, 'src', 'x.ts'), 'function broken(');
    await handleScan({ json: true, project: 'p' }); expect(output().outcome).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(getRegistryStore(join(root, 'facts.db')).getStats('p').total).toBe(1);
    await expect(handleBs({ json: true, sarif: true })).rejects.toThrow('mutually exclusive');
  });
});
