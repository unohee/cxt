use clap::{Parser, Subcommand};
use colored::Colorize;
use std::path::PathBuf;

use crate::bs;
use crate::registry::Registry;
use crate::scanner;

#[derive(Parser)]
#[command(name = "ctx", version, about = "Code context toolkit")]
pub struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 코드베이스 스캔 → 레지스트리에 엔티티 등록
    Scan {
        /// 스캔할 디렉토리 (기본: 현재 디렉토리)
        #[arg(default_value = ".")]
        path: PathBuf,
        /// 상세 출력
        #[arg(short, long)]
        verbose: bool,
    },
    /// 파일 또는 전체 레지스트리 조회
    Check {
        /// 조회할 파일 경로
        file: Option<PathBuf>,
        /// 전체 통계
        #[arg(long)]
        stats: bool,
        /// 테스트 없는 엔티티
        #[arg(long)]
        untested: bool,
        /// 고위험 엔티티
        #[arg(long, name = "high-risk")]
        high_risk: bool,
        /// deprecated 엔티티
        #[arg(long)]
        deprecated: bool,
        /// 전문 검색
        #[arg(long)]
        search: Option<String>,
    },
    /// Bad Smell 패턴 감지
    Bs {
        /// 스캔할 디렉토리 (기본: 현재 디렉토리)
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    /// Claude Code 세션 시작 시 컨텍스트 주입용 요약 출력
    Inject {
        /// 대상 디렉토리 (기본: 현재 디렉토리)
        #[arg(default_value = ".")]
        path: PathBuf,
    },
}

impl Cli {
    pub fn parse_args() -> Self {
        Self::parse()
    }

