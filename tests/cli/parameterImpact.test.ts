import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepository } from '../../src/registry/entityScanner.js';
import { getRegistryStore, closeRegistryStore } from '../../src/registry/sqliteStore.js';
import { handleImpact } from '../../src/cli/relationHandler.js';
import { handlePreflight } from '../../src/cli/preflightHandler.js';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cxt-param-cli-')); closeRegistryStore(); getRegistryStore(join(dir, 'registry.db')); });
afterEach(() => { closeRegistryStore(); vi.restoreAllMocks(); process.exitCode = undefined; rmSync(dir, { recursive: true, force: true }); });

describe('stored parameter impact CLI', () => {
  it('uses persisted summaries and definition paths in impact and preflight', async () => {
    writeFileSync(join(dir, 'x.ts'), 'function id(input){return input;}function used(x){return id(x);}function discarded(x){id(x);return 0;}');
    expect((await scanRepository(dir, 'p', { parser: 'ast' })).errors).toEqual([]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleImpact('id', { project: 'p', json: true, param: 'input', explain: true, strict: true });
    const impact = JSON.parse(log.mock.calls[0][0]);
    expect(impact).toMatchObject({ mode: 'parameter-value-impact', completeness: 'complete', impactCount: 1 });
    expect(impact.impacted[0].path[0].span.line).toBe(1);
    expect(process.exitCode).toBeUndefined();
    getRegistryStore(join(dir, 'registry.db')); log.mockClear();
    await handlePreflight('id', { project: 'p', json: true, param: 'input', explain: true, strict: true });
    const preflight = JSON.parse(log.mock.calls[0][0]);
    expect(preflight.candidates.map((c: { name: string }) => c.name)).toEqual(['id', 'used']);
    expect(preflight.valueFlow.impacted[0].path[0].evidence).toBe('return');
    expect(process.exitCode).toBe(1);
  });

  it('uses exit 2 for incomplete semantic evidence and exit 1 for invalid parameters', async () => {
    writeFileSync(join(dir, 'x.ts'), 'function id(input){return external(input);}function caller(x){return id(x);}');
    await scanRepository(dir, 'p', { parser: 'ast' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handlePreflight('id', { project: 'p', json: true, param: 'input', strict: true });
    expect(JSON.parse(log.mock.calls[0][0]).valueFlow.completeness).toBe('partial');
    expect(process.exitCode).toBe(2);
    getRegistryStore(join(dir, 'registry.db')); log.mockClear();
    await handleImpact('id', { project: 'p', json: true, param: 'absent' });
    expect(JSON.parse(log.mock.calls[0][0]).error).toBe('parameter_analysis_unavailable');
    expect(process.exitCode).toBe(1);
  });
});
