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
    writeFileSync(join(root, 'src', 'x.ts'), 'function f(){with (resource) {work();}}');
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
    reset(); writeFileSync(join(root, 'src', 'x.ts'), 'export function read(){with (resource) {work();}}');
    await handleScan({ sarif: true, project: 'p' }); expect(output().runs[0].invocations[0].exitCode).toBe(2);
    reset(); writeFileSync(join(root, 'src', 'x.ts'), 'function broken(');
    await handleScan({ json: true, project: 'p' }); expect(output().outcome).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(getRegistryStore(join(root, 'facts.db')).getStats('p').total).toBe(1);
    await expect(handleBs({ json: true, sarif: true })).rejects.toThrow('mutually exclusive');
  });

  it('includes current committed semantic flow findings in scan SARIF', async () => {
    writeFileSync(join(root, '.cxt-models.json'), JSON.stringify({ schemaVersion: 1,
      versions: { 'npm:resource-api': '1.0.0' }, assumptions: ['unmodified-external-bindings'], packs: ['models.json'] }));
    writeFileSync(join(root, 'models.json'), JSON.stringify({ schemaVersion: 1, id: 'resource-pack', version: '1.0.0', models: [
      { id: 'acquire', language: 'typescript', module: 'resource-api', symbol: 'acquire', package: 'npm:resource-api', versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['string'], returns: { type: 'unknown', dependsOn: [] }, effects: 'none', resource: { action: 'acquire', identity: 'return' }, throws: { possible: false, dependsOn: [] }, source: 'https://example.com/resource' },
      { id: 'release', language: 'typescript', module: 'resource-api', symbol: 'release', package: 'npm:resource-api', versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['any'], returns: { type: 'unit', dependsOn: [] }, effects: 'none', resource: { action: 'release', identity: 'argument', parameter: 0 }, throws: { possible: false, dependsOn: [] }, source: 'https://example.com/resource' },
    ] }));
    writeFileSync(join(root, 'src', 'x.ts'), "import {acquire, release} from 'resource-api'; function f(){const h=acquire('x'); release(h); return h.read();}");
    reset(); await handleScan({ sarif: true, project: 'p' });
    const sarif = output();
    expect(sarif.runs[0].results.some((finding: { ruleId: string }) => finding.ruleId === 'cxt/resource-use-after-release')).toBe(true);
    reset(); await handleScan({ project: 'p' });
    expect(logs.join('\n')).toContain('Resources');
  });

  it('fails scan outcome and emits SARIF for explicit modeled taint sinks', async () => {
    writeFileSync(join(root, '.cxt-models.json'), JSON.stringify({ schemaVersion: 1,
      versions: { 'npm:taint-api': '1.0.0' }, assumptions: ['unmodified-external-bindings'], packs: ['models.json'] }));
    const base = { language: 'typescript', module: 'taint-api', package: 'npm:taint-api', versions: { min: '1.0.0', before: '2.0.0' }, effects: 'none', throws: { possible: false, dependsOn: [] }, source: 'https://example.com/taint' };
    writeFileSync(join(root, 'models.json'), JSON.stringify({ schemaVersion: 1, id: 'taint-pack', version: '1.0.0', models: [
      { ...base, id: 'readInput', symbol: 'readInput', parameters: [], returns: { type: 'unknown', dependsOn: [] }, taint: { source: true } },
      { ...base, id: 'execute', symbol: 'execute', parameters: ['any'], returns: { type: 'unit', dependsOn: [] }, taint: { sinkParameters: [0] } },
    ] }));
    writeFileSync(join(root, 'src', 'x.ts'), "import {readInput, execute} from 'taint-api'; function f(){execute(readInput());}");
    await handleScan({ json: true, project: 'p' });
    expect(output().taintFindings).toEqual({ total: 1, proven: 1 });
    expect(output().outcome).toMatchObject({ status: 'partial', exitCode: 2, findingsFail: true, pass: false });
    reset(); writeFileSync(join(root, 'src', 'x.ts'), "import {readInput, execute} from 'taint-api'; function f(){execute(readInput()); with (resource) {work();}}");
    await handleScan({ json: true, project: 'p' });
    expect(output().taintFindings).toEqual({ total: 1, proven: 0 });
    expect(output().outcome).toMatchObject({ status: 'partial', exitCode: 2, findingsFail: false, pass: false });
    reset(); await handleScan({ project: 'p' });
    expect(logs.join('\n')).toContain('1 total (0 proven, 1 possible sink reaches)');
    reset(); await handleScan({ sarif: true, project: 'p' });
    const sarif = output();
    expect(sarif.runs[0].results.some((finding: { ruleId: string }) => finding.ruleId === 'cxt/taint-sink')).toBe(true);
    expect(process.exitCode).toBe(2);
  });
});
