import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTmpStore, type TmpDbHandle } from '../helpers/tmpDb.js';
import type { FactQuery } from '../../src/analysis/factQuery.js';
let h: TmpDbHandle;
beforeEach(() => {
  h = createTmpStore();
  for (const [projectId, name, filePath] of [['p', 'alpha', 'src/a%_.ts'], ['p', 'beta', 'src/normal.ts'], ['other', 'hidden', 'src/a%_.ts']]) {
    h.store.registerEntity({ projectId, name, filePath, qualifiedName: `${filePath}::${name}`, kind: 'function' });
  }
});
afterEach(() => h.cleanup());
describe('bounded read-only fact queries', () => {
  it('binds literal filters, isolates projects and paginates in a deterministic order', () => {
    expect(h.store.queryFacts('p', { view: 'entities', where: [{ column: 'file_path', op: 'prefix', value: 'src/a%_' }] }).map(row => row.name)).toEqual(['alpha']);
    expect(h.store.queryFacts('p', { view: 'entities', orderBy: 'name', limit: 1, offset: 1 }).map(row => row.name)).toEqual(['beta']);
    expect(h.store.queryFacts('other', { view: 'entities' }).map(row => row.name)).toEqual(['hidden']);
  });
  it('rejects mutation grammar in every structural field, while treating filter values as inert data', () => {
    const before = h.store.listEntities({ projectId: 'p' });
    const probes = ["entities; DROP TABLE code_entities;--", "' OR 1=1 --", 'PRAGMA writable_schema=ON', 'ATTACH DATABASE x AS y',
      'INSERT INTO code_entities VALUES (1)', 'DELETE FROM code_entities', 'UPDATE code_entities SET name=0',
      'WITH x AS (SELECT 1) DELETE FROM code_entities', 'load_extension', 'sqlite_master', '__proto__'];
    for (const probe of probes) {
      for (const query of [ { view: probe }, { view: 'entities', orderBy: probe }, { view: 'entities', direction: probe },
        { view: 'entities', where: [{ column: probe, op: 'eq', value: 1 }] }, { view: 'entities', where: [{ column: 'name', op: probe, value: 1 }] } ]) {
        expect(() => h.store.queryFacts('p', query as FactQuery)).toThrow();
      }
      expect(h.store.queryFacts('p', { view: 'entities', where: [{ column: 'name', op: 'eq', value: probe }] })).toEqual([]);
    }
    for (const limit of [0, -1, 501, Infinity, NaN, 1.5]) expect(() => h.store.queryFacts('p', { view: 'entities', limit })).toThrow();
    expect(() => h.store.queryFacts('p', { view: 'entities', sql: 'DELETE FROM code_entities' } as FactQuery)).toThrow();
    expect(h.store.listEntities({ projectId: 'p' })).toEqual(before);
    expect(h.store.queryFacts('other', { view: 'entities' })).toHaveLength(1);
  });
});
