import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { createTmpStore, type TmpDbHandle } from '../helpers/tmpDb.js';
import { SqliteRegistryStore } from '../../src/registry/sqliteStore.js';
import type { ResolvedCallSite } from '../../src/analysis/symbols.js';

let h: TmpDbHandle;
beforeEach(() => { h = createTmpStore(); });
afterEach(() => { h.cleanup(); });

function register(projectId = 'p1', name = 'run') {
  return h.store.registerEntity({ projectId, name, kind: 'function', filePath: 'x.ts' });
}
function call(overrides: Partial<ResolvedCallSite> = {}): ResolvedCallSite {
  return { filePath: 'x.ts', caller: 'x.ts::run', target: 'x.ts::run', scope: 1,
    callee: { kind: 'name', name: 'run' }, expression: 'run', line: 2, column: 3,
    endLine: 2, endColumn: 8, offset: 20, resolution: 'resolved', reason: 'lexical-binding', confidence: 1,
    ...overrides };
}

describe('source-located call facts', () => {
  it('round-trips recursive, unresolved, external and module calls across reopen', () => {
    const entity = register();
    const sites = [call(), call({ line: 3, endLine: 3, target: undefined, resolution: 'unresolved', reason: 'dynamic-call', confidence: 0 }),
      call({ line: 4, endLine: 4, caller: undefined, target: undefined, resolution: 'external', reason: 'external-module', confidence: 0 })];
    h.store.replaceCallSitesForProject('p1', sites);
    h.store.close();
    h.store = new SqliteRegistryStore(join(h.dir, 'registry.db'));
    expect(h.store.getCallSites('p1')).toEqual(sites);
    expect(h.store.getCallSites('p1', entity.id)).toHaveLength(2);
    expect(h.store.getCallSiteRelations('p1')).toEqual([{ sourceId: entity.id, targetId: entity.id, relationType: 'calls' }]);
    h.store.close();
  });

  it('keeps project boundaries even when qualified names collide', () => {
    const one = register();
    const two = register('p2');
    register('p2', 'foreign');
    h.store.replaceCallSitesForProject('p1', [call()]);
    h.store.replaceCallSitesForProject('p2', [call()]);
    expect(h.store.getCallSiteRelations('p1')[0].targetId).toBe(one.id);
    expect(h.store.getCallSiteRelations('p2')[0].targetId).toBe(two.id);
    expect(h.store.getCallSites('p1', two.id)).toEqual([]);
    expect(() => h.store.replaceCallSitesForProject('p1', [call({ target: 'x.ts::foreign' })])).toThrow('Unregistered call-site target');
    expect(h.store.getCallSites('p1')).toEqual([call()]);
    h.store.deleteProject('p1');
    expect(h.store.getCallSites('p2')).toEqual([call()]);
  });

  it('rolls back replacement on missing owner, duplicate span or invalid state', () => {
    register();
    h.store.replaceCallSitesForProject('p1', [call()]);
    for (const invalid of [
      [call(), call({ line: 3, endLine: 3, caller: 'x.ts::missing' })],
      [call(), call()],
      [call({ target: undefined })],
      [call({ confidence: 2 })],
    ]) {
      expect(() => h.store.replaceCallSitesForProject('p1', invalid)).toThrow();
      expect(h.store.getCallSites('p1')).toEqual([call()]);
    }
  });

  it('deletes calls when their caller is removed and deletes ownerless rows with the project', () => {
    const entity = register();
    h.store.replaceCallSitesForProject('p1', [call(), call({ line: 3, endLine: 3, caller: undefined, target: undefined,
      resolution: 'unresolved', reason: 'unbound-name', confidence: 0 })]);
    h.store.removeEntity(entity.id);
    expect(h.store.getCallSites('p1')).toHaveLength(1);
    h.store.deleteProject('p1');
    expect(h.store.getCallSites('p1')).toEqual([]);
  });

  it('migrates v3 without rebuilding entity rows or losing FTS data', () => {
    const entity = register();
    h.store.close();
    const path = join(h.dir, 'registry.db');
    const raw = new Database(path);
    const row = raw.prepare('SELECT rowid, id FROM code_entities').get();
    raw.exec('DROP TABLE code_call_sites');
    raw.pragma('user_version = 3');
    raw.close();
    const reopened = new SqliteRegistryStore(path);
    try {
      expect(reopened.getEntity(entity.id)?.name).toBe('run');
      expect(reopened.searchEntities('run', 20, 'p1')).toHaveLength(1);
      expect(reopened.getCallSites('p1')).toEqual([]);
      reopened.replaceCallSitesForProject('p1', [call()]);
      expect(reopened.getCallSites('p1')).toEqual([call()]);
      const check = new Database(path, { readonly: true });
      try {
        expect(check.pragma('user_version', { simple: true })).toBe(6);
        expect(check.prepare('SELECT rowid, id FROM code_entities').get()).toEqual(row);
        expect(check.pragma('foreign_key_check')).toEqual([]);
      } finally { check.close(); }
    } finally { reopened.close(); }
  });
});
