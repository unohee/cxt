use regex::Regex;
use std::path::Path;

/// 추출된 코드 엔티티
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Entity {
    pub kind: String,       // function, class, constant, type
    pub name: String,
    pub line_start: usize,
    pub line_end: usize,
    pub signature: Option<String>,
    pub is_exported: bool,
    pub complexity_score: u32,
}

/// 언어별 파서 설정
struct LangConfig {
    extensions: &'static [&'static str],
    patterns: Vec<EntityPattern>,
    block_style: BlockStyle,
}

struct EntityPattern {
    kind: &'static str,
    regex: Regex,
    sig_group: Option<usize>, // 시그니처 캡처 그룹
}

#[derive(Clone, Copy)]
enum BlockStyle {
    Brace,  // {}, Rust/TS/Go/Java
    Indent, // Python
}

fn python_config() -> LangConfig {
    LangConfig {
        extensions: &["py", "pyw"],
        patterns: vec![
            EntityPattern {
                kind: "function",
                // 여러 줄에 걸친 시그니처도 매칭: def name( 까지만
                regex: Regex::new(r"^(?:async\s+)?def\s+(\w+)\s*\((.*)").unwrap(),
                sig_group: Some(2),
            },
            EntityPattern {
                kind: "class",
                regex: Regex::new(r"^class\s+(\w+)").unwrap(),
                sig_group: None,
            },
            EntityPattern {
                kind: "constant",
                // UPPER_CASE = ... (top-level)
                regex: Regex::new(r"^([A-Z][A-Z0-9_]{2,})\s*[=:]").unwrap(),
                sig_group: None,
            },
        ],
        block_style: BlockStyle::Indent,
    }
}

fn typescript_config() -> LangConfig {
    LangConfig {
        extensions: &["ts", "tsx", "js", "jsx", "mjs"],
        patterns: vec![
            EntityPattern {
                kind: "function",
                regex: Regex::new(
                    r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)",
                )
                .unwrap(),
                sig_group: Some(2),
            },
            EntityPattern {
                kind: "function",
                regex: Regex::new(
                    r"^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?:=>|:\s*\w)",
                )
                .unwrap(),
                sig_group: None,
            },
            EntityPattern {
                kind: "class",
                regex: Regex::new(r"^(?:export\s+)?class\s+(\w+)").unwrap(),
                sig_group: None,
            },
            EntityPattern {
                kind: "type",
                regex: Regex::new(r"^(?:export\s+)?(?:type|interface)\s+(\w+)").unwrap(),
                sig_group: None,
            },
            EntityPattern {
                kind: "constant",
                regex: Regex::new(r"^(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*=").unwrap(),
                sig_group: None,
            },
        ],
        block_style: BlockStyle::Brace,
    }
}

fn rust_config() -> LangConfig {
    LangConfig {
        extensions: &["rs"],
        patterns: vec![
            EntityPattern {
                kind: "function",
                regex: Regex::new(r"^(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)").unwrap(),
                sig_group: Some(2),
            },
            EntityPattern {
                kind: "class",
                regex: Regex::new(r"^(?:pub(?:\(crate\))?\s+)?struct\s+(\w+)").unwrap(),
                sig_group: None,
            },
            EntityPattern {
                kind: "class",
                regex: Regex::new(r"^(?:pub(?:\(crate\))?\s+)?enum\s+(\w+)").unwrap(),
                sig_group: None,
            },
            EntityPattern {
                kind: "type",
                regex: Regex::new(r"^(?:pub(?:\(crate\))?\s+)?trait\s+(\w+)").unwrap(),
                sig_group: None,
            },
            EntityPattern {
                kind: "constant",
                regex: Regex::new(r"^(?:pub(?:\(crate\))?\s+)?(?:const|static)\s+([A-Z][A-Z0-9_]{2,})\s*:").unwrap(),
                sig_group: None,
            },
        ],
        block_style: BlockStyle::Brace,
    }
}

fn go_config() -> LangConfig {
    LangConfig {
        extensions: &["go"],
        patterns: vec![
            EntityPattern {
                kind: "function",
                regex: Regex::new(r"^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)").unwrap(),
                sig_group: Some(2),
            },
            EntityPattern {
                kind: "class",
                regex: Regex::new(r"^type\s+(\w+)\s+struct\b").unwrap(),
                sig_group: None,
            },
            EntityPattern {
                kind: "type",
                regex: Regex::new(r"^type\s+(\w+)\s+interface\b").unwrap(),
                sig_group: None,
            },
        ],
        block_style: BlockStyle::Brace,
    }
}

fn all_configs() -> Vec<LangConfig> {
    vec![python_config(), typescript_config(), rust_config(), go_config()]
}

/// 파일 확장자로 언어 설정 찾기
fn config_for_ext(ext: &str) -> Option<LangConfig> {
    // 매번 재생성 (소유권 문제 회피)
    for cfg in all_configs() {
        if cfg.extensions.contains(&ext) {
            return Some(cfg);
        }
    }
    None
}

