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

describe('SqliteRegistryStore — v3 migration (INT-3881)', () => {
  /** Exact v2-era table shape: 22 columns, composite UNIQUE, no CHECK constraints. */
  const V2_ENTITY_DDL = `
    CREATE TABLE code_entities (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      signature TEXT,
      status TEXT DEFAULT 'active',
      deprecated_at TEXT,
      deprecated_reason TEXT,
      has_tests INTEGER DEFAULT 0,
      test_file TEXT,
      author TEXT,
      maintainer TEXT,
      complexity_score INTEGER,
      risk_level TEXT DEFAULT 'low',
      description TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, qualified_name)
    );
    CREATE TABLE code_entity_tags (
      entity_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (entity_id, tag),
      FOREIGN KEY (entity_id) REFERENCES code_entities(id) ON DELETE CASCADE
    );
  `;

  function buildV2Db(path: string): void {
    const legacy = new Database(path);
    legacy.exec(V2_ENTITY_DDL);
    const ins = legacy.prepare(`INSERT INTO code_entities
      (id, project_id, kind, name, qualified_name, file_path, line_start, line_end, status, risk_level, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`);
    ins.run('e-keeper', 'p1', 'function', 'keeperFn', 'src/k.ts::keeperFn', 'src/k.ts', 1, 5, 'active', 'low');
    // corrupted enum values that would violate the new CHECK constraints
    ins.run('e-bogus', 'p1', 'function', 'bogusFn', 'src/b.ts::bogusFn', 'src/b.ts', 1, 3, 'totally-bogus', 'extreme');
    legacy.prepare('INSERT INTO code_entity_tags (entity_id, tag, value) VALUES (?, ?, ?)')
      .run('e-keeper', 'owner', 'core');
    legacy.pragma('user_version = 2');
    legacy.close();
  }

  it('rebuilds a v2 database to v3: preserves rows/tags, coerces invalid enums, adds columns, stamps version', () => {
    const legacyPath = join(h.dir, 'v2-legacy.db');
    buildV2Db(legacyPath);

    const migrated = new SqliteRegistryStore(legacyPath);
    // rows preserved — straight INSERT copy must not drop anything
    expect(migrated.getEntity('e-keeper')?.name).toBe('keeperFn');
    expect(migrated.getTags('e-keeper')).toEqual([{ tag: 'owner', value: 'core' }]);
    // invalid enum rows coerced instead of silently dropped
    const bogus = migrated.getEntity('e-bogus');
    expect(bogus?.status).toBe('active');
    expect(bogus?.riskLevel).toBe('low');
    // FTS rebuilt after the table rebuild (rowids were reassigned)
    expect(migrated.searchEntities('keeperFn', 10).some(e => e.id === 'e-keeper')).toBe(true);
    migrated.close();

    const raw = new Database(legacyPath);
    const cols = new Set((raw.prepare('PRAGMA table_info(code_entities)').all() as Array<{ name: string }>).map(r => r.name));
    expect(cols.has('is_exported')).toBe(true);
    expect(cols.has('loc')).toBe(true);
    expect(cols.has('nesting_depth')).toBe(true);
    expect(cols.has('param_count')).toBe(true);
    expect(raw.pragma('user_version', { simple: true })).toBe(3);
    // CHECK now enforced at the DB layer
    expect(() => raw.prepare(`INSERT INTO code_entities
      (id, project_id, kind, name, qualified_name, file_path, status, created_at, updated_at)
      VALUES ('x', 'p', 'function', 'x', 'f::x', 'f', 'nonsense', datetime('now'), datetime('now'))`).run())
      .toThrow(/CHECK/);
    raw.close();
  });

  it('fresh DBs get CHECK constraints, the reverse relation index, and version 3 without a rebuild', () => {
    const raw = new Database(join(h.dir, 'registry.db'));
    const tableSql = (raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='code_entities'").get() as { sql: string }).sql;
    expect(tableSql).toMatch(/CHECK\s*\(\s*status\s+IN/i);
    expect(tableSql).toMatch(/CHECK\s*\(risk_level\s+IN/i);
    const indexes = (raw.prepare('PRAGMA index_list(code_entity_relations)').all() as Array<{ name: string }>).map(r => r.name);
    expect(indexes).toContain('idx_cer_target');
    expect(raw.pragma('user_version', { simple: true })).toBe(3);
    raw.close();
  });

  it('round-trips the recovered scanner metric columns through register/get/update', () => {
    const ent = h.store.registerEntity(baseEntity({
      isExported: true, loc: 42, nestingDepth: 3, paramCount: 2,
    }));
    const got = h.store.getEntity(ent.id);
    expect(got?.isExported).toBe(true);
    expect(got?.loc).toBe(42);
    expect(got?.nestingDepth).toBe(3);
    expect(got?.paramCount).toBe(2);

    const updated = h.store.updateEntity(ent.id, { isExported: false, loc: 99, paramCount: 4 });
    expect(updated?.isExported).toBe(false);
    expect(updated?.loc).toBe(99);
    expect(updated?.paramCount).toBe(4);
    expect(updated?.nestingDepth).toBe(3); // untouched field survives
  });

  it('reopening a v3 database is a no-op migration: no DDL runs, FTS intact', () => {
    const dbPath = join(h.dir, 'registry.db');
    h.store.registerEntity(baseEntity({ name: 'stableFn', filePath: 'src/s.ts' }));
    h.store.close();

    // sqlite schema_version은 DDL이 실행될 때마다 증가한다 — 재오픈이 리빌드/재생성을
    // 하지 않았다는 것을 이름이 아니라 관측으로 단언한다 (L2 리뷰 F8).
    const before = new Database(dbPath);
    const schemaVerBefore = before.pragma('schema_version', { simple: true }) as number;
    before.close();

    const store2 = new SqliteRegistryStore(dbPath);
    expect(store2.searchEntities('stableFn', 10).some(e => e.name === 'stableFn')).toBe(true);
    store2.close();

    const raw = new Database(dbPath);
    expect(raw.pragma('user_version', { simple: true })).toBe(3);
    expect(raw.pragma('schema_version', { simple: true })).toBe(schemaVerBefore);
    raw.close();
  });
});

describe('SqliteRegistryStore — getImpactSet CTE equivalence (INT-3881)', () => {
  /** Deterministic PRNG so failures are reproducible by seed. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Reference implementation: the pre-v3 JS BFS semantics (visited set, shortest depth, root excluded). */
  function referenceImpact(
    edges: Array<[string, string]>,
    root: string,
    maxDepth: number,
  ): Map<string, number> {
    const incoming = new Map<string, string[]>(); // target -> sources
    for (const [s, t] of edges) {
      const arr = incoming.get(t);
      if (arr) arr.push(s);
      else incoming.set(t, [s]);
    }
    const visited = new Set<string>([root]);
    const out = new Map<string, number>();
    let frontier = [root];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const src of incoming.get(id) ?? []) {
          if (visited.has(src)) continue;
          visited.add(src);
          out.set(src, depth);
          next.push(src);
        }
      }
      frontier = next;
    }
    return out;
  }

  it('matches the reference BFS on 200 seeded random graphs (cycles + self-loops included)', () => {
    for (let g = 0; g < 200; g++) {
      const rng = mulberry32(g + 1);
      const n = 4 + Math.floor(rng() * 12); // 4..15 nodes
      const project = `graph-${g}`;
      const ids: string[] = [];
      for (let j = 0; j < n; j++) {
        ids.push(h.store.registerEntity(baseEntity({
          projectId: project, name: `n${j}`, filePath: `src/g${g}/f${j}.ts`,
        })).id);
      }
      const edges: Array<[string, string]> = [];
      const m = Math.floor(rng() * n * 2);
      for (let e = 0; e < m; e++) {
        const s = ids[Math.floor(rng() * n)];
        const t = ids[Math.floor(rng() * n)];
        edges.push([s, t]);
        h.store.addRelation(s, t, 'calls');
      }
      // every 3rd graph gets a guaranteed 3-cycle among callers
      if (g % 3 === 0 && n >= 3) {
        const cyc: Array<[string, string]> = [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]];
        for (const [s, t] of cyc) {
          edges.push([s, t]);
          h.store.addRelation(s, t, 'calls');
        }
      }
      const maxDepth = 1 + Math.floor(rng() * 5); // 1..5
      const root = ids[Math.floor(rng() * n)];

      const expected = referenceImpact(edges, root, maxDepth);
      const got = h.store.getImpactSet(root, maxDepth);
      const gotMap = new Map(got.map(r => [r.id, r.depth]));

      expect(gotMap.size, `graph ${g}: size mismatch`).toBe(expected.size);
      for (const [id, depth] of expected) {
        expect(gotMap.get(id), `graph ${g}: depth mismatch for ${id}`).toBe(depth);
      }
    }
  }, 60_000);

  it('a cycle back through the root never resurfaces the root itself', () => {
    const a = h.store.registerEntity(baseEntity({ name: 'a', filePath: 'src/ca.ts' }));
    const b = h.store.registerEntity(baseEntity({ name: 'b', filePath: 'src/cb.ts' }));
    // b calls a (b is a's caller), a calls b (cycle) — impact(a) must be {b@1} only
    h.store.addRelation(b.id, a.id, 'calls');
    h.store.addRelation(a.id, b.id, 'calls');
    const got = h.store.getImpactSet(a.id, 5);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: b.id, depth: 1 });
  });

  it('truncates a caller chain deeper than maxDepth', () => {
    const chain = Array.from({ length: 6 }, (_, i) =>
      h.store.registerEntity(baseEntity({ name: `c${i}`, filePath: `src/chain${i}.ts` })));
    // c1→c0, c2→c1, ... c5→c4  (each calls the previous: c0's transitive callers = c1..c5)
    for (let i = 1; i < chain.length; i++) {
      h.store.addRelation(chain[i].id, chain[i - 1].id, 'calls');
    }
    const got = h.store.getImpactSet(chain[0].id, 3);
    expect(got.map(r => r.depth).sort()).toEqual([1, 2, 3]);
    expect(got.find(r => r.id === chain[4].id)).toBeUndefined(); // depth 4 cut off
  });

  it('returns an empty set for an entity with no callers', () => {
    const lone = h.store.registerEntity(baseEntity({ name: 'lone', filePath: 'src/lone.ts' }));
    expect(h.store.getImpactSet(lone.id, 5)).toEqual([]);
  });
});

