import { afterEach, expect, it, vi } from 'vitest';
const store = { findEntitiesByName: vi.fn(), findEntityByQualifiedName: vi.fn(), getImpactSet: vi.fn(), getEntity: vi.fn() };
vi.mock('../../src/registry/sqliteStore.js', () => ({ getRegistryStore: () => store, closeRegistryStore: vi.fn() }));
import { handlePreflight } from '../../src/cli/preflightHandler.js';
afterEach(() => { vi.restoreAllMocks(); Object.values(store).forEach(mock => mock.mockReset()); process.exitCode = undefined; });
it('turns graph candidates into a strict review checklist', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  store.findEntitiesByName.mockReturnValue([{ id: 'root', name: 'target', qualifiedName: 'src/a.ts::target', filePath: 'src/a.ts', riskLevel: 'low', hasTests: true, warnings: [] }]);
  store.getImpactSet.mockReturnValue([{ id: 'child', name: 'child', filePath: 'src/b.ts', depth: 1 }]);
  store.getEntity.mockReturnValue({ qualifiedName: 'src/b.ts::child', riskLevel: 'high', hasTests: false, warnings: [{ resolved: false }] });
  await handlePreflight('target', { project: 'p', json: true, strict: true });
  const result = JSON.parse(log.mock.calls[0][0] as string);
  expect(result.review.highRisk).toEqual(['src/b.ts::child']);
  expect(result.review.required[0]).toContain('seed');
  expect(process.exitCode).toBe(1);
});
it('includes the selected target in strict review gates without callers', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  store.findEntitiesByName.mockReturnValue([{
    id: 'root', name: 'target', qualifiedName: 'src/a.ts::target', filePath: 'src/a.ts',
    riskLevel: 'high', hasTests: false, warnings: [{ resolved: false }],
  }]);
  store.getImpactSet.mockReturnValue([]);
  await handlePreflight('target', { project: 'p', json: true, strict: true });
  const result = JSON.parse(log.mock.calls[0][0] as string);
  expect(result.candidates).toEqual([expect.objectContaining({ qualifiedName: 'src/a.ts::target', depth: 0 })]);
  expect(result.review).toMatchObject({
    highRisk: ['src/a.ts::target'],
    untested: ['src/a.ts::target'],
    unresolvedWarnings: ['src/a.ts::target'],
  });
  expect(result.pass).toBe(false);
  expect(process.exitCode).toBe(1);
});
it('rejects ambiguous targets before impact lookup', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  store.findEntitiesByName.mockReturnValue([{ qualifiedName: 'a::x' }, { qualifiedName: 'b::x' }]);
  await handlePreflight('x', { project: 'p', json: true });
  expect(JSON.parse(log.mock.calls[0][0] as string).error).toBe('ambiguous');
  expect(store.getImpactSet).not.toHaveBeenCalled();
});
