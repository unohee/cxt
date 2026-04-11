# ctx

Code context toolkit — 코드베이스 레지스트리, BS 감지, AI 컨텍스트 주입.

다양한 프로젝트에서 코드 엔티티(함수, 클래스, 상수)를 추적하고, 코드 품질 이슈를 감지하며, Claude Code 세션에 컨텍스트를 주입하는 범용 CLI.

## Install

```bash
cargo install --path .
```

## Usage

```bash
# 코드베이스 스캔 → 레지스트리에 엔티티 등록
ctx scan
ctx scan -v              # 상세 출력

# 레지스트리 조회
ctx check --stats        # 전체 통계
ctx check <file>         # 파일별 엔티티 목록
ctx check --search <q>   # 전문 검색 (FTS5)
ctx check --untested     # 테스트 없는 엔티티
ctx check --high-risk    # 고위험 엔티티
ctx check --deprecated   # deprecated 엔티티

# Bad Smell 감지
ctx bs                   # BS 패턴 스캔 (eval, 빈 catch, 비밀키 등)

# Claude Code 컨텍스트 주입 (SessionStart 훅용)
ctx inject               # 간결한 레지스트리 요약 출력
```

## BS Detector Rules

| Severity | Pattern | Description |
|----------|---------|-------------|
| CRITICAL | 빈 catch/except | 예외 은폐 |
| CRITICAL | 하드코딩 비밀키 | password/api_key/secret/token 하드코딩 |
| WARNING | eval() | 코드 인젝션 위험 (model.eval() 제외) |
| WARNING | TODO/FIXME | 잔류 TODO |
| WARNING | 가짜 URL | example.com, localhost 하드코딩 |
| WARNING | console.log | 디버그 로그 잔류 |
| WARNING | any 타입 | TypeScript 타입 안전성 우회 |
| WARNING | debugger | 디버거 문 잔류 |
| MINOR | 매직 넘버 | 의미 불명확한 하드코딩 숫자 |

## Supported Languages

- Python (.py)
- TypeScript/JavaScript (.ts, .tsx, .js, .jsx)
- Rust (.rs)
- Go (.go)

## Claude Code Integration

`settings.json`의 SessionStart 훅에 `ctx inject`를 추가하면 매 세션 시작 시 코드베이스 맵이 자동 주입됩니다:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "ctx inject"
      }
    ]
  }
}
```

## Storage

레지스트리는 `~/.ctx/registry.db` (SQLite)에 저장됩니다. 프로젝트별로 분리되어 여러 코드베이스를 동시에 추적할 수 있습니다.