/// 파일에서 엔티티 추출
pub fn extract_entities(path: &Path, source: &str) -> Vec<Entity> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let config = match config_for_ext(ext) {
        Some(c) => c,
        None => return vec![],
    };

    let lines: Vec<&str> = source.lines().collect();
    let mut entities = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("//") {
            continue;
        }

        // 인덴트 체크 (Python: top-level + class method)
        if matches!(config.block_style, BlockStyle::Indent) {
            let indent = line.len() - line.trim_start().len();
            // class 내부 메서드는 4칸 인덴트 허용, 그 이상은 스킵
            if indent > 4 {
                continue;
            }
        }

        for pat in &config.patterns {
            if let Some(caps) = pat.regex.captures(trimmed) {
                let name = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();

                // 이미 같은 라인에서 추출된 것이 있으면 스킵
                if entities.iter().any(|e: &Entity| e.line_start == i + 1) {
                    continue;
                }

                let signature = pat
                    .sig_group
                    .and_then(|g| caps.get(g))
                    .map(|m| format!("({})", m.as_str()));

                let line_end = match config.block_style {
                    BlockStyle::Brace => find_brace_end(&lines, i),
                    BlockStyle::Indent => find_indent_end(&lines, i),
                };

                let loc = line_end.saturating_sub(i);
                let complexity = compute_complexity(loc, trimmed, &lines[i..=line_end.min(lines.len() - 1)]);

                let is_exported = match ext {
                    "py" | "pyw" => !name.starts_with('_'),
                    "rs" => trimmed.starts_with("pub"),
                    _ => trimmed.contains("export"),
                };

                entities.push(Entity {
                    kind: pat.kind.to_string(),
                    name,
                    line_start: i + 1,
                    line_end: line_end + 1,
                    signature,
                    is_exported,
                    complexity_score: complexity,
                });
                break;
            }
        }
    }

    entities
}

/// 중괄호 블록의 끝 찾기
fn find_brace_end(lines: &[&str], start: usize) -> usize {
    let mut depth: i32 = 0;
    let mut found_open = false;

    for (i, line) in lines.iter().enumerate().skip(start) {
        for ch in line.chars() {
            if ch == '{' {
                depth += 1;
                found_open = true;
            } else if ch == '}' {
                depth -= 1;
                if found_open && depth == 0 {
                    return i;
                }
            }
        }
    }
    // 닫는 괄호를 못 찾으면 다음 빈 줄이나 EOF
    for i in (start + 1)..lines.len() {
        if lines[i].trim().is_empty() && i > start + 1 {
            return i - 1;
        }
    }
    lines.len().saturating_sub(1)
}

/// 인덴트 블록의 끝 찾기 (Python)
fn find_indent_end(lines: &[&str], start: usize) -> usize {
    let base_indent = lines[start].len() - lines[start].trim_start().len();

    for i in (start + 1)..lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent <= base_indent {
            // 이전의 실제 코드 라인으로
            return i.saturating_sub(1).max(start);
        }
    }
    lines.len().saturating_sub(1)
}

/// 복잡도 점수 계산 (0-10)
fn compute_complexity(loc: usize, _first_line: &str, block: &[&str]) -> u32 {
    let mut score: u32 = 0;

    // LOC
    score += match loc {
        0..=20 => 0,
        21..=50 => 1,
        51..=100 => 2,
        _ => 3,
    };

    // 최대 네스팅 깊이
    let max_nesting = block.iter().map(|l| {
        let indent = l.len() - l.trim_start().len();
        indent / 4
    }).max().unwrap_or(0);

    score += match max_nesting {
        0..=2 => 0,
        3..=4 => 1,
        5..=6 => 2,
        _ => 3,
    };

    // 파라미터 수 (첫 줄에서 콤마 카운트)
    let param_count = _first_line.matches(',').count();
    score += match param_count {
        0..=3 => 0,
        4..=6 => 1,
        _ => 2,
    };

    score.min(10)
}

/// 지원하는 확장자인지 확인
pub fn is_supported_ext(ext: &str) -> bool {
    let all_exts: &[&str] = &[
        "py", "pyw", "ts", "tsx", "js", "jsx", "mjs", "rs", "go",
    ];
    all_exts.contains(&ext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_python_function() {
        let source = "def hello(name: str) -> str:\n    return f'hello {name}'\n";
        let entities = extract_entities(Path::new("test.py"), source);
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].kind, "function");
        assert_eq!(entities[0].name, "hello");
        assert!(entities[0].signature.as_deref().unwrap().contains("name"));
    }

    #[test]
    fn test_python_class() {
        let source = "class MyClass:\n    def __init__(self):\n        pass\n";
        let entities = extract_entities(Path::new("test.py"), source);
        assert!(entities.iter().any(|e| e.kind == "class" && e.name == "MyClass"));
    }

    #[test]
    fn test_python_constant() {
        let source = "MAX_RETRIES = 3\nSOME_VALUE = 42\n";
        let entities = extract_entities(Path::new("test.py"), source);
        assert!(entities.iter().any(|e| e.kind == "constant" && e.name == "MAX_RETRIES"));
    }

    #[test]
    fn test_rust_function() {
        let source = "pub fn process(input: &str) -> Result<(), Error> {\n    Ok(())\n}\n";
        let entities = extract_entities(Path::new("test.rs"), source);
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].name, "process");
        assert!(entities[0].is_exported);
    }

    #[test]
    fn test_typescript_export_function() {
        let source = "export function getData(id: string): Promise<Data> {\n  return fetch(id);\n}\n";
        let entities = extract_entities(Path::new("test.ts"), source);
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].name, "getData");
    }

    #[test]
    fn test_unsupported_extension() {
        let entities = extract_entities(Path::new("test.txt"), "some text");
        assert!(entities.is_empty());
    }
}
