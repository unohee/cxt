import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { createTmpStore, type TmpDbHandle } from '../helpers/tmpDb.js';
import { SqliteRegistryStore } from '../../src/registry/sqliteStore.js';
import { extractFile } from '../../src/registry/entityScanner.js';
import { analyzeDataflow } from '../../src/analysis/dataflow.js';

let h: TmpDbHandle;
beforeEach(() => { h = createTmpStore(); });
afterEach(() => { h.cleanup(); });
const graphs = extractFile('function f(input){let saved=input;return saved;}', 'x.ts', 'typescript', 'ast').controlFlow!;
const results = graphs.map(graph => analyzeDataflow(graph));
function register(projectId = 'p') { return h.store.registerEntity({ projectId, kind: 'function', name: 'f', filePath: 'x.ts' }); }

describe('dataflow persistence', () => {
  it('round-trips results, isolates projects and rolls back invalid replacement', () => {
    const one = register(); const two = register('other');
    h.store.replaceDataflowForProject('p', results);
    h.store.replaceDataflowForProject('other', results);
    expect(h.store.getDataflow('p', one.id)).toEqual(results);
    expect(h.store.getDataflow('p', two.id)).toEqual([]);
    expect(() => h.store.replaceDataflowForProject('p', [{ ...results[0], owner: 'x.ts::unknown' }])).toThrow('Unregistered dataflow owner');
    expect(h.store.getDataflow('p')).toEqual(results);
    expect(() => h.store.replaceDataflowForProject('p', [...results, ...results])).toThrow();
    expect(h.store.getDataflow('p')).toEqual(results);
    h.store.deleteProject('p');
    expect(h.store.getDataflow('p')).toEqual([]);
    expect(h.store.getDataflow('other')).toEqual(results);
  });

  it('migrates v5 with entities, CFG and FTS intact without inventing missing flow results', () => {
    const owner = register();
    h.store.replaceControlFlowForProject('p', graphs);
    h.store.close();
    const path = join(h.dir, 'registry.db');
    const raw = new Database(path); raw.exec('DROP TABLE code_dataflow'); raw.pragma('user_version = 5'); raw.close();
    const migrated = new SqliteRegistryStore(path);
    try {
      expect(migrated.getEntity(owner.id)?.qualifiedName).toBe('x.ts::f');
      expect(migrated.getControlFlow('p')).toEqual(graphs);
      expect(migrated.getDataflow('p')).toEqual([]);
      expect(migrated.searchEntities('f', 20, 'p')).toHaveLength(1);
      migrated.replaceDataflowForProject('p', results);
      expect(migrated.getDataflow('p')).toEqual(results);
      const check = new Database(path, { readonly: true });
      try { expect(check.pragma('user_version', { simple: true })).toBe(7); expect(check.pragma('foreign_key_check')).toEqual([]); }
      finally { check.close(); }
    } finally { migrated.close(); }
  });
});
