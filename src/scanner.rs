use std::path::Path;
use std::time::Instant;
use walkdir::WalkDir;

use crate::parser;
use crate::registry::Registry;

/// 스캔 결과
pub struct ScanResult {
    pub files_scanned: usize,
    pub entities_found: usize,
    pub new_registered: usize,
    pub updated: usize,
    pub duration_ms: u128,
}

/// 스킵할 디렉토리
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    "dist", "build", "target", ".tox", ".mypy_cache",
    ".pytest_cache", ".next", "coverage", ".eggs",
    "egg-info", ".cargo", ".rustup",
];

/// 코드베이스 스캔 → 레지스트리 동기화
pub fn scan_repository(
    reg: &Registry,
    root: &Path,
    project_id: &str,
    verbose: bool,
) -> Result<ScanResult, Box<dyn std::error::Error>> {
    let start = Instant::now();
    let mut files_scanned = 0;
    let mut entities_found = 0;
    let mut new_registered = 0;
    let mut updated = 0;

    for entry in WalkDir::new(root)
        .max_depth(15)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !SKIP_DIRS.contains(&name.as_ref()) && !name.starts_with('.');
            }
            true
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e,
            None => continue,
        };

        if !parser::is_supported_ext(ext) {
            continue;
        }

        // 512KB 이상 스킵
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > 512 * 1024 {
                continue;
            }
        }

        let source = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let entities = parser::extract_entities(path, &source);
        if entities.is_empty() {
            continue;
        }

        files_scanned += 1;

        // 상대 경로
        let rel_path = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        let mut file_entity_names = Vec::new();

        for entity in &entities {
            entities_found += 1;
            let qualified = format!("{rel_path}::{}", entity.name);
            file_entity_names.push(entity.name.clone());

            let risk = if entity.complexity_score >= 8 {
                "high"
            } else if entity.complexity_score >= 5 {
                "medium"
            } else {
                "low"
            };

            let (is_new, is_updated) = reg.upsert(
                project_id,
                &qualified,
                &entity.kind,
                &entity.name,
                &rel_path,
                entity.line_start,
                entity.line_end,
                entity.signature.as_deref(),
                entity.complexity_score,
                risk,
            )?;

            if is_new {
                new_registered += 1;
            }
            if is_updated {
                updated += 1;
            }
        }

        // stale 엔티티 제거
        reg.remove_stale(project_id, &rel_path, &file_entity_names)?;

        if verbose {
            println!(
                "  [scan] {}: {} entities ({})",
                rel_path,
                entities.len(),
                ext
            );
        }
    }

    Ok(ScanResult {
        files_scanned,
        entities_found,
        new_registered,
        updated,
        duration_ms: start.elapsed().as_millis(),
    })
}
