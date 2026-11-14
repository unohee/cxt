import { afterEach, describe, expect, it, vi } from 'vitest';

const store = {
  findEntitiesByName: vi.fn(),
  findEntityByQualifiedName: vi.fn(),
  getIncomingRelations: vi.fn(),
  getOutgoingRelations: vi.fn(),
  getCallSites: vi.fn(),
  getImpactSet: vi.fn(),
};

vi.mock('../../src/registry/sqliteStore.js', () => ({
  getRegistryStore: () => store,
  closeRegistryStore: vi.fn(),
}));

import { handleCalls, handleImpact, handleWhoCalls } from '../../src/cli/relationHandler.js';

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of Object.values(store)) mock.mockReset();
  process.exitCode = undefined;
});

describe('relation handler safety', () => {
  it('includes unresolved sites in JSON and escapes their expressions in text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    store.findEntitiesByName.mockReturnValue([{ id: 'id', name: 'run', qualifiedName: 'x.ts::run', filePath: 'x.ts', lineStart: 1 }]);
    store.getOutgoingRelations.mockReturnValue([]);
    const sites = [{ expression: '\u001b]52;clipboard\u0007unknown', resolution: 'unresolved', reason: 'unbound-name', filePath: 'x.ts', line: 2, column: 3 }];
    store.getCallSites.mockReturnValue(sites);
    await handleCalls('run', { project: 'p', json: true });
    expect(JSON.parse(log.mock.calls[0][0]).callSites).toEqual(sites);
    log.mockClear();
    await handleCalls('run', { project: 'p' });
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('unresolved: unbound-name');
    expect(output).not.toContain('\u001b]52;clipboard');
  });

  it('rejects unsupported relation type filters before querying the registry', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleWhoCalls('target', { project: 'p', type: 'invalid', json: true });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('invalid_relation_type'));
    expect(store.findEntitiesByName).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('strips terminal controls from registry-derived human output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    store.findEntitiesByName.mockReturnValue([{
      id: 'target-id', name: '\u001b]52;clipboard\u0007target', qualifiedName: 'src/a.ts::target',
      filePath: 'src/\u001b[31ma.ts', lineStart: 1,
    }]);
    store.getIncomingRelations.mockReturnValue([{
      sourceName: '\u001b[31mcaller', sourceFile: 'src/\u001b]0;title\u0007b.ts', relationType: 'calls',
    }]);

    await handleWhoCalls('target', { project: 'p' });

    const output = log.mock.calls.flat().join('\n');
    expect(output).not.toContain('\u001b]52;clipboard');
    expect(output).not.toContain('\u001b]0;title');
    expect(output).toContain('caller');
  });

  it.each(['', '0', '-1', '3junk', '101', '999999999999999999999'])('rejects invalid impact depth %j', async (depth) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleImpact('target', { project: 'p', depth, json: true });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('invalid_depth'));
    expect(store.findEntitiesByName).not.toHaveBeenCalled();
    expect(store.getImpactSet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