    pub fn run(&self) -> Result<(), Box<dyn std::error::Error>> {
        let reg = Registry::open()?;

        match &self.command {
            Command::Scan { path, verbose } => {
                let path = std::fs::canonicalize(path)?;
                let project_id = project_id_from_path(&path);
                let result = scanner::scan_repository(&reg, &path, &project_id, *verbose)?;

                println!("{}", "Scan Complete".bold());
                println!("────────────────────────────────────────");
                println!("  Files scanned:  {}", result.files_scanned.to_string().bold());
                println!("  Entities found: {}", result.entities_found.to_string().bold());
                println!("  New registered: {}", format!("+{}", result.new_registered).green());
                println!("  Updated:        {}", format!("~{}", result.updated).yellow());
                println!("  Duration:       {}", format!("{}ms", result.duration_ms).dimmed());

                let stats = reg.stats(&project_id)?;
                println!("\n{}",  "Registry Status".bold());
                println!(
                    "  Total: {}  untested: {}  high-risk: {}",
                    stats.total, stats.untested, stats.high_risk
                );
            }

            Command::Check {
                file,
                stats,
                untested,
                high_risk,
                deprecated,
                search,
            } => {
                // 프로젝트 ID: 현재 디렉토리 기반
                let cwd = std::fs::canonicalize(".")?;
                let project_id = project_id_from_path(&cwd);

                if *stats {
                    let s = reg.stats(&project_id)?;
                    println!("{}", "Registry Stats".bold());
                    println!("────────────────────────────────────────");
                    println!("  Total entities:  {}", s.total.to_string().bold());
                    println!("  Untested:        {}", if s.untested > 0 { s.untested.to_string().yellow() } else { "0".green() });
                    println!("  High risk:       {}", if s.high_risk > 0 { s.high_risk.to_string().red() } else { "0".green() });
                    println!("  Deprecated:      {}", if s.deprecated > 0 { s.deprecated.to_string().yellow() } else { "0".green() });

                    let by_kind = reg.count_by_kind(&project_id)?;
                    if !by_kind.is_empty() {
                        println!("\n  {}",  "By kind:".dimmed());
                        for (kind, count) in &by_kind {
                            println!("    {:<12} {}", kind, count);
                        }
                    }
                } else if *untested {
                    let entities = reg.list_untested(&project_id)?;
                    println!("{} ({})", "Untested Active Entities".bold(), entities.len());
                    for e in &entities {
                        println!(
                            "  {} {} {}  {} test:{} risk:{}",
                            e.kind.dimmed(),
                            e.name.cyan(),
                            format!("{}:{}", e.file_path, e.line_start).dimmed(),
                            "active".green(),
                            "✗".red(),
                            match e.risk_level.as_str() {
                                "high" => "HIGH".red(),
                                "medium" => "MEDIUM".yellow(),
                                _ => "LOW".green(),
                            }
                        );
                    }
                } else if *high_risk {
                    let entities = reg.list_high_risk(&project_id)?;
                    println!("{} ({})", "High Risk Entities".bold(), entities.len());
                    for e in &entities {
                        println!(
                            "  {} {} {}  risk:{}",
                            e.kind.bold(),
                            e.name.cyan(),
                            format!("{}:{}-{}", e.file_path, e.line_start, e.line_end).dimmed(),
                            "HIGH".red()
                        );
                    }
                } else if *deprecated {
                    let entities = reg.list_deprecated(&project_id)?;
                    println!("{} ({})", "Deprecated Entities".bold(), entities.len());
                    for e in &entities {
                        println!("  {} {} {}", e.kind.dimmed(), e.name.cyan(), e.file_path.dimmed());
                    }
                } else if let Some(query) = search {
                    let entities = reg.search(&project_id, query)?;
                    println!("{} \"{}\" ({} results)", "Search:".bold(), query, entities.len());
                    for e in &entities {
                        println!(
                            "  {} {} {}",
                            e.kind.dimmed(),
                            e.name.cyan(),
                            format!("{}:{}", e.file_path, e.line_start).dimmed()
                        );
                    }
                } else if let Some(file) = file {
                    let file_str = file.to_string_lossy();
                    let entities = reg.list_by_file(&project_id, &file_str)?;
                    println!("{}: {}", "File Brief".bold(), file_str);
                    println!("────────────────────────────────────────");
                    if entities.is_empty() {
                        println!("  {}", "No registered entities.".dimmed());
                        println!("  {}", "Run `ctx scan` first.".dimmed());
                    } else {
                        let untested_count = entities.iter().filter(|e| !e.has_tests).count();
                        println!("  {}", format!("{} entities, {} untested", entities.len(), untested_count).dimmed());
                        println!();
                        for e in &entities {
                            let test_icon = if e.has_tests { "✓".green() } else { "✗".red() };
                            let risk_str = match e.risk_level.as_str() {
                                "high" => "HIGH".red(),
                                "medium" => "MEDIUM".yellow(),
                                _ => "LOW".green(),
                            };
                            println!(
                                "  {} {} {}  test:{} risk:{}",
                                e.kind.bold(),
                                e.name.cyan(),
                                format!(":{}-{}", e.line_start, e.line_end).dimmed(),
                                test_icon,
                                risk_str
                            );
                            if let Some(sig) = &e.signature {
                                println!("    {}", format!("sig: {sig}").dimmed());
                            }
                        }
                    }
                } else {
                    // 인자 없으면 stats 표시
                    let s = reg.stats(&project_id)?;
                    println!("{}: {} entities", "Code Registry".bold(), s.total);
                    println!(
                        "  {} deprecated, {} untested, {} high-risk",
                        s.deprecated, s.untested, s.high_risk
                    );
                }
            }

            Command::Bs { path } => {
                let path = std::fs::canonicalize(path)?;
                let result = bs::scan(&path)?;

                println!("{} — scanning for bad code patterns...", "BS Detector".bold());
                println!("  {}", format!("path: {}", path.display()).dimmed());
                println!();
                println!("{}", "BS Scan Result".bold());
                println!("──────────────────────────────────────────────────");
                println!("  Files scanned: {}", result.files_scanned.to_string().bold());
                println!(
                    "  BS Score:      {}",
                    format!("{:.1}", result.score).bold().yellow()
                );
                println!("  CRITICAL:      {}", if result.critical > 0 { result.critical.to_string().red() } else { "0".green() });
                println!("  WARNING:       {}", if result.warning > 0 { result.warning.to_string().yellow() } else { "0".green() });
                println!("  MINOR:         {}", result.minor.to_string().dimmed());

                if !result.issues.is_empty() {
                    // CRITICAL
                    let crits: Vec<_> = result.issues.iter().filter(|i| i.severity == "critical").collect();
                    if !crits.is_empty() {
                        println!("\n  {}", "CRITICAL (즉시 수정)".red());
                        for i in crits {
                            println!("    {} — {}", format!("{}:{}", i.file, i.line).red(), i.message);
                        }
                    }
                    // WARNING
                    let warns: Vec<_> = result.issues.iter().filter(|i| i.severity == "warning").collect();
                    if !warns.is_empty() {
                        println!("\n  {}", "WARNING (권장 수정)".yellow());
                        for i in warns {
                            println!("    {} — {}", format!("{}:{}", i.file, i.line).yellow(), i.message);
                        }
                    }
                    // MINOR count
                    let minor_count = result.issues.iter().filter(|i| i.severity == "minor").count();
                    if minor_count > 0 {
                        println!("\n  {}", format!("MINOR ({minor_count}건)").dimmed());
                        for i in result.issues.iter().filter(|i| i.severity == "minor").take(10) {
                            println!("    {}", format!("{}:{} — {}", i.file, i.line, i.message).dimmed());
                        }
                        if minor_count > 10 {
                            println!("    {}", format!("...and {} more", minor_count - 10).dimmed());
                        }
                    }
                }
            }

            Command::Inject { path } => {
                let path = std::fs::canonicalize(path)?;
                let project_id = project_id_from_path(&path);
                let s = reg.stats(&project_id)?;

                // Claude Code SessionStart 훅용 간결한 컨텍스트
                println!("[Code Registry] {} — skip exploratory Read/Grep, use this map", project_name(&path));
                println!("  Total entities:  {}", s.total);
                println!("  Deprecated:      {}", s.deprecated);
                println!("  Untested:        {}", s.untested);
                println!("  High risk:       {}", s.high_risk);

                let by_kind = reg.count_by_kind(&project_id)?;
                if !by_kind.is_empty() {
                    println!("  By kind:");
                    for (kind, count) in &by_kind {
                        println!("    {:<12} {}", kind, count);
                    }
                }
            }
        }

        Ok(())
    }
}

fn project_id_from_path(path: &std::path::Path) -> String {
    path.to_string_lossy().replace(['/', '\\', ' '], "-")
}

fn project_name(path: &std::path::Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}
