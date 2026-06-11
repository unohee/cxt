// ============================================
// ctx - Code Registry SQLite Store
// Created: 2026-04-11
// Purpose: better-sqlite3 기반 코드 엔티티 레지스트리
// Dependencies: better-sqlite3, nanoid
// ============================================

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import type {
  CodeEntity, CodeEntityFilter, EntityKind, EntityStatus, RiskLevel,
  EntityEvent, EntityEventType, EntityWarning, EntityTag,
  WarningSeverity, WarningCategory, RelationType,
  FileBrief, RegistryStats,
} from './schema.js';

const DEFAULT_DB_PATH = resolve(homedir(), '.cxt', 'registry.db');

// ============ 인터페이스 ============

export interface RegisterEntityInput {
  projectId: string;
  kind: EntityKind;
  name: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  signature?: string;
  status?: EntityStatus;
  hasTests?: boolean;
  testFile?: string;
  author?: string;
  maintainer?: string;
  complexityScore?: number;
  riskLevel?: RiskLevel;
  description?: string;
  notes?: string;
  tags?: { tag: string; value?: string }[];
}

export interface UpdateEntityInput {
  name?: string;
  lineStart?: number;
  lineEnd?: number;
  signature?: string;
  hasTests?: boolean;
  testFile?: string;
  maintainer?: string;
  complexityScore?: number;
  riskLevel?: RiskLevel;
  description?: string;
  notes?: string;
}

export interface EventData {
  oldValue?: string;
  newValue?: string;
  content?: string;
  actor?: string;
}

// ============ DB Row 타입 ============

