import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { createTmpStore, type TmpDbHandle } from '../helpers/tmpDb.js';
import { SqliteRegistryStore } from '../../src/registry/sqliteStore.js';
import type { RegisterEntityInput } from '../../src/registry/sqliteStore.js';

let h: TmpDbHandle;

const baseEntity = (over: Partial<RegisterEntityInput> = {}): RegisterEntityInput => ({
  projectId: 'p1',
  kind: 'function',
  name: 'foo',
  filePath: 'src/foo.ts',
  lineStart: 1,
  lineEnd: 5,
  signature: '(a: number)',
  status: 'active',
  hasTests: false,
  complexityScore: 2,
  riskLevel: 'low',
  ...over,
});

beforeEach(() => {
  h = createTmpStore();
});

afterEach(() => {
  h.cleanup();
});

describe('SqliteRegistryStore — register / get', () => {
  it('registers an entity and retrieves it by id', () => {
    const ent = h.store.registerEntity(baseEntity());
    expect(ent.id).toBeDefined();
    expect(ent.qualifiedName).toBe('src/foo.ts::foo');

    const fetched = h.store.getEntity(ent.id);
    expect(fetched?.name).toBe('foo');
    expect(fetched?.kind).toBe('function');
    expect(fetched?.complexityScore).toBe(2);
  });

  it('retrieves entity by qualified name', () => {
    h.store.registerEntity(baseEntity());
    const found = h.store.getEntityByName('src/foo.ts::foo');
    expect(found?.name).toBe('foo');
  });

  it('returns null for missing entity', () => {
    expect(h.store.getEntity('nope')).toBeNull();
    expect(h.store.getEntityByName('missing::x')).toBeNull();
  });

  it('requires project scope when qualified names are ambiguous', () => {
    h.store.registerEntity(baseEntity({ projectId: 'p1' }));
    h.store.registerEntity(baseEntity({ projectId: 'p2' }));
    expect(h.store.getEntityByName('src/foo.ts::foo')).toBeNull();
    expect(h.store.getEntityByName('src/foo.ts::foo', 'p2')?.projectId).toBe('p2');
  });

  it('bulk registers multiple entities in a transaction', () => {
    const inputs = [
      baseEntity({ name: 'a', filePath: 'src/a.ts' }),
      baseEntity({ name: 'b', filePath: 'src/b.ts' }),
      baseEntity({ name: 'c', filePath: 'src/c.ts' }),
    ];
    const result = h.store.bulkRegisterEntities(inputs);
    expect(result).toHaveLength(3);
    const stats = h.store.getStats('p1');
    expect(stats.total).toBe(3);
  });
});

describe('SqliteRegistryStore — listEntities filters', () => {
  beforeEach(() => {
    h.store.registerEntity(baseEntity({ name: 'lowFn', filePath: 'src/a.ts', riskLevel: 'low', kind: 'function' }));
    h.store.registerEntity(baseEntity({ name: 'highFn', filePath: 'src/a.ts', riskLevel: 'high', kind: 'function' }));
    h.store.registerEntity(baseEntity({ name: 'MyClass', filePath: 'src/b.ts', riskLevel: 'medium', kind: 'class' }));
    h.store.registerEntity(baseEntity({ name: 'OldFn', filePath: 'src/c.ts', kind: 'function', status: 'deprecated' }));
    h.store.registerEntity(baseEntity({ name: 'OtherFn', projectId: 'p2', filePath: 'src/x.ts' }));
  });

  it('filters by projectId', () => {
    const r = h.store.listEntities({ projectId: 'p1', limit: 100 });
    expect(r.entities.every((e) => e.projectId === 'p1')).toBe(true);
    expect(r.total).toBe(4);
  });

  it('filters by kind', () => {
    const r = h.store.listEntities({ projectId: 'p1', kind: ['class'], limit: 100 });
    expect(r.entities.map((e) => e.name)).toEqual(['MyClass']);
  });

  it('filters by riskLevel', () => {
    const r = h.store.listEntities({ projectId: 'p1', riskLevel: ['high'], limit: 100 });
    expect(r.entities.map((e) => e.name)).toEqual(['highFn']);
  });

  it('filters by status', () => {
    const r = h.store.listEntities({ projectId: 'p1', status: ['deprecated'], limit: 100 });
    expect(r.entities.map((e) => e.name)).toEqual(['OldFn']);
  });

  it('filters by filePath', () => {
    const r = h.store.listEntities({ projectId: 'p1', filePath: 'src/a.ts', limit: 100 });
    expect(r.entities.map((e) => e.name).sort()).toEqual(['highFn', 'lowFn']);
  });

  it('paginates with limit and offset', () => {
    const r1 = h.store.listEntities({ projectId: 'p1', limit: 2, offset: 0 });
    const r2 = h.store.listEntities({ projectId: 'p1', limit: 2, offset: 2 });
    expect(r1.entities).toHaveLength(2);
    expect(r2.entities.length).toBeGreaterThan(0);
    expect(r1.total).toBe(4);
  });
});