describe('SqliteRegistryStore — v3 gate requires BOTH check constraints (PR #7 review)', () => {
  it('rebuilds a half-schema table that has only the status CHECK', () => {
    // status CHECK만 있고 risk_level CHECK가 없는 변칙 테이블 — 게이트가 status만
    // 검사하면 이 테이블은 리빌드 없이 v3로 봉인되고 risk CHECK가 영원히 누락된다.
    const halfPath = join(h.dir, 'half-schema.db');
    const half = new Database(halfPath);
    half.exec(`
      CREATE TABLE code_entities (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_start INTEGER,
        line_end INTEGER,
        signature TEXT,
        status TEXT DEFAULT 'active',
        deprecated_at TEXT,
        deprecated_reason TEXT,
        has_tests INTEGER DEFAULT 0,
        test_file TEXT,
        author TEXT,
        maintainer TEXT,
        complexity_score INTEGER,
        risk_level TEXT DEFAULT 'low',
        description TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, qualified_name),
        CHECK (status IN ('active', 'deprecated', 'experimental', 'planned', 'broken'))
      );
    `);
    half.prepare(`INSERT INTO code_entities
      (id, project_id, kind, name, qualified_name, file_path, risk_level, created_at, updated_at)
      VALUES ('e-half', 'p1', 'function', 'halfFn', 'src/h.ts::halfFn', 'src/h.ts', 'extreme', datetime('now'), datetime('now'))`).run();
    half.pragma('user_version = 2');
    half.close();

    const migrated = new SqliteRegistryStore(halfPath);
    expect(migrated.getEntity('e-half')?.riskLevel).toBe('low'); // coerced during rebuild
    migrated.close();

    const raw = new Database(halfPath);
    const sql = (raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='code_entities'").get() as { sql: string }).sql;
    expect(sql).toMatch(/CHECK\s*\(\s*risk_level\s+IN/i); // rebuild fired, risk CHECK now present
    expect(() => raw.prepare(`INSERT INTO code_entities
      (id, project_id, kind, name, qualified_name, file_path, risk_level, created_at, updated_at)
      VALUES ('x', 'p', 'function', 'x', 'f::x', 'f', 'extreme', datetime('now'), datetime('now'))`).run())
      .toThrow(/CHECK/);
    raw.close();
  });
});

describe('SqliteRegistryStore — enum invariant holds for NULL (PR #7 review r2)', () => {
  it('fresh DBs reject explicit NULL status/risk_level (CHECK passes NULL — NOT NULL must catch it)', () => {
    const raw = new Database(join(h.dir, 'registry.db'));
    expect(() => raw.prepare(`INSERT INTO code_entities
      (id, project_id, kind, name, qualified_name, file_path, status, created_at, updated_at)
      VALUES ('x1', 'p', 'function', 'x1', 'f::x1', 'f', NULL, datetime('now'), datetime('now'))`).run())
      .toThrow(/NOT NULL/);
    expect(() => raw.prepare(`INSERT INTO code_entities
      (id, project_id, kind, name, qualified_name, file_path, risk_level, created_at, updated_at)
      VALUES ('x2', 'p', 'function', 'x2', 'f::x2', 'f', NULL, datetime('now'), datetime('now'))`).run())
      .toThrow(/NOT NULL/);
    raw.close();
  });

  it('self-heals a v3-stamped table that has CHECKs but nullable enum columns', () => {
    // 초기 v3 구현(0b3717a)이 만든 형태: CHECK는 있으나 NOT NULL이 없어 NULL이 통과.
    // 게이트가 버전 기반이면 user_version=3에 봉인돼 영원히 안 고쳐진다 — 상태 기반 검증.
    const p = join(h.dir, 'nullable-v3.db');
    const db = new Database(p);
    db.exec(`
      CREATE TABLE code_entities (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_start INTEGER,
        line_end INTEGER,
        signature TEXT,
        status TEXT DEFAULT 'active',
        deprecated_at TEXT,
        deprecated_reason TEXT,
        has_tests INTEGER DEFAULT 0,
        test_file TEXT,
        author TEXT,
        maintainer TEXT,
        complexity_score INTEGER,
        risk_level TEXT DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
        is_exported INTEGER DEFAULT 0,
        loc INTEGER,
        nesting_depth INTEGER,
        param_count INTEGER,
        description TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, qualified_name),
        CHECK (status IN ('active', 'deprecated', 'experimental', 'planned', 'broken'))
      );
    `);
    db.prepare(`INSERT INTO code_entities
      (id, project_id, kind, name, qualified_name, file_path, status, created_at, updated_at)
      VALUES ('e-null', 'p1', 'function', 'nullFn', 'src/n.ts::nullFn', 'src/n.ts', NULL, datetime('now'), datetime('now'))`).run();
    db.pragma('user_version = 3');
    db.close();

    const migrated = new SqliteRegistryStore(p);
    expect(migrated.getEntity('e-null')?.status).toBe('active'); // NULL coerced during heal
    migrated.close();

    const raw = new Database(p);
    const cols = raw.prepare('PRAGMA table_info(code_entities)').all() as Array<{ name: string; notnull: number }>;
    const byName = new Map(cols.map(c => [c.name, c.notnull]));
    expect(byName.get('status')).toBe(1);
    expect(byName.get('risk_level')).toBe(1);
    raw.close();
  });
});

describe('SqliteRegistryStore — L2 review fixes (F1/F3 regression)', () => {
  it('F1: heals the crash window — v3 table with rows, version 2, FTS table missing', () => {
    // 리빌드 트랜잭션(FTS drop 포함) 커밋 직후 ~ FTS 재생성 전 크래시를 재현:
    // 정상 v3 테이블 + 데이터 + user_version=2 + FTS/트리거 부재.
    const p = join(h.dir, 'crash-window.db');
    const s1 = new SqliteRegistryStore(p);
    s1.registerEntity(baseEntity({ name: 'crashFn', filePath: 'src/cw.ts' }));
    s1.close();

    const raw = new Database(p);
    raw.exec(`
      DROP TRIGGER IF EXISTS ce_fts_ai;
      DROP TRIGGER IF EXISTS ce_fts_ad;
      DROP TRIGGER IF EXISTS ce_fts_au;
      DROP TABLE IF EXISTS code_entities_fts;
    `);
    raw.pragma('user_version = 2');
    raw.close();

    const s2 = new SqliteRegistryStore(p);
    s2.close();

    // LIKE fallback이 가릴 수 있으므로 FTS 인덱스 자체를 raw로 검증한다.
    const raw2 = new Database(p);
    const hits = (raw2.prepare(
      "SELECT COUNT(*) as cnt FROM code_entities_fts WHERE code_entities_fts MATCH 'crashFn'"
    ).get() as { cnt: number }).cnt;
    expect(hits).toBe(1);
    expect(raw2.pragma('user_version', { simple: true })).toBe(3);
    raw2.close();
  });

  it('F3: legacy backfill keeps is_exported as unmeasured (NULL), not false', () => {
    // v2 DB를 마이그레이션하면 is_exported는 NULL(미측정)이어야 한다 — 0 백필 금지.
    const p = join(h.dir, 'tri-state.db');
    const legacy = new Database(p);
    legacy.exec(`
      CREATE TABLE code_entities (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, qualified_name TEXT NOT NULL, file_path TEXT NOT NULL,
        line_start INTEGER, line_end INTEGER, signature TEXT,
        status TEXT DEFAULT 'active', deprecated_at TEXT, deprecated_reason TEXT,
        has_tests INTEGER DEFAULT 0, test_file TEXT, author TEXT, maintainer TEXT,
        complexity_score INTEGER, risk_level TEXT DEFAULT 'low',
        description TEXT DEFAULT '', notes TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, qualified_name)
      );
    `);
    legacy.prepare(`INSERT INTO code_entities
      (id, project_id, kind, name, qualified_name, file_path, created_at, updated_at)
      VALUES ('e-tri', 'p1', 'function', 'triFn', 'src/t.ts::triFn', 'src/t.ts', datetime('now'), datetime('now'))`).run();
    legacy.pragma('user_version = 2');
    legacy.close();

    const migrated = new SqliteRegistryStore(p);
    expect(migrated.getEntity('e-tri')?.isExported).toBeUndefined(); // 미측정 — false 아님
    // 미측정 register도 NULL 보존
    const fresh = migrated.registerEntity(baseEntity({ name: 'noMetric', filePath: 'src/nm.ts' }));
    expect(migrated.getEntity(fresh.id)?.isExported).toBeUndefined();
    migrated.close();
  });
});

describe('SqliteRegistryStore — L2 addendum (R1 micro-window, F5 guard regression)', () => {
  it('R1: heals an FTS table that exists but is empty while entities exist', () => {
    // 크래시 지점이 CREATE VIRTUAL TABLE 직후 ~ rebuild INSERT 직전이면 "존재하되 빈"
    // FTS가 남는다. 테이블 부재만 검사하면 이 상태는 영구 stale — 행 존재 프로브로 치유.
    const p = join(h.dir, 'empty-fts.db');
    const s1 = new SqliteRegistryStore(p);
    s1.registerEntity(baseEntity({ name: 'emptyFtsFn', filePath: 'src/ef.ts' }));
    s1.close();

    const raw = new Database(p);
    raw.exec(`
      DROP TRIGGER IF EXISTS ce_fts_ai;
      DROP TRIGGER IF EXISTS ce_fts_ad;
      DROP TRIGGER IF EXISTS ce_fts_au;
      DROP TABLE IF EXISTS code_entities_fts;
      CREATE VIRTUAL TABLE code_entities_fts USING fts5(
        name, qualified_name, description, notes, signature,
        content=code_entities, content_rowid=rowid
      );
    `);
    // 버전은 이미 3인 최악 케이스 — 순수하게 상태 프로브만으로 치유돼야 한다.
    raw.close();

    const s2 = new SqliteRegistryStore(p);
    s2.close();

    const raw2 = new Database(p);
    const hits = (raw2.prepare(
      "SELECT COUNT(*) as cnt FROM code_entities_fts WHERE code_entities_fts MATCH 'emptyFtsFn'"
    ).get() as { cnt: number }).cnt;
    expect(hits).toBe(1);
    raw2.close();
  });

  it('F5 guard: a future v4 database is never rebuilt down to the v3 shape', () => {
    // v4 가정: CHECK 구성이 바뀌고(여기선 부재로 모사) v4 전용 컬럼을 가짐.
    // 가드가 없으면 상태 게이트가 이를 "비정상 v3"로 보고 정본 26컬럼으로 리빌드하며
    // call_sites_count 데이터를 드랍한다.
    const p = join(h.dir, 'future-v4.db');
    const db = new Database(p);
    db.exec(`
      CREATE TABLE code_entities (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, qualified_name TEXT NOT NULL, file_path TEXT NOT NULL,
        line_start INTEGER, line_end INTEGER, signature TEXT,
        status TEXT DEFAULT 'active', deprecated_at TEXT, deprecated_reason TEXT,
        has_tests INTEGER DEFAULT 0, test_file TEXT, author TEXT, maintainer TEXT,
        complexity_score INTEGER, risk_level TEXT DEFAULT 'low',
        is_exported INTEGER, loc INTEGER, nesting_depth INTEGER, param_count INTEGER,
        call_sites_count INTEGER,
        description TEXT DEFAULT '', notes TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, qualified_name)
      );
    `);
    db.prepare(`INSERT INTO code_entities
      (id, project_id, kind, name, qualified_name, file_path, call_sites_count, created_at, updated_at)
      VALUES ('e-v4', 'p1', 'function', 'futureFn', 'src/f4.ts::futureFn', 'src/f4.ts', 42, datetime('now'), datetime('now'))`).run();
    db.pragma('user_version = 4');
    db.close();

    const opened = new SqliteRegistryStore(p);
    opened.close();

    const raw = new Database(p);
    expect(raw.pragma('user_version', { simple: true })).toBe(4); // 다운스탬프 없음
    const row = raw.prepare("SELECT call_sites_count FROM code_entities WHERE id = 'e-v4'").get() as { call_sites_count: number };
    expect(row.call_sites_count).toBe(42); // v4 데이터 보존 — 리빌드 미발동
    raw.close();
  });
});