interface EntityRow {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  signature: string | null;
  status: string;
  deprecated_at: string | null;
  deprecated_reason: string | null;
  has_tests: number;
  test_file: string | null;
  author: string | null;
  maintainer: string | null;
  complexity_score: number | null;
  risk_level: string;
  description: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface WarningRow {
  id: string;
  entity_id: string;
  severity: string;
  category: string;
  message: string;
  resolved: number;
  resolved_at: string | null;
  created_at: string;
}

interface EventRow {
  id: string;
  entity_id: string;
  type: string;
  old_value: string | null;
  new_value: string | null;
  content: string | null;
  actor: string;
  created_at: string;
}

interface TagRow {
  tag: string;
  value: string | null;
}

interface RelationRow {
  target_id: string;
  target_name: string;
  relation_type: string;
}

interface CountRow {
  cnt: number;
}

interface KindCountRow {
  kind: string;
  cnt: number;
}

interface StatusCountRow {
  status: string;
  cnt: number;
}

interface IssueLinkRow {
  entity_id: string;
  issue_id: string;
}

// ============ Store 구현 ============

export class SqliteRegistryStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    mkdirSync(resolve(path, '..'), { recursive: true });
    this.db = new Database(path);

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.migrate();
  }

  // 스키마 버전 — 변경 시 반드시 증가. migrate()의 핵심 마이그레이션 단계와 1:1 대응.
  // INT-1478: user_version 가드로 FTS rebuild를 최초 1회만 수행.
  // INT-1475: v2 = qualified_name 전역 UNIQUE → UNIQUE(project_id, qualified_name) 복합 제약.
  private static readonly SCHEMA_VERSION = 2;

  private migrate(): void {
    const currentVersion = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;

    // ── 초기 테이블 생성 (idempotent) ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_entities (
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
      );`);

    // ── 이전 스키마에서 누락된 컬럼 추가 ──
    const colInfo = this.db.prepare("PRAGMA table_info(code_entities)").all() as Array<{ name: string; notnull: number }>;
    const existingCols = new Map(colInfo.map(r => [r.name, r]));

    const addColMigrations: Array<[string, string]> = [
      ['test_file', 'ALTER TABLE code_entities ADD COLUMN test_file TEXT'],
      ['deprecated_at', 'ALTER TABLE code_entities ADD COLUMN deprecated_at TEXT'],
      ['deprecated_reason', 'ALTER TABLE code_entities ADD COLUMN deprecated_reason TEXT'],
      ['author', 'ALTER TABLE code_entities ADD COLUMN author TEXT'],
      ['maintainer', 'ALTER TABLE code_entities ADD COLUMN maintainer TEXT'],
      ['description', "ALTER TABLE code_entities ADD COLUMN description TEXT DEFAULT ''"],
      ['notes', "ALTER TABLE code_entities ADD COLUMN notes TEXT DEFAULT ''"],
    ];
    for (const [col, sql] of addColMigrations) {
      if (!existingCols.has(col)) {
        this.db.exec(sql);
      }
    }

    // ── v1 → v2: qualified_name 전역 UNIQUE → UNIQUE(project_id, qualified_name) ──
    // 구 스키마는 qualified_name에 단일 UNIQUE 인덱스가 있어 다른 project_id에서
    // 같은 파일 경로의 엔티티가 INSERT되면 충돌. 복합 제약으로 교체한다.
    if (currentVersion < 2) {
      const indexInfo = this.db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='code_entities'"
      ).all() as Array<{ name: string; sql: string | null }>;

      const hasOldUniqueOnQName = indexInfo.some(idx =>
        idx.sql && /UNIQUE/i.test(idx.sql) &&
        /qualified_name/.test(idx.sql) &&
        !/project_id/.test(idx.sql)
      );

      if (hasOldUniqueOnQName) {
        // 테이블 재생성으로 제약 변경 (SQLite는 DROP CONSTRAINT 미지원)
        this.db.exec(`
          DROP TRIGGER IF EXISTS ce_fts_ai;
          DROP TRIGGER IF EXISTS ce_fts_ad;
          DROP TRIGGER IF EXISTS ce_fts_au;
          DROP TABLE IF EXISTS code_entities_fts;

          CREATE TABLE code_entities_v2 (
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
          INSERT OR IGNORE INTO code_entities_v2 SELECT * FROM code_entities;
          DROP TABLE code_entities;
          ALTER TABLE code_entities_v2 RENAME TO code_entities;
        `);
      }
    }

    // ── line_start/line_end NOT NULL → nullable 마이그레이션 (레거시) ──
    const refreshedColInfo = this.db.prepare("PRAGMA table_info(code_entities)").all() as Array<{ name: string; notnull: number }>;
    const refreshedCols = new Map(refreshedColInfo.map(r => [r.name, r]));
    const lineStartCol = refreshedCols.get('line_start');
    if (lineStartCol && lineStartCol.notnull === 1) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS ce_fts_ai;
        DROP TRIGGER IF EXISTS ce_fts_ad;
        DROP TRIGGER IF EXISTS ce_fts_au;
        DROP TABLE IF EXISTS code_entities_fts;

        CREATE TABLE code_entities_new (
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
        INSERT OR IGNORE INTO code_entities_new SELECT
          id, project_id, kind, name, qualified_name, file_path,
          line_start, line_end, signature,
          COALESCE(status, 'active'),
          ${refreshedCols.has('deprecated_at') ? 'deprecated_at' : 'NULL'},
          ${refreshedCols.has('deprecated_reason') ? 'deprecated_reason' : 'NULL'},
          COALESCE(has_tests, 0),
          ${refreshedCols.has('test_file') ? 'test_file' : 'NULL'},
          ${refreshedCols.has('author') ? 'author' : 'NULL'},
          ${refreshedCols.has('maintainer') ? 'maintainer' : 'NULL'},
          COALESCE(complexity_score, 0),
          COALESCE(risk_level, 'low'),
          ${refreshedCols.has('description') ? "COALESCE(description, '')" : "''"},
          ${refreshedCols.has('notes') ? "COALESCE(notes, '')" : "''"},
          created_at, updated_at
        FROM code_entities;
        DROP TABLE code_entities;
        ALTER TABLE code_entities_new RENAME TO code_entities;
      `);
    }

    // ── 보조 테이블 + 인덱스 (idempotent) ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_entity_tags (
        entity_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (entity_id, tag),
        FOREIGN KEY (entity_id) REFERENCES code_entities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS code_entity_warnings (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        resolved INTEGER DEFAULT 0,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES code_entities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS code_entity_relations (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, relation_type),
        FOREIGN KEY (source_id) REFERENCES code_entities(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES code_entities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS code_entity_issue_links (
        entity_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY (entity_id, issue_id),
        FOREIGN KEY (entity_id) REFERENCES code_entities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS code_entity_events (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        type TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        content TEXT,
        actor TEXT DEFAULT 'system',
        created_at TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES code_entities(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ce_project ON code_entities(project_id);
      CREATE INDEX IF NOT EXISTS idx_ce_kind ON code_entities(kind);
      CREATE INDEX IF NOT EXISTS idx_ce_file ON code_entities(file_path);
      CREATE INDEX IF NOT EXISTS idx_ce_status ON code_entities(status);
      CREATE INDEX IF NOT EXISTS idx_ce_has_tests ON code_entities(has_tests);
      CREATE INDEX IF NOT EXISTS idx_ce_risk ON code_entities(risk_level);
      CREATE INDEX IF NOT EXISTS idx_ce_events_entity ON code_entity_events(entity_id);
      CREATE INDEX IF NOT EXISTS idx_ce_events_created ON code_entity_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_ce_tags_tag ON code_entity_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_ce_warnings_sev ON code_entity_warnings(severity);
      CREATE INDEX IF NOT EXISTS idx_ce_warnings_entity ON code_entity_warnings(entity_id);
    `);

    // ── FTS 가상 테이블 + 트리거 ──
    // INT-1478: 버전이 올라간 경우(최초 또는 스키마 변경)에만 rebuild 수행.
    const needsFtsRebuild = currentVersion < SqliteRegistryStore.SCHEMA_VERSION;

    if (needsFtsRebuild) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS ce_fts_ai;
        DROP TRIGGER IF EXISTS ce_fts_ad;
        DROP TRIGGER IF EXISTS ce_fts_au;
        DROP TABLE IF EXISTS code_entities_fts;
      `);
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS code_entities_fts USING fts5(
        name, qualified_name, description, notes, signature,
        content=code_entities, content_rowid=rowid
      );`);

    if (needsFtsRebuild) {
      try {
        this.db.exec("INSERT INTO code_entities_fts(code_entities_fts) VALUES('rebuild')");
      } catch { // cxt-ignore: exception_hiding — 빈 테이블 rebuild 실패는 무시(인덱싱 불필요)
        // 빈 테이블은 rebuild 불필요
      }
    }

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS ce_fts_ai AFTER INSERT ON code_entities BEGIN
        INSERT INTO code_entities_fts(rowid, name, qualified_name, description, notes, signature)
        VALUES (new.rowid, new.name, new.qualified_name, new.description, new.notes, new.signature);
      END;
      CREATE TRIGGER IF NOT EXISTS ce_fts_ad AFTER DELETE ON code_entities BEGIN
        INSERT INTO code_entities_fts(code_entities_fts, rowid, name, qualified_name, description, notes, signature)
        VALUES ('delete', old.rowid, old.name, old.qualified_name, old.description, old.notes, old.signature);
      END;
      CREATE TRIGGER IF NOT EXISTS ce_fts_au AFTER UPDATE ON code_entities BEGIN
        INSERT INTO code_entities_fts(code_entities_fts, rowid, name, qualified_name, description, notes, signature)
        VALUES ('delete', old.rowid, old.name, old.qualified_name, old.description, old.notes, old.signature);
        INSERT INTO code_entities_fts(rowid, name, qualified_name, description, notes, signature)
        VALUES (new.rowid, new.name, new.qualified_name, new.description, new.notes, new.signature);
      END;
    `);

    // 버전 기록 (마이그레이션이 모두 끝난 뒤)
    if (needsFtsRebuild) {
      this.db.pragma(`user_version = ${SqliteRegistryStore.SCHEMA_VERSION}`);
    }
  }

  // ============ 엔티티 CRUD ============

  registerEntity(input: RegisterEntityInput): CodeEntity {
    const id = nanoid(12);
    const now = new Date().toISOString();
    const qualifiedName = `${input.filePath}::${input.name}`;

    const insertEntity = this.db.prepare(`
      INSERT INTO code_entities (
        id, project_id, kind, name, qualified_name, file_path,
        line_start, line_end, signature, status,
        has_tests, test_file, author, maintainer,
        complexity_score, risk_level, description, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTag = this.db.prepare(
      'INSERT OR IGNORE INTO code_entity_tags (entity_id, tag, value) VALUES (?, ?, ?)'
    );

    const insertEvent = this.db.prepare(`
      INSERT INTO code_entity_events (id, entity_id, type, new_value, actor, created_at)
      VALUES (?, ?, 'created', ?, 'system', ?)
    `);

    const transaction = this.db.transaction(() => {
      insertEntity.run(
        id, input.projectId, input.kind, input.name, qualifiedName, input.filePath,
        input.lineStart ?? null, input.lineEnd ?? null, input.signature ?? null,
        input.status ?? 'active',
        input.hasTests ? 1 : 0, input.testFile ?? null,
        input.author ?? null, input.maintainer ?? null,
        input.complexityScore ?? null, input.riskLevel ?? 'low',
        input.description ?? '', input.notes ?? '',
        now, now,
      );

      for (const t of input.tags ?? []) {
        insertTag.run(id, t.tag, t.value ?? null);
      }

      insertEvent.run(nanoid(12), id, input.name, now);
    });

    transaction();
    const entity = this.getEntity(id);
    if (!entity) throw new Error(`Failed to register entity: ${qualifiedName} — row not found after insert`);
    return entity;
  }

  bulkRegisterEntities(inputs: RegisterEntityInput[]): CodeEntity[] {
    const results: CodeEntity[] = [];
    const transaction = this.db.transaction(() => {
      for (const input of inputs) {
        results.push(this.registerEntity(input));
      }
    });
    transaction();
    return results;
  }

  getEntity(id: string): CodeEntity | null {
    const row = this.db.prepare('SELECT * FROM code_entities WHERE id = ?').get(id) as EntityRow | undefined;
    if (!row) return null;
    return this.rowToEntity(row);
  }

  getEntityByName(qualifiedName: string): CodeEntity | null {
    const row = this.db.prepare(
      'SELECT * FROM code_entities WHERE qualified_name = ?'
    ).get(qualifiedName) as EntityRow | undefined;
    if (!row) return null;
    return this.rowToEntity(row);
  }

  updateEntity(id: string, patch: UpdateEntityInput, actor = 'system'): CodeEntity | null {
    const existing = this.getEntity(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];

    const fieldMap: Record<string, string> = {
      name: 'name', lineStart: 'line_start', lineEnd: 'line_end',
      signature: 'signature', hasTests: 'has_tests', testFile: 'test_file',
      maintainer: 'maintainer', complexityScore: 'complexity_score',
      riskLevel: 'risk_level', description: 'description', notes: 'notes',
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in patch && (patch as Record<string, unknown>)[key] !== undefined) {
        const val = (patch as Record<string, unknown>)[key];
        fields.push(`${col} = ?`);
        values.push(key === 'hasTests' ? (val ? 1 : 0) : (val ?? null));
      }
    }

    if (fields.length === 0) return existing;

    if (patch.name && patch.name !== existing.name) {
      fields.push('qualified_name = ?');
      values.push(`${existing.filePath}::${patch.name}`);
    }

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    this.db.prepare(`UPDATE code_entities SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    this.addEvent(id, 'updated', {
      content: `fields: ${Object.keys(patch).join(', ')}`,
      actor,
    });

    return this.getEntity(id);
  }

  removeEntity(id: string): boolean {
    const result = this.db.prepare('DELETE FROM code_entities WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listEntities(filter?: CodeEntityFilter): { entities: CodeEntity[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.projectId) {
      conditions.push('e.project_id = ?');
      params.push(filter.projectId);
    }
    if (filter?.kind && filter.kind.length > 0) {
      conditions.push(`e.kind IN (${filter.kind.map(() => '?').join(',')})`);
      params.push(...filter.kind);
    }
    if (filter?.status && filter.status.length > 0) {
      conditions.push(`e.status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    if (filter?.filePath) {
      conditions.push('e.file_path = ?');
      params.push(filter.filePath);
    }
    if (filter?.hasTests !== undefined) {
      conditions.push('e.has_tests = ?');
      params.push(filter.hasTests ? 1 : 0);
    }
    if (filter?.riskLevel && filter.riskLevel.length > 0) {
      conditions.push(`e.risk_level IN (${filter.riskLevel.map(() => '?').join(',')})`);
      params.push(...filter.riskLevel);
    }
    if (filter?.author) {
      conditions.push('e.author = ?');
      params.push(filter.author);
    }
    if (filter?.tags && filter.tags.length > 0) {
      conditions.push(`e.id IN (
        SELECT entity_id FROM code_entity_tags WHERE tag IN (${filter.tags.map(() => '?').join(',')})
      )`);
      params.push(...filter.tags);
    }

    let ftsJoin = '';
    if (filter?.search) {
      ftsJoin = 'INNER JOIN code_entities_fts ON code_entities_fts.rowid = e.rowid';
      conditions.push('code_entities_fts MATCH ?');
      params.push(filter.search);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM code_entities e ${ftsJoin} ${where}`
    ).get(...params) as CountRow;
    const total = countRow.cnt;

    const rows = this.db.prepare(`
      SELECT e.* FROM code_entities e ${ftsJoin} ${where}
      ORDER BY e.file_path, e.line_start NULLS LAST, e.name
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as EntityRow[];

    return {
      entities: this.rowsToEntities(rows),
      total,
    };
  }

  // ============ 상태 관리 ============

  deprecateEntity(id: string, reason?: string, actor = 'system'): CodeEntity | null {
    const existing = this.getEntity(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE code_entities SET status = 'deprecated', deprecated_at = ?, deprecated_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(now, reason ?? null, now, id);

    this.addEvent(id, 'deprecated', {
      oldValue: existing.status,
      newValue: 'deprecated',
      content: reason,
      actor,
    });

    return this.getEntity(id);
  }

  changeEntityStatus(id: string, status: EntityStatus, actor = 'system'): CodeEntity | null {
    const existing = this.getEntity(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE code_entities SET status = ?, updated_at = ? WHERE id = ?'
    ).run(status, now, id);

    this.addEvent(id, 'status_changed', {
      oldValue: existing.status,
      newValue: status,
      actor,
    });

    return this.getEntity(id);
  }

  // ============ 태그 ============

  addTag(entityId: string, tag: string, value?: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO code_entity_tags (entity_id, tag, value) VALUES (?, ?, ?)'
    ).run(entityId, tag, value ?? null);

    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE code_entities SET updated_at = ? WHERE id = ?'
    ).run(now, entityId);

    this.addEvent(entityId, 'tag_added', { newValue: tag });
  }

  removeTag(entityId: string, tag: string): void {
    this.db.prepare(
      'DELETE FROM code_entity_tags WHERE entity_id = ? AND tag = ?'
    ).run(entityId, tag);

    this.addEvent(entityId, 'tag_removed', { oldValue: tag });
  }

  getTags(entityId: string): EntityTag[] {
    return (this.db.prepare(
      'SELECT tag, value FROM code_entity_tags WHERE entity_id = ?'
    ).all(entityId) as TagRow[]).map(r => ({ tag: r.tag, value: r.value ?? undefined }));
  }

  // ============ 경고 ============

  addWarning(
    entityId: string, severity: WarningSeverity,
    category: WarningCategory, message: string,
  ): EntityWarning {
    const id = nanoid(12);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO code_entity_warnings (id, entity_id, severity, category, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, entityId, severity, category, message, now);

    this.db.prepare(
      'UPDATE code_entities SET updated_at = ? WHERE id = ?'
    ).run(now, entityId);

    this.addEvent(entityId, 'warning_added', {
      newValue: `${severity}:${category}`,
      content: message,
    });

    return {
      id, entityId, severity, category, message,
      resolved: false, createdAt: now,
    };
  }

  resolveWarning(warningId: string): boolean {
    const now = new Date().toISOString();
    const warning = this.db.prepare(
      'SELECT * FROM code_entity_warnings WHERE id = ?'
    ).get(warningId) as WarningRow | undefined;
    if (!warning) return false;

    this.db.prepare(
      'UPDATE code_entity_warnings SET resolved = 1, resolved_at = ? WHERE id = ?'
    ).run(now, warningId);

    this.addEvent(warning.entity_id, 'warning_resolved', {
      oldValue: `${warning.severity}:${warning.category}`,
      content: warning.message,
    });

    return true;
  }

  getWarnings(entityId: string): EntityWarning[] {
    return (this.db.prepare(
      'SELECT * FROM code_entity_warnings WHERE entity_id = ? ORDER BY created_at DESC'
    ).all(entityId) as WarningRow[]).map(this.rowToWarning);
  }

  getUnresolvedWarnings(severity?: WarningSeverity): EntityWarning[] {
    const where = severity
      ? 'WHERE resolved = 0 AND severity = ?'
      : 'WHERE resolved = 0';
    const params = severity ? [severity] : [];

    return (this.db.prepare(
      `SELECT * FROM code_entity_warnings ${where} ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
        created_at DESC`
    ).all(...params) as WarningRow[]).map(this.rowToWarning);
  }

  // ============ 관계 ============

  addRelation(sourceId: string, targetId: string, relationType: RelationType): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO code_entity_relations (source_id, target_id, relation_type) VALUES (?, ?, ?)'
    ).run(sourceId, targetId, relationType);
  }

  removeRelation(sourceId: string, targetId: string, relationType: RelationType): void {
    this.db.prepare(
      'DELETE FROM code_entity_relations WHERE source_id = ? AND target_id = ? AND relation_type = ?'
    ).run(sourceId, targetId, relationType);
  }

  getRelations(entityId: string): Array<{ targetId: string; targetName: string; relationType: RelationType }> {
    return (this.db.prepare(`
      SELECT r.target_id, e.name as target_name, r.relation_type
      FROM code_entity_relations r
      JOIN code_entities e ON e.id = r.target_id
      WHERE r.source_id = ?
    `).all(entityId) as RelationRow[]).map(r => ({
      targetId: r.target_id,
      targetName: r.target_name,
      relationType: r.relation_type as RelationType,
    }));
  }

  // ============ 관계 그래프 (스캐너 적재 + 질의) ============

  /**
   * 한 프로젝트의 모든 관계를 일괄 삭제 후 새로 적재한다.
   * 스캐너 2-pass에서 stale edge를 제거하기 위해 사용.
   * source_id가 해당 프로젝트 엔티티인 edge만 정리한다.
   */
  replaceRelationsForProject(
    projectId: string,
    relations: Array<{ sourceId: string; targetId: string; relationType: RelationType }>,
  ): number {
    const deleteStale = this.db.prepare(`
      DELETE FROM code_entity_relations
      WHERE source_id IN (SELECT id FROM code_entities WHERE project_id = ?)
    `);
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO code_entity_relations (source_id, target_id, relation_type) VALUES (?, ?, ?)'
    );
    const tx = this.db.transaction((rels: typeof relations) => {
      deleteStale.run(projectId);
      let n = 0;
      for (const r of rels) {
        const res = insert.run(r.sourceId, r.targetId, r.relationType);
        n += res.changes;
      }
      return n;
    });
    return tx(relations);
  }

  /** 정방향: 이 엔티티가 호출/사용하는 대상 (callees). */
  getOutgoingRelations(
    entityId: string,
    relationType?: RelationType,
  ): Array<{ targetId: string; targetName: string; targetFile: string; relationType: RelationType }> {
    const typeFilter = relationType ? 'AND r.relation_type = ?' : '';
    const params = relationType ? [entityId, relationType] : [entityId];
    return (this.db.prepare(`
      SELECT r.target_id, e.name as target_name, e.file_path as target_file, r.relation_type
      FROM code_entity_relations r
      JOIN code_entities e ON e.id = r.target_id
      WHERE r.source_id = ? ${typeFilter}
    `).all(...params) as Array<RelationRow & { target_file: string }>).map(r => ({
      targetId: r.target_id,
      targetName: r.target_name,
      targetFile: r.target_file,
      relationType: r.relation_type as RelationType,
    }));
  }

  /** 역방향: 이 엔티티를 호출/사용하는 주체 (callers). who-calls의 핵심. */
  getIncomingRelations(
    entityId: string,
    relationType?: RelationType,
  ): Array<{ sourceId: string; sourceName: string; sourceFile: string; relationType: RelationType }> {
    const typeFilter = relationType ? 'AND r.relation_type = ?' : '';
    const params = relationType ? [entityId, relationType] : [entityId];
    return (this.db.prepare(`
      SELECT r.source_id, e.name as source_name, e.file_path as source_file, r.relation_type
      FROM code_entity_relations r
      JOIN code_entities e ON e.id = r.source_id
      WHERE r.target_id = ? ${typeFilter}
    `).all(...params) as Array<{ source_id: string; source_name: string; source_file: string; relation_type: string }>).map(r => ({
      sourceId: r.source_id,
      sourceName: r.source_name,
      sourceFile: r.source_file,
      relationType: r.relation_type as RelationType,
    }));
  }

  /**
   * transitive 역방향 BFS — "X를 고치면 영향받는 엔티티 전체".
   * depth별로 grouping해 반환. 사이클 안전.
   */
  getImpactSet(
    rootEntityId: string,
    maxDepth = 5,
  ): Array<{ id: string; name: string; filePath: string; depth: number }> {
    const visited = new Set<string>([rootEntityId]);
    const result: Array<{ id: string; name: string; filePath: string; depth: number }> = [];
    let frontier = [rootEntityId];
    const stmt = this.db.prepare(`
      SELECT DISTINCT r.source_id, e.name, e.file_path
      FROM code_entity_relations r
      JOIN code_entities e ON e.id = r.source_id
      WHERE r.target_id = ?
    `);
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        const callers = stmt.all(id) as Array<{ source_id: string; name: string; file_path: string }>;
        for (const c of callers) {
          if (visited.has(c.source_id)) continue;
          visited.add(c.source_id);
          result.push({ id: c.source_id, name: c.name, filePath: c.file_path, depth });
          next.push(c.source_id);
        }
      }
      frontier = next;
    }
    return result;
  }

  /** 프로젝트 전체 정방향 edge를 source_id별로 그룹핑해 일괄 반환 (export N+1 방지). */
  getAllOutgoingRelations(projectId: string): Map<string, Array<{ name: string; type: RelationType }>> {
    const rows = this.db.prepare(`
      SELECT r.source_id, t.name as target_name, r.relation_type
      FROM code_entity_relations r
      JOIN code_entities s ON s.id = r.source_id
      JOIN code_entities t ON t.id = r.target_id
      WHERE s.project_id = ?
    `).all(projectId) as Array<{ source_id: string; target_name: string; relation_type: string }>;
    const map = new Map<string, Array<{ name: string; type: RelationType }>>();
    for (const r of rows) {
      const arr = map.get(r.source_id) ?? [];
      arr.push({ name: r.target_name, type: r.relation_type as RelationType });
      map.set(r.source_id, arr);
    }
    return map;
  }

  /** 이름(정확 일치)으로 active 엔티티 조회 — 관계 질의 진입점. */
  findEntitiesByName(name: string, projectId?: string): CodeEntity[] {
    const projFilter = projectId ? 'AND project_id = ?' : '';
    const params = projectId ? [name, projectId] : [name];
    const rows = this.db.prepare(`
      SELECT * FROM code_entities
      WHERE name = ? AND status != 'broken' ${projFilter}
    `).all(...params) as EntityRow[];
    return rows.map(r => this.rowToEntity(r));
  }

  /** 프로젝트 전체 relation 수 (검증/통계용). */
  countRelations(projectId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM code_entity_relations r
      WHERE r.source_id IN (SELECT id FROM code_entities WHERE project_id = ?)
    `).get(projectId) as CountRow;
    return row.cnt;
  }

  // ============ 이슈 연결 ============

  linkIssue(entityId: string, issueId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT OR IGNORE INTO code_entity_issue_links (entity_id, issue_id, linked_at) VALUES (?, ?, ?)'
    ).run(entityId, issueId, now);
    this.addEvent(entityId, 'issue_linked', { newValue: issueId });
  }

  unlinkIssue(entityId: string, issueId: string): void {
    this.db.prepare(
      'DELETE FROM code_entity_issue_links WHERE entity_id = ? AND issue_id = ?'
    ).run(entityId, issueId);
  }

  getLinkedIssues(entityId: string): string[] {
    return (this.db.prepare(
      'SELECT issue_id FROM code_entity_issue_links WHERE entity_id = ? ORDER BY linked_at'
    ).all(entityId) as IssueLinkRow[]).map(r => r.issue_id);
  }

  getEntitiesByIssueId(issueId: string): CodeEntity[] {
    const rows = this.db.prepare(
      'SELECT entity_id FROM code_entity_issue_links WHERE issue_id = ?'
    ).all(issueId) as IssueLinkRow[];

    const entities: CodeEntity[] = [];
    for (const row of rows) {
      const entity = this.getEntity(row.entity_id);
      if (entity) entities.push(entity);
    }
    return entities;
  }

  // ============ 이벤트 ============

  addEvent(entityId: string, type: EntityEventType, data?: EventData): EntityEvent {
    const id = nanoid(12);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO code_entity_events (id, entity_id, type, old_value, new_value, content, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, entityId, type,
      data?.oldValue ?? null, data?.newValue ?? null,
      data?.content ?? null, data?.actor ?? 'system', now,
    );

    return {
      id, entityId, type,
      oldValue: data?.oldValue,
      newValue: data?.newValue,
      content: data?.content,
      actor: data?.actor ?? 'system',
      createdAt: now,
    };
  }

  getEvents(entityId: string, limit = 50): EntityEvent[] {
    return (this.db.prepare(
      'SELECT * FROM code_entity_events WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(entityId, limit) as EventRow[]).map(this.rowToEvent);
  }

  // ============ 특화 쿼리 ============

  fileBrief(filePath: string): FileBrief {
    const rows = this.db.prepare(
      'SELECT * FROM code_entities WHERE file_path = ? ORDER BY line_start NULLS LAST, name'
    ).all(filePath) as EntityRow[];

    const entities = this.rowsToEntities(rows);

    const deprecated = entities.filter(e => e.status === 'deprecated').length;
    const untested = entities.filter(e => !e.hasTests).length;
    const warnings = entities.reduce((sum, e) => sum + e.warnings.filter(w => !w.resolved).length, 0);
    const broken = entities.filter(e => e.status === 'broken').length;

    const parts: string[] = [`${entities.length} entities`];
    if (deprecated > 0) parts.push(`${deprecated} deprecated`);
    if (untested > 0) parts.push(`${untested} untested`);
    if (warnings > 0) parts.push(`${warnings} warnings`);
    if (broken > 0) parts.push(`${broken} broken`);

    return {
      filePath,
      summary: parts.join(', '),
      entities,
    };
  }

  deprecatedEntities(projectId?: string): CodeEntity[] {
    const where = projectId
      ? "WHERE status = 'deprecated' AND project_id = ?"
      : "WHERE status = 'deprecated'";
    const params = projectId ? [projectId] : [];

    const rows = this.db.prepare(
      `SELECT * FROM code_entities ${where} ORDER BY deprecated_at DESC`
    ).all(...params) as EntityRow[];
    return this.rowsToEntities(rows);
  }

  untestedEntities(projectId?: string): CodeEntity[] {
    const where = projectId
      ? "WHERE has_tests = 0 AND status = 'active' AND project_id = ?"
      : "WHERE has_tests = 0 AND status = 'active'";
    const params = projectId ? [projectId] : [];

    const rows = this.db.prepare(
      `SELECT * FROM code_entities ${where} ORDER BY
        CASE risk_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        complexity_score DESC NULLS LAST`
    ).all(...params) as EntityRow[];
    return this.rowsToEntities(rows);
  }

  highRiskEntities(projectId?: string): CodeEntity[] {
    const where = projectId
      ? "WHERE risk_level = 'high' AND project_id = ?"
      : "WHERE risk_level = 'high'";
    const params = projectId ? [projectId] : [];

    const rows = this.db.prepare(
      `SELECT * FROM code_entities ${where} ORDER BY complexity_score DESC NULLS LAST`
    ).all(...params) as EntityRow[];
    return this.rowsToEntities(rows);
  }

  entitiesByTag(tag: string, value?: string): CodeEntity[] {
    const query = value
      ? `SELECT e.* FROM code_entities e
         JOIN code_entity_tags t ON t.entity_id = e.id
         WHERE t.tag = ? AND t.value = ?`
      : `SELECT e.* FROM code_entities e
         JOIN code_entity_tags t ON t.entity_id = e.id
         WHERE t.tag = ?`;
    const params = value ? [tag, value] : [tag];

    const rows = this.db.prepare(query).all(...params) as EntityRow[];
    return this.rowsToEntities(rows);
  }

  searchEntities(query: string, limit = 20, projectId?: string): CodeEntity[] {
    // projectId가 주어지면 해당 프로젝트로 스코프를 좁힌다. 미지정 시 전역 검색.
    const projClause = projectId ? 'AND e.project_id = ?' : '';
    const projClausePlain = projectId ? 'AND project_id = ?' : '';

    let ftsRows: EntityRow[] = [];
    try {
      const ftsParams: unknown[] = projectId ? [query, projectId, limit] : [query, limit];
      ftsRows = this.db.prepare(`
        SELECT e.* FROM code_entities e
        INNER JOIN code_entities_fts ON code_entities_fts.rowid = e.rowid
        WHERE code_entities_fts MATCH ? ${projClause}
        LIMIT ?
      `).all(...ftsParams) as EntityRow[];
    } catch (err) { // cxt-ignore: exception_hiding — FTS5 미지원/MATCH 오류 시 LIKE fallback으로 진행
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('fts5') && !msg.includes('MATCH')) {
        console.warn('[Registry] searchEntities FTS error:', msg);
      }
    }

    let results = this.rowsToEntities(ftsRows);

    if (results.length < limit) {
      const escapedQuery = query.replace(/[%_]/g, ch => `\\${ch}`);
      const likePattern = `%${escapedQuery}%`;
      const existingIds = new Set(results.map(e => e.id));
      const likeParams: unknown[] = [likePattern, likePattern, likePattern, likePattern, likePattern];
      if (projectId) likeParams.push(projectId);
      likeParams.push(limit);
      const fallbackRows = this.db.prepare(`
        SELECT * FROM code_entities
        WHERE (name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR signature LIKE ? ESCAPE '\\') ${projClausePlain}
        LIMIT ?
      `).all(...likeParams) as EntityRow[];
      const fallback = this.rowsToEntities(fallbackRows)
        .filter(e => !existingIds.has(e.id));

      results.push(...fallback.slice(0, limit - results.length));
    }

    return results;
  }

  // ============ 통계 ============

  getStats(projectId?: string): RegistryStats {
    // INT-1484: broken 엔티티는 stats에서 제외 — 좀비가 total/highRisk를 오염하지 않도록.
    const where = projectId
      ? "WHERE project_id = ? AND status != 'broken'"
      : "WHERE status != 'broken'";
    const params = projectId ? [projectId] : [];

    const total = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM code_entities ${where}`
    ).get(...params) as CountRow).cnt;

    const byKind = (this.db.prepare(
      `SELECT kind, COUNT(*) as cnt FROM code_entities ${where} GROUP BY kind`
    ).all(...params) as KindCountRow[]).map(r => ({ kind: r.kind, count: r.cnt }));

    const byStatus = (this.db.prepare(
      `SELECT status, COUNT(*) as cnt FROM code_entities ${where} GROUP BY status`
    ).all(...params) as StatusCountRow[]).map(r => ({ status: r.status, count: r.cnt }));

    const deprecated = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM code_entities ${where} AND status = 'deprecated'`
    ).get(...params) as CountRow).cnt;

    const untested = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM code_entities ${where} AND has_tests = 0 AND status = 'active'`
    ).get(...params) as CountRow).cnt;

    const highRisk = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM code_entities ${where} AND risk_level = 'high'`
    ).get(...params) as CountRow).cnt;

    const withWarnings = (this.db.prepare(
      projectId
        ? `SELECT COUNT(DISTINCT w.entity_id) as cnt FROM code_entity_warnings w
           JOIN code_entities e ON e.id = w.entity_id
           WHERE w.resolved = 0 AND e.project_id = ? AND e.status != 'broken'`
        : `SELECT COUNT(DISTINCT w.entity_id) as cnt FROM code_entity_warnings w
           JOIN code_entities e ON e.id = w.entity_id
           WHERE w.resolved = 0 AND e.status != 'broken'`
    ).get(...params) as CountRow).cnt;

    return { total, byKind, byStatus, deprecated, untested, highRisk, withWarnings };
  }

  // ============ 프로젝트 위생 (INT-1479) ============

  /** 등록된 프로젝트 목록 반환 — 엔티티 수 포함. */
  listProjects(): Array<{ projectId: string; entityCount: number; brokenCount: number }> {
    interface ProjRow { project_id: string; cnt: number; broken: number }
    const rows = this.db.prepare(`
      SELECT
        project_id,
        COUNT(*) as cnt,
        SUM(CASE WHEN status = 'broken' THEN 1 ELSE 0 END) as broken
      FROM code_entities
      GROUP BY project_id
      ORDER BY cnt DESC
    `).all() as ProjRow[];
    return rows.map(r => ({ projectId: r.project_id, entityCount: r.cnt, brokenCount: r.broken }));
  }

  /** 특정 프로젝트의 모든 엔티티·이벤트·관계를 삭제한다. */
  deleteProject(projectId: string): number {
    const result = this.db.prepare(
      "DELETE FROM code_entities WHERE project_id = ?"
    ).run(projectId);
    this.db.prepare(
      "DELETE FROM code_entity_relations WHERE source_id NOT IN (SELECT id FROM code_entities)"
    ).run();
    return result.changes;
  }

  /** broken 엔티티만 제거한다 (stale 참조 정리). */
  pruneBroken(projectId?: string): number {
    const stmt = projectId
      ? this.db.prepare("DELETE FROM code_entities WHERE status = 'broken' AND project_id = ?")
      : this.db.prepare("DELETE FROM code_entities WHERE status = 'broken'");
    const result = projectId ? stmt.run(projectId) : stmt.run();
    return result.changes;
  }

  /** 지정 일수보다 오래된 events 정리. 삭제된 행 수를 반환한다. */
  pruneEvents(olderThanDays = 30): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const result = this.db.prepare(
      "DELETE FROM code_entity_events WHERE created_at < ?"
    ).run(cutoff);
    return result.changes;
  }

  /** DB 파일 압축 (SQLite VACUUM). */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  // ============ 유틸 ============

  close(): void {
    this.db.close();
  }

  private rowToEntity(row: EntityRow): CodeEntity {
    const id = row.id;
    return this.buildEntity(row, this.getTags(id), this.getWarnings(id), this.getLinkedIssues(id));
  }

  // SQLite SQLITE_MAX_VARIABLE_NUMBER 한도(999)를 넘지 않도록 ID 배치를 분할.
  private static readonly BATCH_SIZE = 500;

  private rowsToEntities(rows: EntityRow[]): CodeEntity[] {
    if (rows.length === 0) return [];

    const ids = rows.map(r => r.id);

    // INT-1474: 단일 IN(?,?,...)이 999 변수 한도 초과하면 크래시 — 500개씩 청킹.
    const tagsByEntity = new Map<string, EntityTag[]>();
    const warningsByEntity = new Map<string, EntityWarning[]>();
    const issuesByEntity = new Map<string, string[]>();

    for (let i = 0; i < ids.length; i += SqliteRegistryStore.BATCH_SIZE) {
      const chunk = ids.slice(i, i + SqliteRegistryStore.BATCH_SIZE);
      const ph = chunk.map(() => '?').join(',');

      const tagRows = this.db.prepare(
        `SELECT entity_id, tag, value FROM code_entity_tags WHERE entity_id IN (${ph})`
      ).all(...chunk) as (TagRow & { entity_id: string })[];
      for (const r of tagRows) {
        const list = tagsByEntity.get(r.entity_id) ?? [];
        list.push({ tag: r.tag, value: r.value ?? undefined });
        tagsByEntity.set(r.entity_id, list);
      }

      const warningRows = this.db.prepare(
        `SELECT * FROM code_entity_warnings WHERE entity_id IN (${ph}) ORDER BY created_at DESC`
      ).all(...chunk) as WarningRow[];
      for (const r of warningRows) {
        const list = warningsByEntity.get(r.entity_id) ?? [];
        list.push(this.rowToWarning(r));
        warningsByEntity.set(r.entity_id, list);
      }

      const issueRows = this.db.prepare(
        `SELECT entity_id, issue_id FROM code_entity_issue_links WHERE entity_id IN (${ph}) ORDER BY linked_at`
      ).all(...chunk) as IssueLinkRow[];
      for (const r of issueRows) {
        const list = issuesByEntity.get(r.entity_id) ?? [];
        list.push(r.issue_id);
        issuesByEntity.set(r.entity_id, list);
      }
    }

    return rows.map(row => this.buildEntity(
      row,
      tagsByEntity.get(row.id) ?? [],
      warningsByEntity.get(row.id) ?? [],
      issuesByEntity.get(row.id) ?? [],
    ));
  }

  private buildEntity(
    row: EntityRow,
    tags: EntityTag[],
    warnings: EntityWarning[],
    linkedIssueIds: string[],
  ): CodeEntity {
    return {
      id: row.id,
      projectId: row.project_id,
      kind: row.kind as EntityKind,
      name: row.name,
      qualifiedName: row.qualified_name,
      filePath: row.file_path,
      lineStart: row.line_start ?? undefined,
      lineEnd: row.line_end ?? undefined,
      signature: row.signature ?? undefined,
      status: row.status as EntityStatus,
      deprecatedAt: row.deprecated_at ?? undefined,
      deprecatedReason: row.deprecated_reason ?? undefined,
      hasTests: row.has_tests === 1,
      testFile: row.test_file ?? undefined,
      author: row.author ?? undefined,
      maintainer: row.maintainer ?? undefined,
      complexityScore: row.complexity_score ?? undefined,
      riskLevel: row.risk_level as RiskLevel,
      description: row.description ?? '',
      notes: row.notes ?? '',
      tags,
      warnings,
      linkedIssueIds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToWarning(row: WarningRow): EntityWarning {
    return {
      id: row.id,
      entityId: row.entity_id,
      severity: row.severity as WarningSeverity,
      category: row.category as WarningCategory,
      message: row.message,
      resolved: row.resolved === 1,
      resolvedAt: row.resolved_at ?? undefined,
      createdAt: row.created_at,
    };
  }

  private rowToEvent(row: EventRow): EntityEvent {
    return {
      id: row.id,
      entityId: row.entity_id,
      type: row.type as EntityEventType,
      oldValue: row.old_value ?? undefined,
      newValue: row.new_value ?? undefined,
      content: row.content ?? undefined,
      actor: row.actor,
      createdAt: row.created_at,
    };
  }
}

// 싱글톤
let storeInstance: SqliteRegistryStore | null = null;

export function getRegistryStore(dbPath?: string): SqliteRegistryStore {
  if (!storeInstance) {
    storeInstance = new SqliteRegistryStore(dbPath);
  }
  return storeInstance;
}

export function closeRegistryStore(): void {
  if (storeInstance) {
    storeInstance.close();
    storeInstance = null;
  }
}