describe('SqliteRegistryStore — update / delete', () => {
  it('updates entity fields', () => {
    const ent = h.store.registerEntity(baseEntity());
    const updated = h.store.updateEntity(ent.id, {
      complexityScore: 7,
      riskLevel: 'high',
      hasTests: true,
    });
    expect(updated?.complexityScore).toBe(7);
    expect(updated?.riskLevel).toBe('high');
    expect(updated?.hasTests).toBe(true);
  });

  it('returns existing entity unchanged when patch is empty', () => {
    const ent = h.store.registerEntity(baseEntity());
    const result = h.store.updateEntity(ent.id, {});
    expect(result?.id).toBe(ent.id);
  });

  it('removes entity', () => {
    const ent = h.store.registerEntity(baseEntity());
    const ok = h.store.removeEntity(ent.id);
    expect(ok).toBe(true);
    expect(h.store.getEntity(ent.id)).toBeNull();
  });
});

describe('SqliteRegistryStore — status transitions', () => {
  it('deprecates an entity with reason', () => {
    const ent = h.store.registerEntity(baseEntity());
    const dep = h.store.deprecateEntity(ent.id, 'replaced by bar');
    expect(dep?.status).toBe('deprecated');
    expect(dep?.deprecatedReason).toBe('replaced by bar');
    expect(dep?.deprecatedAt).toBeDefined();
  });

  it('changes entity status', () => {
    const ent = h.store.registerEntity(baseEntity());
    const changed = h.store.changeEntityStatus(ent.id, 'experimental');
    expect(changed?.status).toBe('experimental');
  });
});

describe('SqliteRegistryStore — tags', () => {
  it('adds and reads tags', () => {
    const ent = h.store.registerEntity(baseEntity());
    h.store.addTag(ent.id, 'team', 'platform');
    h.store.addTag(ent.id, 'reviewed');

    const tags = h.store.getTags(ent.id);
    expect(tags.find((t) => t.tag === 'team')?.value).toBe('platform');
    expect(tags.find((t) => t.tag === 'reviewed')).toBeDefined();
  });

  it('removes tags', () => {
    const ent = h.store.registerEntity(baseEntity());
    h.store.addTag(ent.id, 'temp');
    h.store.removeTag(ent.id, 'temp');
    expect(h.store.getTags(ent.id)).toHaveLength(0);
  });

  it('finds entities by tag', () => {
    const e1 = h.store.registerEntity(baseEntity({ name: 'a', filePath: 'src/a.ts' }));
    const e2 = h.store.registerEntity(baseEntity({ name: 'b', filePath: 'src/b.ts' }));
    h.store.addTag(e1.id, 'team', 'platform');
    h.store.addTag(e2.id, 'team', 'platform');

    const found = h.store.entitiesByTag('team', 'platform');
    expect(found).toHaveLength(2);
  });
});

describe('SqliteRegistryStore — warnings', () => {
  it('adds and resolves warnings', () => {
    const ent = h.store.registerEntity(baseEntity());
    const w = h.store.addWarning(ent.id, 'critical', 'security', 'SQL injection risk');
    expect(w.severity).toBe('critical');

    const unresolved = h.store.getUnresolvedWarnings('critical');
    expect(unresolved.find((x) => x.id === w.id)).toBeDefined();

    const ok = h.store.resolveWarning(w.id);
    expect(ok).toBe(true);

    const after = h.store.getUnresolvedWarnings('critical');
    expect(after.find((x) => x.id === w.id)).toBeUndefined();
  });

  it('lists warnings for an entity', () => {
    const ent = h.store.registerEntity(baseEntity());
    h.store.addWarning(ent.id, 'warning', 'performance', 'slow loop');
    const warnings = h.store.getWarnings(ent.id);
    expect(warnings).toHaveLength(1);
  });
});

