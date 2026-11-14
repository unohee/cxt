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
  it('shows applied model assumptions and rejection status in JSON and text', async () => {
    writeFileSync(join(dir, '.cxt-models.json'), JSON.stringify({ schemaVersion: 1, versions: { node: '22.19.0' }, assumptions: ['unmodified-external-bindings'] }));
    writeFileSync(join(dir, 'x.ts'), "import {basename} from 'node:path';function f(){return basename('x');}function g(input){return basename(input);}");
    await scanRepository(dir, 'p', { parser: 'ast' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleFlow('f', { project: 'p', json: true, strict: true });
    const parsed = JSON.parse(log.mock.calls[0][0]);
    expect(parsed.calls[0].model.status).toBe('applied');
    expect(parsed.summary.models[0].targetVersion).toBe('22.19.0');
    expect(parsed.modelManifest.versionSource).toBe('project-declaration');
    expect(process.exitCode).toBeUndefined();
    getRegistryStore(join(dir, 'registry.db')); log.mockClear();
    await handleFlow('f', { project: 'p' });
    expect(log.mock.calls.flat().join('\n')).toContain('assumption=unmodified-external-bindings');
    getRegistryStore(join(dir, 'registry.db')); log.mockClear();
    await handleFlow('g', { project: 'p', json: true, strict: true });
    expect(JSON.parse(log.mock.calls[0][0]).calls[0].model.status).toBe('argument-domain');
    expect(process.exitCode).toBe(2);
  });

  it('distinguishes converged local facts from a partial or missing interprocedural summary', async () => {
    writeFileSync(join(dir, 'x.ts'), 'function f(input){return external(input);}');
    await scanRepository(dir, 'p', { parser: 'ast' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleFlow('f', { project: 'p', json: true, strict: true });
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ completeness: 'complete', summary: { completeness: 'partial' }, analysisCompleteness: 'partial' });
    expect(process.exitCode).toBe(2);
    getRegistryStore(join(dir, 'registry.db')).replaceSummariesForProject('p', []);
    log.mockClear(); process.exitCode = undefined;
    await handleFlow('f', { project: 'p', json: true, strict: true });
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ summary: null, analysisCompleteness: 'partial' });
    expect(process.exitCode).toBe(2);
  });

  it('reads stored definitions and source locations, with partial and absent exit codes', async () => {
    writeFileSync(join(dir, 'x.ts'), 'function complete(input){let saved=input;input=2;return saved;}\nfunction partial(){with (resource) {work();}}\nconst value=1;');
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

  it('exports semantic resource provenance as SARIF code flows', async () => {
    writeFileSync(join(dir, '.cxt-models.json'), JSON.stringify({ schemaVersion: 1,
      versions: { 'npm:resource-api': '1.0.0' }, assumptions: ['unmodified-external-bindings'], packs: ['models.json'] }));
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ schemaVersion: 1, id: 'resource-pack', version: '1.0.0', models: [
      { id: 'acquire', language: 'typescript', module: 'resource-api', symbol: 'acquire', package: 'npm:resource-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['string'], returns: { type: 'unknown', dependsOn: [] }, effects: 'none',
        resource: { action: 'acquire', identity: 'return' }, throws: { possible: false, dependsOn: [] }, source: 'https://example.com/resource' },
      { id: 'release', language: 'typescript', module: 'resource-api', symbol: 'release', package: 'npm:resource-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['any'], returns: { type: 'unit', dependsOn: [] }, effects: 'none',
        resource: { action: 'release', identity: 'argument', parameter: 0 }, throws: { possible: false, dependsOn: [] }, source: 'https://example.com/resource' },
    ] }));
    writeFileSync(join(dir, 'x.ts'), "import {acquire, release} from 'resource-api'; function f(){const h=acquire('x'); release(h); return h.read();}");
    await scanRepository(dir, 'p', { parser: 'ast' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleFlow('f', { project: 'p', sarif: true });
    const sarif = JSON.parse(log.mock.calls[0][0]);
    expect(sarif.runs[0].results.map((result: { ruleId: string }) => result.ruleId)).toContain('cxt/resource-use-after-release');
    expect(sarif.runs[0].results.find((result: { ruleId: string }) => result.ruleId === 'cxt/resource-use-after-release').codeFlows[0].threadFlows[0].locations.length).toBeGreaterThan(1);
    expect(process.exitCode).toBe(2);
  });
});
