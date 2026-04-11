# CLAUDE.md — ctx

## Project

Code context toolkit. Rust CLI로 코드베이스 엔티티 레지스트리 관리, BS(Bad Smell) 패턴 감지, Claude Code 세션 컨텍스트 주입을 수행.

## Quick Start

```bash
cargo build --release
cargo install --path .
ctx scan          # 코드베이스 스캔
ctx check --stats # 통계 조회
ctx bs            # BS 감지
```

## Architecture

```
src/
├── main.rs       # 진입점 (모듈 선언)
├── cli.rs        # clap CLI 정의 + 서브커맨드 실행
├── parser.rs     # 정규식 기반 엔티티 추출 (Python/TS/Rust/Go)
├── registry.rs   # SQLite 레지스트리 (rusqlite, FTS5 검색)
├── scanner.rs    # 디렉토리 워킹 + 엔티티 추출 + 레지스트리 동기화
└── bs.rs         # Bad Smell 패턴 감지 (정규식 라인 매칭)
```

## Key Design Decisions

### Regex 기반 파서 (AST 미사용)
- 다국어 지원이 목표이므로 언어별 AST 파서 의존성을 피함
- 정규식으로 top-level 함수/클래스/상수만 추출 (메서드, 중첩 함수 제외)
- 블록 끝 추정: 중괄호 카운팅 (Rust/TS/Go) 또는 인덴트 추적 (Python)
- 복잡도 점수: LOC + 네스팅 깊이 + 파라미터 수 (0-10)

### SQLite + FTS5
- `~/.ctx/registry.db`에 프로젝트별 엔티티 저장
- content-less FTS5 테이블로 전문 검색
- WAL 모드로 동시 읽기 성능

### BS Detector
- 정규식 라인 매칭 + excludeIf 필터로 false positive 감소
- severity: critical(즉시 수정), warning(권장), minor(참고)
- BS Score = 5.0 - (weighted issues / files), 높을수록 깨끗

## Conventions

- 프로젝트 ID: 디렉토리 절대경로에서 `/`, `\`, 공백을 `-`로 치환
- qualified_name: `{relative_file_path}::{entity_name}`
- 엔티티 kind: function, class, constant, type
- risk_level: complexity_score ≥8 → high, ≥5 → medium, else low
- 스킵 디렉토리: node_modules, .git, __pycache__, target, dist 등
- 파일 크기 제한: 512KB 이상 스킵

## Dependencies

clap, rusqlite (bundled SQLite), regex, walkdir, colored, dirs
