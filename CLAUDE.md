# CLAUDE.md — ctx

## Project

Code context toolkit. TypeScript/Node.js CLI로 코드베이스 엔티티 레지스트리 관리, BS(Bad Smell) 패턴 감지, Claude Code 세션 컨텍스트 주입을 수행. OpenSwarm의 `openswarm check` 기능에서 분리된 독립 패키지.

## Quick Start

```bash
npm install
npm run build
node dist/cli.js scan       # 코드베이스 스캔
node dist/cli.js check --stats  # 통계 조회
node dist/cli.js bs          # BS 감지
node dist/cli.js inject      # Claude Code 컨텍스트 주입
```

## Architecture

```
src/
├── cli.ts                    # CLI 진입점 (commander)
├── index.ts                  # Public API export
├── cli/
│   └── checkHandler.ts       # check/annotate 핸들러
└── registry/
    ├── schema.ts             # Zod 스키마 + 타입 정의
    ├── sqliteStore.ts        # SQLite + FTS5 레지스트리 (better-sqlite3)
    ├── entityScanner.ts      # 8개 언어 엔티티 추출 + 레지스트리 동기화
    └── bsDetector.ts         # BS 패턴 정적 분석
```

## Key Design Decisions

### Regex 기반 파서 (AST 미사용)
- 8개 언어 지원: TypeScript, JavaScript, Python, Go, Rust, Java, C/C++, C#
- 정규식으로 top-level 함수/클래스/상수/타입 추출
- 블록 끝 추정: 중괄호 카운팅 (C계열) 또는 인덴트 추적 (Python)
- 복잡도 점수: LOC + 네스팅 깊이 + 파라미터 수 (0-10)

### SQLite + FTS5
- `~/.ctx/registry.db`에 프로젝트별 엔티티 저장
- content-synced FTS5 + 트리거로 자동 인덱싱
- WAL 모드, N+1 방지 배치 쿼리

### BS Detector
- 정규식 라인 매칭 + excludeIf 필터로 false positive 감소
- severity: critical(즉시 수정), warning(권장), minor(참고)
- BS Score = (critical*10 + warning*3 + minor*1) / filesScanned

### 프로젝트 ID 자동 추론
- package.json name → Cargo.toml name → go.mod module → 폴더명 순

## Conventions

- qualified_name: `{relative_file_path}::{entity_name}`
- 엔티티 kind: function, class, module, type, constant
- 엔티티 status: active, deprecated, experimental, planned, broken
- risk_level: complexity ≥8 → high, ≥6+untested → high, ≥6 → medium, ≥4+untested → medium, else low
- 스킵 디렉토리: node_modules, .git, __pycache__, target, dist 등
- 파일 크기 제한: 512KB 이상 스킵

## Dependencies

better-sqlite3, commander, nanoid, zod

## Origin

OpenSwarm (`@intrect/openswarm`) 의 `src/registry/` + `src/cli/checkHandler.ts`에서 분리. GraphQL API, memory bridge, issue bridge는 OpenSwarm에 남김.
