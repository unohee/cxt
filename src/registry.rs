use rusqlite::{params, Connection};

/// 레지스트리에 저장되는 엔티티
#[derive(Debug)]
#[allow(dead_code)]
pub struct StoredEntity {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub file_path: String,
    pub line_start: usize,
    pub line_end: usize,
    pub signature: Option<String>,
    pub has_tests: bool,
    pub risk_level: String,
    pub complexity_score: u32,
}

/// 레지스트리 통계
pub struct Stats {
    pub total: usize,
    pub untested: usize,
    pub high_risk: usize,
    pub deprecated: usize,
}

pub struct Registry {
    conn: Connection,
}

impl Registry {
    /// ~/.ctx/registry.db 열기 (없으면 생성)
    pub fn open() -> Result<Self, Box<dyn std::error::Error>> {
        let db_dir = dirs::home_dir()
            .ok_or("home dir not found")?
            .join(".ctx");
        std::fs::create_dir_all(&db_dir)?;
        let db_path = db_dir.join("registry.db");

        let conn = Connection::open(&db_path)?;
        let reg = Self { conn };
        reg.migrate()?;
        Ok(reg)
    }

    fn migrate(&self) -> Result<(), Box<dyn std::error::Error>> {
        let _ = self.conn.pragma_update(None, "journal_mode", "WAL");
        let _ = self.conn.pragma_update(None, "foreign_keys", "ON");

        self.conn.execute_batch("
            CREATE TABLE IF NOT EXISTS code_entities (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                qualified_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                line_start INTEGER NOT NULL,
                line_end INTEGER NOT NULL,
                signature TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                has_tests INTEGER NOT NULL DEFAULT 0,
                complexity_score INTEGER NOT NULL DEFAULT 0,
                risk_level TEXT NOT NULL DEFAULT 'low',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(project_id, qualified_name)
            );

            CREATE INDEX IF NOT EXISTS idx_ce_project ON code_entities(project_id);
            CREATE INDEX IF NOT EXISTS idx_ce_file ON code_entities(project_id, file_path);
            CREATE INDEX IF NOT EXISTS idx_ce_status ON code_entities(project_id, status);
            CREATE INDEX IF NOT EXISTS idx_ce_risk ON code_entities(project_id, risk_level);
        ")?;

        // FTS5 (content-less — 수동 관리)
        self.conn.execute_batch("
            CREATE VIRTUAL TABLE IF NOT EXISTS code_entities_fts USING fts5(
                entity_id, name, qualified_name, signature
            );
        ")?;

        Ok(())
    }

    /// 엔티티 등록 또는 업데이트. 반환: (is_new, is_updated)
    pub fn upsert(
        &self,
        project_id: &str,
        qualified_name: &str,
        kind: &str,
        name: &str,
        file_path: &str,
        line_start: usize,
        line_end: usize,
        signature: Option<&str>,
        complexity_score: u32,
        risk_level: &str,
    ) -> Result<(bool, bool), Box<dyn std::error::Error>> {
        let id = format!("{project_id}::{qualified_name}");

        // 존재 여부 확인
        let existing: Option<(i64, i64)> = self.conn.query_row(
            "SELECT line_start, line_end FROM code_entities WHERE id = ?",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).ok();

        if let Some((old_start, old_end)) = existing {
            if old_start as usize != line_start || old_end as usize != line_end {
                self.conn.execute(
                    "UPDATE code_entities SET line_start=?, line_end=?, signature=?, complexity_score=?, risk_level=?, updated_at=datetime('now') WHERE id=?",
                    params![line_start as i64, line_end as i64, signature, complexity_score, risk_level, id],
                )?;
                self.update_fts(&id, name, qualified_name, signature)?;
                return Ok((false, true));
            }
            return Ok((false, false));
        }

        self.conn.execute(
            "INSERT INTO code_entities (id, project_id, kind, name, qualified_name, file_path, line_start, line_end, signature, complexity_score, risk_level) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            params![id, project_id, kind, name, qualified_name, file_path, line_start as i64, line_end as i64, signature, complexity_score, risk_level],
        )?;
        self.update_fts(&id, name, qualified_name, signature)?;

        Ok((true, false))
    }

    fn update_fts(&self, id: &str, name: &str, qname: &str, sig: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
        // 기존 엔트리 삭제 후 재삽입
        let _ = self.conn.execute(
            "DELETE FROM code_entities_fts WHERE entity_id=?", [id],
        );
        self.conn.execute(
            "INSERT INTO code_entities_fts (entity_id, name, qualified_name, signature) VALUES (?,?,?,?)",
            params![id, name, qname, sig.unwrap_or("")],
        )?;
        Ok(())
    }

    /// 프로젝트 파일에서 사라진 엔티티 제거
    pub fn remove_stale(&self, project_id: &str, file_path: &str, current_names: &[String]) -> Result<usize, Box<dyn std::error::Error>> {
        if current_names.is_empty() {
            return Ok(0);
        }
        // 해당 파일의 기존 엔티티 중 current_names에 없는 것 삭제
        let existing: Vec<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT qualified_name FROM code_entities WHERE project_id=? AND file_path=?"
            )?;
            let rows = stmt.query_map(params![project_id, file_path], |row| row.get(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let mut removed = 0;
        for qname in &existing {
            let entity_name = qname.split("::").last().unwrap_or(qname);
            if !current_names.contains(&entity_name.to_string()) {
                let id = format!("{project_id}::{qname}");
                self.conn.execute("DELETE FROM code_entities WHERE id=?", [&id])?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    pub fn stats(&self, project_id: &str) -> Result<Stats, Box<dyn std::error::Error>> {
        let total: usize = self.conn.query_row(
            "SELECT count(*) FROM code_entities WHERE project_id=? AND status='active'",
            [project_id], |r| r.get(0),
        )?;
        let untested: usize = self.conn.query_row(
            "SELECT count(*) FROM code_entities WHERE project_id=? AND status='active' AND has_tests=0",
            [project_id], |r| r.get(0),
        )?;
        let high_risk: usize = self.conn.query_row(
            "SELECT count(*) FROM code_entities WHERE project_id=? AND status='active' AND risk_level='high'",
            [project_id], |r| r.get(0),
        )?;
        let deprecated: usize = self.conn.query_row(
            "SELECT count(*) FROM code_entities WHERE project_id=? AND status='deprecated'",
            [project_id], |r| r.get(0),
        )?;
        Ok(Stats { total, untested, high_risk, deprecated })
    }

    pub fn count_by_kind(&self, project_id: &str) -> Result<Vec<(String, usize)>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT kind, count(*) FROM code_entities WHERE project_id=? AND status='active' GROUP BY kind ORDER BY count(*) DESC"
        )?;
        let rows = stmt.query_map([project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn list_by_file(&self, project_id: &str, file_path: &str) -> Result<Vec<StoredEntity>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, name, file_path, line_start, line_end, signature, has_tests, risk_level, complexity_score FROM code_entities WHERE project_id=? AND file_path=? AND status='active' ORDER BY line_start"
        )?;
        let rows = stmt.query_map(params![project_id, file_path], |row| {
            Ok(StoredEntity {
                id: row.get(0)?,
                kind: row.get(1)?,
                name: row.get(2)?,
                file_path: row.get(3)?,
                line_start: row.get(4)?,
                line_end: row.get(5)?,
                signature: row.get(6)?,
                has_tests: row.get::<_, i64>(7)? != 0,
                risk_level: row.get(8)?,
                complexity_score: row.get(9)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn list_untested(&self, project_id: &str) -> Result<Vec<StoredEntity>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, name, file_path, line_start, line_end, signature, has_tests, risk_level, complexity_score FROM code_entities WHERE project_id=? AND status='active' AND has_tests=0 ORDER BY risk_level DESC, file_path, line_start"
        )?;
        let rows = stmt.query_map([project_id], |row| {
            Ok(StoredEntity {
                id: row.get(0)?, kind: row.get(1)?, name: row.get(2)?,
                file_path: row.get(3)?, line_start: row.get(4)?, line_end: row.get(5)?,
                signature: row.get(6)?, has_tests: false, risk_level: row.get(8)?,
                complexity_score: row.get(9)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn list_high_risk(&self, project_id: &str) -> Result<Vec<StoredEntity>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, name, file_path, line_start, line_end, signature, has_tests, risk_level, complexity_score FROM code_entities WHERE project_id=? AND status='active' AND risk_level='high' ORDER BY file_path, line_start"
        )?;
        let rows = stmt.query_map([project_id], |row| {
            Ok(StoredEntity {
                id: row.get(0)?, kind: row.get(1)?, name: row.get(2)?,
                file_path: row.get(3)?, line_start: row.get(4)?, line_end: row.get(5)?,
                signature: row.get(6)?, has_tests: row.get::<_, i64>(7)? != 0,
                risk_level: "high".to_string(), complexity_score: row.get(9)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn list_deprecated(&self, project_id: &str) -> Result<Vec<StoredEntity>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, name, file_path, line_start, line_end, signature, has_tests, risk_level, complexity_score FROM code_entities WHERE project_id=? AND status='deprecated' ORDER BY file_path"
        )?;
        let rows = stmt.query_map([project_id], |row| {
            Ok(StoredEntity {
                id: row.get(0)?, kind: row.get(1)?, name: row.get(2)?,
                file_path: row.get(3)?, line_start: row.get(4)?, line_end: row.get(5)?,
                signature: row.get(6)?, has_tests: row.get::<_, i64>(7)? != 0,
                risk_level: row.get(8)?, complexity_score: row.get(9)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn search(&self, project_id: &str, query: &str) -> Result<Vec<StoredEntity>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT ce.id, ce.kind, ce.name, ce.file_path, ce.line_start, ce.line_end, ce.signature, ce.has_tests, ce.risk_level, ce.complexity_score FROM code_entities_fts fts JOIN code_entities ce ON ce.id = fts.entity_id WHERE ce.project_id=? AND code_entities_fts MATCH ? LIMIT 50"
        )?;
        let rows = stmt.query_map(params![project_id, query], |row| {
            Ok(StoredEntity {
                id: row.get(0)?, kind: row.get(1)?, name: row.get(2)?,
                file_path: row.get(3)?, line_start: row.get(4)?, line_end: row.get(5)?,
                signature: row.get(6)?, has_tests: row.get::<_, i64>(7)? != 0,
                risk_level: row.get(8)?, complexity_score: row.get(9)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}
