import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { createTmpStore, type TmpDbHandle } from '../helpers/tmpDb.js';
import { SqliteRegistryStore } from '../../src/registry/sqliteStore.js';
import { extractFile } from '../../src/registry/entityScanner.js';
import { analyzeSummaries } from '../../src/analysis/summaries.js';

let h: TmpDbHandle;
beforeEach(() => { h = createTmpStore(); });
afterEach(() => { h.cleanup(); });
const graphs = extractFile('function f(input){return input;}', 'x.ts', 'typescript', 'ast').controlFlow!;
const results = analyzeSummaries(graphs, []);
function register(projectId = 'p') { return h.store.registerEntity({ projectId, kind: 'function', name: 'f', filePath: 'x.ts' }); }

describe('summary persistence', () => {
  it('round-trips summaries, isolates projects and rolls back invalid replacements', () => {
    const one = register(); const two = register('other');
    h.store.replaceSummariesForProject('p', results.summaries);
    h.store.replaceSummariesForProject('other', results.summaries);
    expect(h.store.getSummaries('p', one.id)).toEqual(results.summaries);
    expect(h.store.getSummaries('p', two.id)).toEqual([]);
    expect(() => h.store.replaceSummariesForProject('p', [{ ...results.summaries[0], owner: 'x.ts::unknown' }])).toThrow('Unregistered summary owner');
    expect(h.store.getSummaries('p')).toEqual(results.summaries);
    expect(() => h.store.replaceSummariesForProject('p', [...results.summaries, ...results.summaries])).toThrow();
    expect(h.store.getSummaries('p')).toEqual(results.summaries);
    h.store.deleteProject('p');
    expect(h.store.getSummaries('p')).toEqual([]);
    expect(h.store.getSummaries('other')).toEqual(results.summaries);
  });

  it('migrates v6 and preserves prior flow facts without inventing summaries', () => {
    const owner = register(); h.store.replaceDataflowForProject('p', results.flows);
    h.store.close();
    const path = join(h.dir, 'registry.db');
    const raw = new Database(path); raw.exec('DROP TABLE code_function_summaries'); raw.pragma('user_version = 6'); raw.close();
    const migrated = new SqliteRegistryStore(path);
    try {
      expect(migrated.getEntity(owner.id)?.qualifiedName).toBe('x.ts::f');
      expect(migrated.getDataflow('p')).toEqual(results.flows);
      expect(migrated.getSummaries('p')).toEqual([]);
      expect(migrated.searchEntities('f', 20, 'p')).toHaveLength(1);
      migrated.replaceSummariesForProject('p', results.summaries);
      expect(migrated.getSummaries('p')).toEqual(results.summaries);
      const check = new Database(path, { readonly: true });
      try { expect(check.pragma('user_version', { simple: true })).toBe(7); expect(check.pragma('foreign_key_check')).toEqual([]); }
      finally { check.close(); }
    } finally { migrated.close(); }
  });
});
