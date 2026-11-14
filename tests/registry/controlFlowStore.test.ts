import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { createTmpStore, type TmpDbHandle } from '../helpers/tmpDb.js';
import { SqliteRegistryStore } from '../../src/registry/sqliteStore.js';
import { extractFile } from '../../src/registry/entityScanner.js';

let h: TmpDbHandle;
beforeEach(() => { h = createTmpStore(); });
afterEach(() => { h.cleanup(); });
const graphs = extractFile('function f(x){if(x) return; work();}', 'x.ts', 'typescript', 'ast').controlFlow!;
function register(projectId = 'p') { return h.store.registerEntity({ projectId, kind: 'function', name: 'f', filePath: 'x.ts' }); }

describe('CFG persistence', () => {
  it('round-trips graphs, isolates projects and rolls back invalid replacement', () => {
    const one = register(); const two = register('other');
    h.store.replaceControlFlowForProject('p', graphs);
    h.store.replaceControlFlowForProject('other', graphs);
    expect(h.store.getControlFlow('p', one.id)).toEqual(graphs);
    expect(h.store.getControlFlow('p', two.id)).toEqual([]);
    expect(() => h.store.replaceControlFlowForProject('p', [{ ...graphs[0], owner: 'x.ts::unknown' }])).toThrow('Unregistered CFG owner');
    expect(h.store.getControlFlow('p')).toEqual(graphs);
    expect(() => h.store.replaceControlFlowForProject('p', [...graphs, ...graphs])).toThrow();
    expect(h.store.getControlFlow('p')).toEqual(graphs);
    h.store.deleteProject('p');
    expect(h.store.getControlFlow('p')).toEqual([]);
    expect(h.store.getControlFlow('other')).toEqual(graphs);
  });

  it('migrates v4 with existing call facts and FTS intact', () => {
    const owner = register();
    h.store.replaceCallSitesForProject('p', [{ filePath: 'x.ts', caller: 'x.ts::f', scope: 1,
      callee: { kind: 'name', name: 'unknown' }, expression: 'unknown', line: 1, column: 10, endLine: 1, endColumn: 19,
      offset: 9, resolution: 'unresolved', reason: 'unbound-name', confidence: 0 }]);
    const sites = h.store.getCallSites('p');
    h.store.close();
    const path = join(h.dir, 'registry.db');
    const raw = new Database(path); raw.exec('DROP TABLE code_control_flow'); raw.pragma('user_version = 4'); raw.close();
    const migrated = new SqliteRegistryStore(path);
    try {
      expect(migrated.getEntity(owner.id)?.qualifiedName).toBe('x.ts::f');
      expect(migrated.getCallSites('p')).toEqual(sites);
      expect(migrated.searchEntities('f', 20, 'p')).toHaveLength(1);
      migrated.replaceControlFlowForProject('p', graphs);
      expect(migrated.getControlFlow('p')).toEqual(graphs);
      const check = new Database(path, { readonly: true });
      try { expect(check.pragma('user_version', { simple: true })).toBe(10); expect(check.pragma('foreign_key_check')).toEqual([]); }
      finally { check.close(); }
    } finally { migrated.close(); }
  });
});
