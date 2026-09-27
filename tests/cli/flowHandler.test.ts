import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepository } from '../../src/registry/entityScanner.js';
import { getRegistryStore, closeRegistryStore } from '../../src/registry/sqliteStore.js';
import { handleFlow } from '../../src/cli/flowHandler.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cxt-flow-cli-')); closeRegistryStore(); getRegistryStore(join(dir, 'registry.db')); });
afterEach(() => { closeRegistryStore(); vi.restoreAllMocks(); process.exitCode = undefined; rmSync(dir, { recursive: true, force: true }); });

describe('dataflow CLI', () => {
  it('reads stored definitions and source locations, with partial and absent exit codes', async () => {
    writeFileSync(join(dir, 'x.ts'), 'function complete(input){let saved=input;input=2;return saved;}\nfunction* partial(){yield work();}\nconst value=1;');
    const result = await scanRepository(dir, 'flow-cli', { parser: 'ast' });
    expect(result.errors).toEqual([]);
    expect(result.dataflow).toMatchObject({ total: 2, complete: 1, partial: 1 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleFlow('complete', { project: 'flow-cli', json: true, strict: true });
    const parsed = JSON.parse(log.mock.calls[0][0]);
    expect(parsed).toMatchObject({ owner: 'x.ts::complete', completeness: 'complete', filePath: 'x.ts' });
    expect(parsed.returns[0].value.parameters[0]).toMatch(/:input$/);
    expect(parsed.locations[parsed.returns[0].node].line).toBe(1);
    expect(process.exitCode).toBeUndefined();
    getRegistryStore(join(dir, 'registry.db')); log.mockClear();
    await handleFlow('partial', { project: 'flow-cli', json: true, strict: true });
    expect(JSON.parse(log.mock.calls[0][0]).diagnostics.some((d: { code: string }) => d.code === 'partial-cfg')).toBe(true);
    expect(process.exitCode).toBe(2);
    getRegistryStore(join(dir, 'registry.db')); log.mockClear();
    await handleFlow('value', { project: 'flow-cli', json: true });
    expect(JSON.parse(log.mock.calls[0][0]).error).toBe('dataflow_unavailable');
    expect(process.exitCode).toBe(1);
  });
});