describe('SqliteRegistryStore — getStats', () => {
  it('aggregates totals, deprecated, untested, high risk', () => {
    h.store.registerEntity(baseEntity({ name: 'a', filePath: 'a.ts' }));
    h.store.registerEntity(baseEntity({ name: 'b', filePath: 'b.ts', hasTests: true }));
    h.store.registerEntity(baseEntity({ name: 'c', filePath: 'c.ts', riskLevel: 'high' }));
    const ent = h.store.registerEntity(baseEntity({ name: 'd', filePath: 'd.ts' }));
    h.store.deprecateEntity(ent.id);

    const stats = h.store.getStats('p1');
    expect(stats.total).toBe(4);
    expect(stats.deprecated).toBe(1);
    // untested = active + has_tests=0; deprecated 'd' is not active, so untested is a, c
    expect(stats.untested).toBe(2);
    expect(stats.highRisk).toBe(1);
  });

  it('groups by kind and status', () => {
    h.store.registerEntity(baseEntity({ name: 'fn1', filePath: 'a.ts', kind: 'function' }));
    h.store.registerEntity(baseEntity({ name: 'fn2', filePath: 'b.ts', kind: 'function' }));
    h.store.registerEntity(baseEntity({ name: 'cls', filePath: 'c.ts', kind: 'class' }));

    const stats = h.store.getStats('p1');
    const fnCount = stats.byKind.find((k) => k.kind === 'function')?.count;
    const clsCount = stats.byKind.find((k) => k.kind === 'class')?.count;
    expect(fnCount).toBe(2);
    expect(clsCount).toBe(1);
  });
});

describe('SqliteRegistryStore — search', () => {
  it('finds entities via FTS5 search', () => {
    h.store.registerEntity(baseEntity({ name: 'parseUser', filePath: 'src/user.ts' }));
    h.store.registerEntity(baseEntity({ name: 'saveOrder', filePath: 'src/order.ts' }));

    const results = h.store.searchEntities('parseUser');
    expect(results.find((e) => e.name === 'parseUser')).toBeDefined();
  });

  it('falls back to LIKE when FTS yields nothing', () => {
    h.store.registerEntity(baseEntity({ name: 'computeHash', filePath: 'src/h.ts' }));
    // partial substring that LIKE will catch
    const results = h.store.searchEntities('Hash');
    expect(results.find((e) => e.name === 'computeHash')).toBeDefined();
  });
});

describe('SqliteRegistryStore — fileBrief', () => {
  it('returns brief with summary string', () => {
    h.store.registerEntity(baseEntity({ name: 'a', filePath: 'src/foo.ts' }));
    h.store.registerEntity(baseEntity({ name: 'b', filePath: 'src/foo.ts', hasTests: true }));
    const ent = h.store.registerEntity(baseEntity({ name: 'c', filePath: 'src/foo.ts' }));
    h.store.deprecateEntity(ent.id);

    const brief = h.store.fileBrief('src/foo.ts', 'p1');
    expect(brief.entities).toHaveLength(3);
    expect(brief.summary).toContain('3 entities');
    expect(brief.summary).toContain('1 deprecated');
  });

  it('isolates matching relative paths by project', () => {
    h.store.registerEntity(baseEntity({ projectId: 'p1', name: 'first', filePath: 'src/shared.ts' }));
    h.store.registerEntity(baseEntity({ projectId: 'p2', name: 'second', filePath: 'src/shared.ts' }));

    const brief = h.store.fileBrief('src/shared.ts', 'p2');

    expect(brief.entities.map((entity) => entity.name)).toEqual(['second']);
    expect(brief.summary).toContain('1 entities');
  });
});

describe('SqliteRegistryStore — convenience queries', () => {
  beforeEach(() => {
    h.store.registerEntity(baseEntity({ name: 'tested', hasTests: true }));
    h.store.registerEntity(baseEntity({ name: 'untested1', filePath: 'src/u1.ts', hasTests: false }));
    h.store.registerEntity(baseEntity({ name: 'untested2', filePath: 'src/u2.ts', hasTests: false }));
    h.store.registerEntity(baseEntity({ name: 'risky', filePath: 'src/r.ts', riskLevel: 'high' }));
    const dep = h.store.registerEntity(baseEntity({ name: 'old', filePath: 'src/old.ts' }));
    h.store.deprecateEntity(dep.id);
  });

  it('untestedEntities returns active untested only', () => {
    const list = h.store.untestedEntities('p1');
    const names = list.map((e) => e.name);
    expect(names).toContain('untested1');
    expect(names).toContain('untested2');
    expect(names).not.toContain('tested');
    expect(names).not.toContain('old');
  });

  it('highRiskEntities returns high risk only', () => {
    const list = h.store.highRiskEntities('p1');
    expect(list.map((e) => e.name)).toEqual(['risky']);
  });

  it('highRiskEntities applies a retrieval limit', () => {
    h.store.registerEntity(baseEntity({ name: 'risky2', filePath: 'src/r2.ts', riskLevel: 'high' }));
    expect(h.store.highRiskEntities('p1', 1)).toHaveLength(1);
  });

  it('deprecatedEntities returns deprecated only', () => {
    const list = h.store.deprecatedEntities('p1');
    expect(list.map((e) => e.name)).toEqual(['old']);
  });
});

