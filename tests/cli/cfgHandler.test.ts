import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepository } from '../../src/registry/entityScanner.js';
import { getRegistryStore, closeRegistryStore } from '../../src/registry/sqliteStore.js';
import { handleCfg } from '../../src/cli/cfgHandler.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cxt-cfg-cli-')); closeRegistryStore(); getRegistryStore(join(dir, 'registry.db')); });
afterEach(() => { closeRegistryStore(); vi.restoreAllMocks(); process.exitCode = undefined; rmSync(dir, { recursive: true, force: true }); });

describe('CFG CLI', () => {
  it('reads source-located stored graphs and distinguishes partial from absent', async () => {
    writeFileSync(join(dir, 'x.ts'), 'function complete(x){if(x) return 1; return 2;}\nfunction partial(){with (resource) {work();}}\nconst value=1;');
    const result = await scanRepository(dir, 'cfg-cli', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    expect(result.controlFlow).toMatchObject({ total: 2, complete: 1, partial: 1 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleCfg('complete', { project: 'cfg-cli', json: true, strict: true });
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ owner: 'x.ts::complete', completeness: 'complete', structuralComplexity: 2 });
    expect(process.exitCode).toBeUndefined();
    getRegistryStore(join(dir, 'registry.db')); log.mockClear();
    await handleCfg('partial', { project: 'cfg-cli', json: true, strict: true });
    expect(JSON.parse(log.mock.calls[0][0]).diagnostics[0].code).toBe('unsupported-control');
    expect(process.exitCode).toBe(2);
    getRegistryStore(join(dir, 'registry.db')); log.mockClear();
    await handleCfg('value', { project: 'cfg-cli', json: true });
    expect(JSON.parse(log.mock.calls[0][0]).error).toBe('cfg_unavailable');
    expect(process.exitCode).toBe(1);
  });
});
