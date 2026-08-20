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

function boundedPagination(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved)) throw new RangeError(`${name} must be finite`);
  return Math.min(max, Math.max(min, Math.trunc(resolved)));
}

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
  isExported?: boolean;
  loc?: number;
  nestingDepth?: number;
  paramCount?: number;
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
  isExported?: boolean;
  loc?: number;
  nestingDepth?: number;
  paramCount?: number;
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
  is_exported: number | null;
  loc: number | null;
  nesting_depth: number | null;
  param_count: number | null;
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
  // INT-3881: v3 = relations 역방향 인덱스 + scanner 메트릭 컬럼 회수(is_exported/loc/
  //           nesting_depth/param_count) + status/risk_level CHECK 제약(테이블 리빌드).
  //           kind CHECK는 의도적으로 제외 — P1(tree-sitter 프론트엔드)에서 EntityKind가
  //           확장될 가능성이 높아 지금 고정하면 또 한 번의 리빌드를 강제한다.
  //           relations의 relation_type CHECK는 P2 v4(code_call_sites 신설)에서 함께 처리.
  private static readonly SCHEMA_VERSION = 3;

  // FTS 인덱스 스키마(인덱싱 컬럼 집합)가 마지막으로 바뀐 버전. user_version 승급과
  // 분리한다 — v2까지는 "버전이 오르면 무조건 rebuild"였는데, 그 결합은 FTS와 무관한
  // 마이그레이션(v3+)까지 전체 rebuild를 강제한다(396k 엔티티에서 3.3s, INT-1478).
  private static readonly FTS_SCHEMA_VERSION = 2;

  // 엔티티 테이블의 정본 컬럼 목록 — DDL·리빌드 INSERT가 전부 여기서 파생된다.
  // 복제된 DDL 3벌(초기/v2/v3)이 조용히 어긋나는 드리프트를 차단.
  private static readonly ENTITY_COLUMNS = [
    'id', 'project_id', 'kind', 'name', 'qualified_name', 'file_path',
    'line_start', 'line_end', 'signature', 'status',
    'deprecated_at', 'deprecated_reason', 'has_tests', 'test_file',
    'author', 'maintainer', 'complexity_score', 'risk_level',
    'is_exported', 'loc', 'nesting_depth', 'param_count',
    'description', 'notes', 'created_at', 'updated_at',
  ] as const;

  // 정본 테이블 DDL. kind CHECK는 의도적으로 없다 — P1(tree-sitter 프론트엔드)에서
  // EntityKind 확장이 예정돼 있어 지금 고정하면 또 한 번의 테이블 리빌드를 강제한다.
  private static entityTableDdl(tableName: string, ifNotExists = false): string {
    return `
      CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_start INTEGER,
        line_end INTEGER,
        signature TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        deprecated_at TEXT,
        deprecated_reason TEXT,
        has_tests INTEGER DEFAULT 0,
        test_file TEXT,
        author TEXT,
        maintainer TEXT,
        complexity_score INTEGER,
        risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
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
      );`;
  }

  // 리빌드 대상 테이블에 CHECK가 걸리므로, 위반이 될 행을 먼저 유효값으로 정정한다.
  // 행을 떨어뜨리는 INSERT OR IGNORE의 침묵 유실 대신 명시적 정정 + stderr 1줄 고지.
  private coerceInvalidEnumRows(): void {
    const coercedStatus = this.db.prepare(
      "UPDATE code_entities SET status = 'active' WHERE status IS NULL OR status NOT IN ('active','deprecated','experimental','planned','broken')"
    ).run().changes;
    const coercedRisk = this.db.prepare(
      "UPDATE code_entities SET risk_level = 'low' WHERE risk_level IS NULL OR risk_level NOT IN ('low','medium','high')"
    ).run().changes;
    if (coercedStatus + coercedRisk > 0) {
      console.error(`[cxt migrate] coerced ${coercedStatus} invalid status / ${coercedRisk} invalid risk_level rows to defaults`);
    }
  }

  private migrate(): void {
    const currentVersion = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;

    // ── 초기 테이블 생성 (idempotent) ──
    this.db.exec(SqliteRegistryStore.entityTableDdl('code_entities', true));

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
    // 주의: v3 신규 컬럼(is_exported 등)은 여기가 아니라 아래 v3 단계에서 추가한다.
    // 레거시 리빌드(v1→v2, line_start)가 `SELECT *`로 복사하므로, 리빌드 전에 컬럼을
    // 추가하면 대상 테이블(22컬럼)과 소스(26컬럼)의 컬럼 수가 어긋나 마이그레이션이 깨진다.
    for (const [col, sql] of addColMigrations) {
      if (!existingCols.has(col)) {
        this.db.exec(sql);
      }
    }

    // 테이블 리빌드 발생 추적 — 리빌드는 rowid를 재할당하므로 external-content FTS의
    // rowid 매핑이 깨진다. 리빌드가 하나라도 발생하면 FTS rebuild를 강제해야 한다.
    // (v2까지는 "버전 승급 = 무조건 rebuild"라 우연히 안전했던 결합을 명시적으로 대체.)
    let tableRebuilt = false;

    // ── v1 → v2: qualified_name 전역 UNIQUE → UNIQUE(project_id, qualified_name) ──
    // 구 스키마는 qualified_name에 단일 UNIQUE 인덱스가 있어 다른 project_id에서
    // 같은 파일 경로의 엔티티가 INSERT되면 충돌. 복합 제약으로 교체한다.
    if (currentVersion < 2) {
      const indexInfo = this.db.prepare('PRAGMA index_list(code_entities)').all() as Array<{ name: string; unique: number }>;
      const hasOldUniqueOnQName = indexInfo.some((idx) => {
        if (idx.unique !== 1) return false;
        const escapedName = idx.name.replace(/"/g, '""');
        const columns = this.db.prepare(`PRAGMA index_info("${escapedName}")`).all() as Array<{ name: string }>;
        return columns.length === 1 && columns[0].name === 'qualified_name';
      });

      if (hasOldUniqueOnQName) {
        // 테이블 재생성으로 제약 변경 (SQLite는 DROP CONSTRAINT 미지원).
        // 타깃은 현행 정본 DDL(v3 형태, CHECK 포함) — 이 경로를 지난 DB는 v3 리빌드가
        // 다시 필요 없다. CHECK 위반이 될 행은 복사 전에 정정한다.
        this.coerceInvalidEnumRows();

        // 소스 컬럼 집합은 DB 세대에 따라 다르다(진짜 v1 = 22개, 현행 스키마에서 파생된
        // 테스트 픽스처 = 26개). SELECT * 는 컬럼 수/순서 불일치로 깨지므로, 정본 컬럼
        // 목록과 소스의 교집합을 명시 나열한다. 이름은 고정 allowlist에서만 나온다.
        const v2SrcCols = new Set(
          (this.db.prepare("PRAGMA table_info(code_entities)").all() as Array<{ name: string }>).map(r => r.name)
        );
        const v2CopyCols = SqliteRegistryStore.ENTITY_COLUMNS.filter(c => v2SrcCols.has(c)).join(', ');

        this.db.pragma('foreign_keys = OFF');
        try {
          this.db.transaction(() => this.db.exec(`
          DROP TRIGGER IF EXISTS ce_fts_ai;
          DROP TRIGGER IF EXISTS ce_fts_ad;
          DROP TRIGGER IF EXISTS ce_fts_au;
          DROP TABLE IF EXISTS code_entities_fts;
          DROP TABLE IF EXISTS code_entities_v2;

          ${SqliteRegistryStore.entityTableDdl('code_entities_v2')}
          INSERT OR IGNORE INTO code_entities_v2 (${v2CopyCols})
            SELECT ${v2CopyCols} FROM code_entities;
          DROP TABLE code_entities;
          ALTER TABLE code_entities_v2 RENAME TO code_entities;
          `))();
          tableRebuilt = true;
        } finally {
          this.db.pragma('foreign_keys = ON');
        }
      }
    }

    // ── line_start/line_end NOT NULL → nullable 마이그레이션 (레거시) ──
    const refreshedColInfo = this.db.prepare("PRAGMA table_info(code_entities)").all() as Array<{ name: string; notnull: number }>;
    const refreshedCols = new Map(refreshedColInfo.map(r => [r.name, r]));
    const lineStartCol = refreshedCols.get('line_start');
    if (lineStartCol && lineStartCol.notnull === 1) {
      this.db.pragma('foreign_keys = OFF');
      try {
        this.db.transaction(() => this.db.exec(`
        DROP TRIGGER IF EXISTS ce_fts_ai;
        DROP TRIGGER IF EXISTS ce_fts_ad;
        DROP TRIGGER IF EXISTS ce_fts_au;
        DROP TABLE IF EXISTS code_entities_fts;
        DROP TABLE IF EXISTS code_entities_new;

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
        `))();
        tableRebuilt = true;
      } finally {
        this.db.pragma('foreign_keys = ON');
      }
    }

    // ── v2 → v3 (INT-3881): scanner 메트릭 컬럼 회수 + status/risk_level CHECK ──
    // 반드시 레거시 리빌드(v1→v2, line_start) 뒤에서 실행 — 그 단계들은 SELECT * 복사라
    // 새 컬럼이 먼저 추가되면 컬럼 수가 어긋난다. 컬럼 추가는 idempotent하게 항상 검사.
    {
      const v3ColInfo = this.db.prepare("PRAGMA table_info(code_entities)").all() as Array<{ name: string }>;
      const v3Cols = new Set(v3ColInfo.map(r => r.name));
      const v3AddCols: Array<[string, string]> = [
        ['is_exported', 'ALTER TABLE code_entities ADD COLUMN is_exported INTEGER DEFAULT 0'],
        ['loc', 'ALTER TABLE code_entities ADD COLUMN loc INTEGER'],
        ['nesting_depth', 'ALTER TABLE code_entities ADD COLUMN nesting_depth INTEGER'],
        ['param_count', 'ALTER TABLE code_entities ADD COLUMN param_count INTEGER'],
      ];
      for (const [col, sql] of v3AddCols) {
        if (!v3Cols.has(col)) this.db.exec(sql);
      }

      // CHECK 제약은 CREATE TABLE에서만 선언 가능 → 없는 기존 테이블은 리빌드로 교체.
      // kind CHECK는 의도적으로 제외(P1에서 EntityKind 확장 예정 — 지금 고정하면 또 리빌드).
      const tableSqlRow = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='code_entities'"
      ).get() as { sql: string } | undefined;
      // v3 스키마 판정은 버전이 아니라 **테이블 상태**로 한다 (PR #7 리뷰 2건 반영):
      // (1) CHECK 2종을 각각 검사 — status CHECK 하나를 증거로 삼으면 반쪽 스키마가
      //     risk_level CHECK 없이 봉인된다.
      // (2) NOT NULL 2종도 요구 — SQLite CHECK는 NULL에 대해 통과하므로(3-valued logic)
      //     NOT NULL 없이는 명시적 NULL insert가 enum 불변식을 우회한다.
      // 상태 기반이라, 과거에 어떤 형태로 user_version 3이 찍혔든 다음 오픈에서 자가 치유된다.
      const hasStatusCheck = !!tableSqlRow && /CHECK\s*\(\s*status\s+IN/i.test(tableSqlRow.sql);
      const hasRiskCheck = !!tableSqlRow && /CHECK\s*\(\s*risk_level\s+IN/i.test(tableSqlRow.sql);
      const v3NotNull = new Map(
        (this.db.prepare("PRAGMA table_info(code_entities)").all() as Array<{ name: string; notnull: number }>)
          .map(r => [r.name, r.notnull === 1])
      );
      const hasV3Schema = hasStatusCheck && hasRiskCheck
        && v3NotNull.get('status') === true && v3NotNull.get('risk_level') === true;

      if (!hasV3Schema) {
        // 보존 우선: CHECK 위반이 될 행을 먼저 유효값으로 정정한 뒤 straight INSERT로
        // 복사한다 — 행을 떨어뜨리는 INSERT OR IGNORE의 침묵 유실을 차단.
        this.coerceInvalidEnumRows();

        // 위에서 v3 컬럼 4개를 보강했으므로 소스는 정본 컬럼 전체를 보유한다.
        const v3CopyCols = SqliteRegistryStore.ENTITY_COLUMNS.join(', ');

        this.db.pragma('foreign_keys = OFF');
        try {
          this.db.transaction(() => this.db.exec(`
          DROP TRIGGER IF EXISTS ce_fts_ai;
          DROP TRIGGER IF EXISTS ce_fts_ad;
          DROP TRIGGER IF EXISTS ce_fts_au;
          DROP TABLE IF EXISTS code_entities_fts;
          DROP TABLE IF EXISTS code_entities_v3;

          ${SqliteRegistryStore.entityTableDdl('code_entities_v3')}
          INSERT INTO code_entities_v3 (${v3CopyCols})
            SELECT ${v3CopyCols} FROM code_entities;
          DROP TABLE code_entities;
          ALTER TABLE code_entities_v3 RENAME TO code_entities;
          `))();
          tableRebuilt = true;
        } finally {
          this.db.pragma('foreign_keys = ON');
        }
      }
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
      -- INT-3881(v3): 역방향 조회 인덱스. relations의 유일한 인덱스였던 PK는 선두가
      -- source_id라 who-calls/impact의 WHERE target_id = ? 가 매 홉 풀스캔이었다.
      CREATE INDEX IF NOT EXISTS idx_cer_target ON code_entity_relations(target_id, relation_type);
    `);

    // ── FTS 가상 테이블 + 트리거 ──
    // INT-1478: 최초 1회 또는 FTS 인덱싱 컬럼이 실제로 바뀐 버전에서만 rebuild.
    // INT-3881: user_version 승급과 분리 — FTS 무관 마이그레이션(v3+)이 전체 rebuild를
    // 강제하지 않도록. 단 테이블 리빌드가 일어났다면 rowid가 재할당됐으므로 강제 rebuild.
    const needsFtsRebuild = currentVersion < SqliteRegistryStore.FTS_SCHEMA_VERSION || tableRebuilt;

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
      this.db.exec("INSERT INTO code_entities_fts(code_entities_fts) VALUES('rebuild')");
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

    // 버전 기록 (마이그레이션이 모두 끝난 뒤) — FTS rebuild 여부와 무관하게 승급한다.
    if (currentVersion < SqliteRegistryStore.SCHEMA_VERSION) {
      this.db.pragma(`user_version = ${SqliteRegistryStore.SCHEMA_VERSION}`);
    }
  }

  // ============ 엔티티 CRUD ============

  /** 여러 공개 저장 연산을 하나의 원자적 작업으로 묶는다. */
  runInTransaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  registerEntity(input: RegisterEntityInput): CodeEntity {
    const id = nanoid(12);
    const now = new Date().toISOString();
    const qualifiedName = `${input.filePath}::${input.name}`;

    const insertEntity = this.db.prepare(`
      INSERT INTO code_entities (
        id, project_id, kind, name, qualified_name, file_path,
        line_start, line_end, signature, status,
        has_tests, test_file, author, maintainer,
        complexity_score, risk_level,
        is_exported, loc, nesting_depth, param_count,
        description, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.isExported ? 1 : 0, input.loc ?? null,
        input.nestingDepth ?? null, input.paramCount ?? null,
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

  getEntityByName(qualifiedName: string, projectId?: string): CodeEntity | null {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM code_entities WHERE qualified_name = ? AND project_id = ? LIMIT 1').all(qualifiedName, projectId) as EntityRow[]
      : this.db.prepare('SELECT * FROM code_entities WHERE qualified_name = ? LIMIT 2').all(qualifiedName) as EntityRow[];
    if (!projectId && rows.length !== 1) return null;
    const row = rows[0];
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
      riskLevel: 'risk_level',
      isExported: 'is_exported', loc: 'loc',
      nestingDepth: 'nesting_depth', paramCount: 'param_count',
      description: 'description', notes: 'notes',
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in patch && (patch as Record<string, unknown>)[key] !== undefined) {
        const val = (patch as Record<string, unknown>)[key];
        fields.push(`${col} = ?`);
        values.push(key === 'hasTests' || key === 'isExported' ? (val ? 1 : 0) : (val ?? null));
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

    const ftsJoin = '';
    if (filter?.search) {
      conditions.push(`(
        instr(lower(e.name), lower(?)) > 0 OR
        instr(lower(e.qualified_name), lower(?)) > 0 OR
        instr(lower(e.description), lower(?)) > 0 OR
        instr(lower(e.notes), lower(?)) > 0 OR
        instr(lower(COALESCE(e.signature, '')), lower(?)) > 0
      )`);
      params.push(filter.search, filter.search, filter.search, filter.search, filter.search);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = boundedPagination(filter?.limit, 50, 1, 100_000, 'limit');
    const offset = boundedPagination(filter?.offset, 0, 0, 10_000_000, 'offset');

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
   * transitive 역방향 도달 집합 — "X를 고치면 영향받는 엔티티 전체".
   * INT-3881(v3): JS BFS → 재귀 CTE. 홉마다 prepared statement를 재실행하던 왕복을
   * 단일 쿼리로 대체하고, idx_cer_target 인덱스가 JOIN을 서비스한다.
   *
   * BFS 시맨틱 보존 노트:
   * - UNION(not ALL)이 (id, depth) 튜플을 dedup하고 depth < maxDepth가 사이클을 종결.
   * - MIN(depth)가 기존 visited-set BFS의 "최단 거리" 시맨틱을 재현.
   * - root 제외는 depth 조건이 아니라 id != root — 사이클로 root에 depth>0으로
   *   재도달한 행이 GROUP BY 전에 depth 필터를 통과해 살아남는 것을 막는다.
   * - 결과는 depth 오름차순(같은 depth 내 이름순) — 소비자는 depth 그룹핑만 가정한다.
   */
  getImpactSet(
    rootEntityId: string,
    maxDepth = 5,
  ): Array<{ id: string; name: string; filePath: string; depth: number }> {
    const rows = this.db.prepare(`
      WITH RECURSIVE impact(id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT r.source_id, i.depth + 1
        FROM code_entity_relations r
        JOIN impact i ON r.target_id = i.id
        WHERE i.depth < ?
      )
      SELECT i.id, e.name, e.file_path, MIN(i.depth) AS depth
      FROM impact i
      JOIN code_entities e ON e.id = i.id
      WHERE i.id != ?
      GROUP BY i.id
      ORDER BY depth ASC, e.name ASC
    `).all(rootEntityId, maxDepth, rootEntityId) as Array<{ id: string; name: string; file_path: string; depth: number }>;

    return rows.map(r => ({ id: r.id, name: r.name, filePath: r.file_path, depth: r.depth }));
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

  /** qualifiedName 정확 일치 active 엔티티 조회. 전체 레지스트리 페이지 순회를 피한다. */
  findEntityByQualifiedName(qualifiedName: string, projectId: string): CodeEntity | undefined {
    const row = this.db.prepare(`
      SELECT * FROM code_entities
      WHERE qualified_name = ? AND project_id = ? AND status != 'broken'
      LIMIT 1
    `).get(qualifiedName, projectId) as EntityRow | undefined;
    return row ? this.rowToEntity(row) : undefined;
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
    limit = boundedPagination(limit, 50, 1, 100_000, 'limit');
    return (this.db.prepare(
      'SELECT * FROM code_entity_events WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(entityId, limit) as EventRow[]).map(this.rowToEvent);
  }

  // ============ 특화 쿼리 ============

  fileBrief(filePath: string, projectId: string): FileBrief {
    const rows = this.db.prepare(
      'SELECT * FROM code_entities WHERE file_path = ? AND project_id = ? ORDER BY line_start NULLS LAST, name'
    ).all(filePath, projectId) as EntityRow[];

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
    const params: Array<string | number> = projectId ? [projectId] : [];

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

  highRiskEntities(projectId?: string, limit?: number): CodeEntity[] {
    const where = projectId
      ? "WHERE risk_level = 'high' AND project_id = ?"
      : "WHERE risk_level = 'high'";
    const params: Array<string | number> = projectId ? [projectId] : [];

    const limitClause = limit === undefined ? '' : ' LIMIT ?';
    if (limit !== undefined) params.push(Math.max(0, Math.trunc(limit)));
    const rows = this.db.prepare(
      `SELECT * FROM code_entities ${where} ORDER BY complexity_score DESC NULLS LAST${limitClause}`
    ).all(...params) as EntityRow[];
    return this.rowsToEntities(rows);
  }

  entitiesByTag(tag: string, value?: string, projectId?: string): CodeEntity[] {
    const projectClause = projectId ? ' AND e.project_id = ?' : '';
    const query = value
      ? `SELECT e.* FROM code_entities e
         JOIN code_entity_tags t ON t.entity_id = e.id
         WHERE t.tag = ? AND t.value = ?${projectClause}`
      : `SELECT e.* FROM code_entities e
         JOIN code_entity_tags t ON t.entity_id = e.id
         WHERE t.tag = ?${projectClause}`;
    const params = value ? [tag, value] : [tag];
    if (projectId) params.push(projectId);

    const rows = this.db.prepare(query).all(...params) as EntityRow[];
    return this.rowsToEntities(rows);
  }

  searchEntities(query: string, limit = 20, projectId?: string, dir?: string): CodeEntity[] {
    limit = boundedPagination(limit, 20, 1, 100_000, 'limit');
    // projectId가 주어지면 해당 프로젝트로 스코프를 좁힌다. 미지정 시 전역 검색.
    const projClause = projectId ? 'AND e.project_id = ?' : '';
    const projClausePlain = projectId ? 'AND project_id = ?' : '';
    const prefix = dir ? `${dir}/` : undefined;
    const dirClause = dir ? 'AND (e.file_path = ? OR substr(e.file_path, 1, ?) = ?)' : '';
    const dirClausePlain = dir ? 'AND (file_path = ? OR substr(file_path, 1, ?) = ?)' : '';

    let ftsRows: EntityRow[] = [];
    try {
      const ftsParams: unknown[] = [query];
      if (projectId) ftsParams.push(projectId);
      if (dir && prefix) ftsParams.push(dir, prefix.length, prefix);
      ftsParams.push(limit);
      ftsRows = this.db.prepare(`
        SELECT e.* FROM code_entities e
        INNER JOIN code_entities_fts ON code_entities_fts.rowid = e.rowid
        WHERE code_entities_fts MATCH ? ${projClause} ${dirClause}
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
      if (dir && prefix) likeParams.push(dir, prefix.length, prefix);
      likeParams.push(limit);
      const fallbackRows = this.db.prepare(`
        SELECT * FROM code_entities
        WHERE (name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR signature LIKE ? ESCAPE '\\') ${projClausePlain} ${dirClausePlain}
        LIMIT ?
      `).all(...likeParams) as EntityRow[];
      const fallback = this.rowsToEntities(fallbackRows)
        .filter(e => !existingIds.has(e.id));

      results.push(...fallback.slice(0, limit - results.length));
    }

    return results;
  }

  // ============ 통계 ============

  getStats(projectId?: string, dir?: string): RegistryStats {
    // INT-1484: broken 엔티티는 stats에서 제외 — 좀비가 total/highRisk를 오염하지 않도록.
    const prefix = dir ? `${dir}/` : undefined;
    const where = `${projectId ? 'WHERE project_id = ?' : 'WHERE 1 = 1'} AND status != 'broken'${dir ? ' AND (file_path = ? OR substr(file_path, 1, ?) = ?)' : ''}`;
    const params: Array<string | number> = projectId ? [projectId] : [];
    if (dir && prefix) params.push(dir, prefix.length, prefix);

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

    const warningWhere = `${projectId ? 'AND e.project_id = ?' : ''}${dir ? ' AND (e.file_path = ? OR substr(e.file_path, 1, ?) = ?)' : ''}`;
    const withWarnings = (this.db.prepare(
      `SELECT COUNT(DISTINCT w.entity_id) as cnt FROM code_entity_warnings w
       JOIN code_entities e ON e.id = w.entity_id
       WHERE w.resolved = 0 AND e.status != 'broken' ${warningWhere}`
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
    const deleteRelations = this.db.prepare(`
      DELETE FROM code_entity_relations
      WHERE source_id IN (SELECT id FROM code_entities WHERE project_id = ?)
         OR target_id IN (SELECT id FROM code_entities WHERE project_id = ?)
    `);
    const deleteEntities = this.db.prepare('DELETE FROM code_entities WHERE project_id = ?');
    const tx = this.db.transaction((id: string) => {
      deleteRelations.run(id, id);
      return deleteEntities.run(id).changes;
    });
    return tx(projectId);
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
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      throw new RangeError('olderThanDays must be a finite non-negative number');
    }
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
      isExported: row.is_exported == null ? undefined : row.is_exported === 1,
      loc: row.loc ?? undefined,
      nestingDepth: row.nesting_depth ?? undefined,
      paramCount: row.param_count ?? undefined,
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
let storeInstancePath: string | null = null;

export function getRegistryStore(dbPath?: string): SqliteRegistryStore {
  const requestedPath = resolve(dbPath ?? DEFAULT_DB_PATH);
  if (!storeInstance) {
    storeInstance = new SqliteRegistryStore(requestedPath);
    storeInstancePath = requestedPath;
  } else if (dbPath !== undefined && requestedPath !== storeInstancePath) {
    throw new Error(`Registry store is already open at ${storeInstancePath}; requested ${requestedPath}`);
  }
  return storeInstance;
}

export function closeRegistryStore(): void {
  if (storeInstance) {
    storeInstance.close();
    storeInstance = null;
    storeInstancePath = null;
  }
}