describe('SqliteRegistryStore — events', () => {
  it('records events on register and deprecate', () => {
    const ent = h.store.registerEntity(baseEntity());
    h.store.deprecateEntity(ent.id, 'replaced');
    const events = h.store.getEvents(ent.id);
    const types = events.map((e) => e.type);
    expect(types).toContain('created');
    expect(types).toContain('deprecated');
  });
});

describe('SqliteRegistryStore — schema version + FTS rebuild guard (INT-1478)', () => {
  it('migrates an inline UNIQUE(qualified_name) autoindex from v1', () => {
    const dbPath = join(h.dir, 'registry.db');
    const raw = new Database(dbPath);
    const schema = (raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'code_entities'").get() as { sql: string }).sql;
    raw.close();

    const legacyPath = join(h.dir, 'legacy.db');
    const legacy = new Database(legacyPath);
    legacy.exec(schema.replace('UNIQUE(project_id, qualified_name)', 'UNIQUE(qualified_name)'));
    legacy.pragma('user_version = 1');
    legacy.close();

    const migrated = new SqliteRegistryStore(legacyPath);
    migrated.registerEntity(baseEntity({ projectId: 'p1' }));
    expect(() => migrated.registerEntity(baseEntity({ projectId: 'p2' }))).not.toThrow();
    migrated.close();
  });

  it('migrates a populated v1 database while preserving child rows', () => {
    const currentPath = join(h.dir, 'registry.db');
    const current = new Database(currentPath);
    const entitySchema = (current.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'code_entities'").get() as { sql: string }).sql;
    const tagSchema = (current.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'code_entity_tags'").get() as { sql: string }).sql;
    current.close();
    const legacyPath = join(h.dir, 'legacy-populated.db');
    const legacy = new Database(legacyPath);
    legacy.exec(entitySchema.replace('UNIQUE(project_id, qualified_name)', 'UNIQUE(qualified_name)'));
    legacy.exec(tagSchema);
    legacy.prepare(`INSERT INTO code_entities
      (id, project_id, kind, name, qualified_name, file_path, line_start, line_end, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .run('legacy-entity', 'legacy-project', 'function', 'legacy', 'src/legacy.ts::legacy', 'src/legacy.ts', 1, 1);
    legacy.prepare('INSERT INTO code_entity_tags (entity_id, tag, value) VALUES (?, ?, ?)')
      .run('legacy-entity', 'owner', 'core');
    legacy.pragma('user_version = 1');
    legacy.close();

    const migrated = new SqliteRegistryStore(legacyPath);
    expect(migrated.getEntity('legacy-entity')?.name).toBe('legacy');
    expect(migrated.getTags('legacy-entity')).toEqual([{ tag: 'owner', value: 'core' }]);
    migrated.close();
  });

  it('stamps user_version on first migrate and keeps FTS working across reopen', () => {
    const dbPath = join(h.dir, 'registry.db');
    h.store.registerEntity(baseEntity({ name: 'alphaFn', filePath: 'src/a.ts' }));
    h.store.close();

    const raw = new Database(dbPath);
    const version = raw.pragma('user_version', { simple: true }) as number;
    raw.close();
    expect(version).toBeGreaterThanOrEqual(2);

    // 재오픈 — rebuild는 스킵되어야 하고, 트리거/인덱스는 그대로 동작해야 함
    const store2 = new SqliteRegistryStore(dbPath);
    store2.registerEntity(baseEntity({ name: 'betaFn', filePath: 'src/b.ts' }));
    expect(store2.searchEntities('betaFn', 10).some(e => e.name === 'betaFn')).toBe(true);
    expect(store2.searchEntities('alphaFn', 10).some(e => e.name === 'alphaFn')).toBe(true);
    store2.close();
  });

  it('re-runs FTS rebuild when user_version is reset (legacy DB path)', () => {
    const dbPath = join(h.dir, 'registry.db');
    h.store.registerEntity(baseEntity({ name: 'legacyFn', filePath: 'src/l.ts' }));
    h.store.close();

    // 레거시 DB 시뮬레이션: 버전 0으로 강등
    const raw = new Database(dbPath);
    raw.pragma('user_version = 0');
    raw.close();

    const store2 = new SqliteRegistryStore(dbPath);
    expect(store2.searchEntities('legacyFn', 10).some(e => e.name === 'legacyFn')).toBe(true);
    store2.close();

    const raw2 = new Database(dbPath);
    const version = raw2.pragma('user_version', { simple: true }) as number;
    raw2.close();
    expect(version).toBeGreaterThanOrEqual(2);
  });
});

describe('SqliteRegistryStore — registry hygiene (INT-1476/1479)', () => {
  it('listProjects aggregates entity and broken counts per project', () => {
    h.store.registerEntity(baseEntity({ projectId: 'p1', name: 'a', filePath: 'src/a.ts' }));
    const b = h.store.registerEntity(baseEntity({ projectId: 'p1', name: 'b', filePath: 'src/b.ts' }));
    h.store.registerEntity(baseEntity({ projectId: 'p2', name: 'c', filePath: 'src/c.ts' }));
    h.store.changeEntityStatus(b.id, 'broken');

    const projects = h.store.listProjects();
    const p1 = projects.find(p => p.projectId === 'p1');
    expect(p1?.entityCount).toBe(2);
    expect(p1?.brokenCount).toBe(1);
    expect(projects.find(p => p.projectId === 'p2')?.entityCount).toBe(1);
  });

  it('deleteProject removes entities and their relations', () => {
    const a = h.store.registerEntity(baseEntity({ projectId: 'p1', name: 'a', filePath: 'src/a.ts' }));
    const b = h.store.registerEntity(baseEntity({ projectId: 'p1', name: 'b', filePath: 'src/b.ts' }));
    h.store.addRelation(a.id, b.id, 'calls');
    expect(h.store.countRelations('p1')).toBe(1);

    const removed = h.store.deleteProject('p1');
    expect(removed).toBe(2);
    expect(h.store.listProjects().find(p => p.projectId === 'p1')).toBeUndefined();
    expect(h.store.countRelations('p1')).toBe(0);
  });

  it('pruneBroken deletes only broken entities, scoped by project', () => {
    const a = h.store.registerEntity(baseEntity({ projectId: 'p1', name: 'a', filePath: 'src/a.ts' }));
    const b = h.store.registerEntity(baseEntity({ projectId: 'p2', name: 'b', filePath: 'src/b.ts' }));
    h.store.registerEntity(baseEntity({ projectId: 'p1', name: 'alive', filePath: 'src/ok.ts' }));
    h.store.changeEntityStatus(a.id, 'broken');
    h.store.changeEntityStatus(b.id, 'broken');

    expect(h.store.pruneBroken('p1')).toBe(1);
    expect(h.store.getEntity(a.id)).toBeNull();
    expect(h.store.getEntity(b.id)).not.toBeNull();
    expect(h.store.pruneBroken()).toBe(1); // 나머지 전역 정리
    expect(h.store.listProjects().find(p => p.projectId === 'p1')?.entityCount).toBe(1);
  });

  it('pruneEvents deletes events older than cutoff and returns the count', () => {
    const ent = h.store.registerEntity(baseEntity());
    expect(h.store.getEvents(ent.id).length).toBeGreaterThanOrEqual(1);

    // 이벤트를 40일 전으로 백데이트
    const raw = new Database(join(h.dir, 'registry.db'));
    raw.prepare('UPDATE code_entity_events SET created_at = ?')
      .run(new Date(Date.now() - 40 * 86_400_000).toISOString());
    raw.close();

    expect(h.store.pruneEvents(30)).toBeGreaterThanOrEqual(1);
    expect(h.store.getEvents(ent.id)).toHaveLength(0);
    // 새 이벤트는 살아남는다
    h.store.addEvent(ent.id, 'updated', { content: 'fresh' });
    expect(h.store.pruneEvents(30)).toBe(0);
    expect(h.store.getEvents(ent.id)).toHaveLength(1);
    expect(() => h.store.getEvents(ent.id, -1)).not.toThrow();
    expect(h.store.getEvents(ent.id, -1)).toHaveLength(1);
    expect(() => h.store.getEvents(ent.id, Number.NaN)).toThrow('limit must be finite');
  });

  it('rejects invalid event retention periods', () => {
    expect(() => h.store.pruneEvents(-1)).toThrow('finite non-negative');
    expect(() => h.store.pruneEvents(Number.NaN)).toThrow('finite non-negative');
  });

  it('vacuum runs without error', () => {
    h.store.registerEntity(baseEntity());
    expect(() => h.store.vacuum()).not.toThrow();
  });
});
