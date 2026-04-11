use regex::Regex;
use std::path::Path;
use walkdir::WalkDir;

/// BS 이슈
pub struct BsIssue {
    pub file: String,
    pub line: usize,
    pub severity: &'static str, // "critical", "warning", "minor"
    pub message: String,
}

/// BS 스캔 결과
pub struct BsResult {
    pub files_scanned: usize,
    pub score: f64,
    pub critical: usize,
    pub warning: usize,
    pub minor: usize,
    pub issues: Vec<BsIssue>,
}

struct BsPattern {
    severity: &'static str,
    message: &'static str,
    regex: Regex,
    /// 이 패턴을 스킵할 조건 (라인 내용 기반)
    exclude_if: fn(&str, &str) -> bool, // (line, file_path) -> skip?
}

fn no_exclude(_line: &str, _file: &str) -> bool {
    false
}

fn exclude_test_files(_line: &str, file: &str) -> bool {
    file.contains("test") || file.contains("spec") || file.contains("__tests__")
}

fn build_patterns() -> Vec<BsPattern> {
    vec![
        // === CRITICAL ===
        BsPattern {
            severity: "critical",
            message: "빈 catch/except 블록 — 예외 은폐",
            regex: Regex::new(r"(?:catch\s*\([^)]*\)\s*\{\s*\}|except(?:\s+\w+)?:\s*pass)").unwrap(),
            exclude_if: exclude_test_files,
        },
        BsPattern {
            severity: "critical",
            message: "하드코딩 비밀키 의심",
            regex: Regex::new(r#"(?i)(?:password|api_key|secret|token)\s*[:=]\s*["'][^"']{8,}["']"#).unwrap(),
            exclude_if: |line, file| {
                exclude_test_files(line, file)
                    || line.contains("example")
                    || line.contains("placeholder")
                    || line.contains("xxx")
                    || line.contains("env")
                    || line.contains("getenv")
                    || line.contains("process.env")
                    || line.contains("os.environ")
            },
        },

        // === WARNING ===
        BsPattern {
            severity: "warning",
            message: "eval() 사용 — 코드 인젝션 위험",
            regex: Regex::new(r"\beval\s*\(").unwrap(),
            exclude_if: |line, _file| {
                // PyTorch model.eval() 은 false positive
                line.contains(".eval()")
                    || line.contains("noqa")
                    || line.contains("# noqa")
            },
        },
        BsPattern {
            severity: "warning",
            message: "TODO/FIXME/HACK 잔류",
            regex: Regex::new(r"(?i)\b(?:TODO|FIXME|HACK|XXX)\b").unwrap(),
            exclude_if: no_exclude,
        },
        BsPattern {
            severity: "warning",
            message: "example.com 등 가짜 URL — 실 운영 불가",
            regex: Regex::new(r"(?i)(?:example\.com|localhost:\d{4})").unwrap(),
            exclude_if: |line, file| {
                exclude_test_files(line, file)
                    || line.contains("env")
                    || line.contains("getenv")
                    || line.contains("LM_STUDIO")
                    || line.contains("LMSTUDIO")
                    || line.contains("config")
            },
        },
        BsPattern {
            severity: "warning",
            message: "console.log 잔류",
            regex: Regex::new(r"\bconsole\.log\s*\(").unwrap(),
            exclude_if: |_line, file| {
                exclude_test_files(_line, file)
                    || file.contains("cli")
                    || file.contains("debug")
                    || file.contains("logger")
            },
        },
        BsPattern {
            severity: "warning",
            message: "any 타입 사용 — 타입 안전성 우회",
            regex: Regex::new(r"(?::\s*any\b|as\s+any\b)").unwrap(),
            exclude_if: |_line, file| {
                !file.ends_with(".ts") && !file.ends_with(".tsx")
            },
        },
        BsPattern {
            severity: "warning",
            message: "debugger 문",
            regex: Regex::new(r"^\s*debugger\s*;?\s*$").unwrap(),
            exclude_if: no_exclude,
        },

        // === MINOR ===
        BsPattern {
            severity: "minor",
            message: "매직 넘버 — 의미 불명확한 하드코딩 숫자",
            regex: Regex::new(r"(?:=|return|>|<|>=|<=)\s*\d{3,}(?:\.\d+)?(?:\s*[;,)\]}]|$)").unwrap(),
            exclude_if: |line, file| {
                exclude_test_files(line, file)
                    || line.contains("const ")
                    || line.contains("let ")
                    || line.contains("var ")
                    || line.contains("= ")  // 상수 할당은 OK
                    || line.trim().starts_with('#')
                    || line.trim().starts_with("//")
                    || file.ends_with(".json")
                    || file.ends_with(".toml")
                    || file.ends_with(".yaml")
            },
        },
    ]
}

/// 스킵할 디렉토리
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    "dist", "build", "target", ".tox", ".mypy_cache",
    ".pytest_cache", ".next", "coverage",
];

/// 지원 확장자
const SOURCE_EXTS: &[&str] = &[
    "py", "ts", "tsx", "js", "jsx", "rs", "go",
    "java", "c", "cpp", "cs", "rb", "swift",
];

/// BS 패턴 스캔
pub fn scan(root: &Path) -> Result<BsResult, Box<dyn std::error::Error>> {
    let patterns = build_patterns();
    let mut issues = Vec::new();
    let mut files_scanned = 0;

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

        if !SOURCE_EXTS.contains(&ext) {
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

        files_scanned += 1;

        let rel_path = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        for (line_num, line) in source.lines().enumerate() {
            for pat in &patterns {
                if pat.regex.is_match(line) && !(pat.exclude_if)(line, &rel_path) {
                    issues.push(BsIssue {
                        file: rel_path.clone(),
                        line: line_num + 1,
                        severity: pat.severity,
                        message: pat.message.to_string(),
                    });
                }
            }
        }
    }

    let critical = issues.iter().filter(|i| i.severity == "critical").count();
    let warning = issues.iter().filter(|i| i.severity == "warning").count();
    let minor = issues.iter().filter(|i| i.severity == "minor").count();

    let score = if files_scanned > 0 {
        let raw = (critical as f64 * 10.0 + warning as f64 * 3.0 + minor as f64 * 0.5) / files_scanned as f64;
        (5.0 - raw.min(5.0)).max(0.0)  // 5.0 = 깨끗, 0.0 = 최악
    } else {
        5.0
    };

    // severity 순 정렬
    issues.sort_by(|a, b| {
        let sev = |s: &str| match s {
            "critical" => 0,
            "warning" => 1,
            _ => 2,
        };
        sev(a.severity).cmp(&sev(b.severity)).then(a.file.cmp(&b.file)).then(a.line.cmp(&b.line))
    });

    Ok(BsResult {
        files_scanned,
        score,
        critical,
        warning,
        minor,
        issues,
    })
}
