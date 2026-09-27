# 증분 fact snapshot과 제한된 query

추적: [AGT-4572](https://linear.app/intrect/issue/AGT-4572).

## Scan 계약

`cxt scan`은 DB v9의 `code_analysis_cache`를 재사용한다. `cxt scan --full`은 캐시 읽기를 건너뛰고 전체 결과와 캐시를 다시 계산한다. 두 경로 모두 기존 60초 제한과 동일한 분석 의미를 사용한다. 캐시 적중은 분석의 completeness를 높이지 않는다.

| 단계 | 무효화 입력 |
|---|---|
| 파일 frontend | 파일 경로, 내용 SHA-256, 언어, parser mode, engine fingerprint |
| 함수 SCC | 구성원, 현재 해석된 호출을 연결한 CFG, 외부 SCC callee 요약, 모델 manifest, 고정점 예산, engine fingerprint |
| 호출 연결 | 매 scan 현재 파일의 symbol/import를 전체 재해석 |

Engine fingerprint는 실행 중인 source 또는 dist의 코드·query bytes, native package metadata, Node/ABI/platform/architecture를 포함한다. 배포/개발 엔진 파일은 프로세스 실행 중 교체하지 않는다. 빌드가 바뀌면 CLI나 임베딩 프로세스를 다시 시작한다. 현재 엔진을 실행한 채 디스크의 코드를 바꾸는 hot reload는 지원하지 않는다. `.cxt-rules.json`은 BS의 소스 직접 분석에 적용되며 fact cache와는 별도다.

변경된 callee의 의미 요약이 같으면 caller의 SCC를 재사용할 수 있다. 파일 삭제와 import 대상 변경은 먼저 현재 symbol 해석에 반영된다. recursive component는 한 단위로 재계산한다. 모델 manifest 변경은 SCC cache를 무효화한다. frontend cache는 모델과 독립적이다. test mapping은 현재 test 파일에서 매번 다시 계산한다.

원자적 snapshot에는 entities, calls, CFG, flows, summaries, 모델 manifest, relations와 cache가 함께 들어간다. 실패·timeout이면 모두 rollback하며 이전 snapshot을 보존한다. 성공하면 현재 사용하지 않은 cache entry를 제거한다. payload SHA 불일치는 오류다. `--full` 재계산으로 잘못된 cache bytes를 대체할 수 있다. 수동 entity annotation은 기존 scanner 정책을 따른다.

Native parser 부재를 cache가 숨기지 않는다. 캐시를 읽기 전에 loader/query를 확인하며, 강제 AST 실패는 그대로 실패한다. auto fallback이면 현재 lexical 진단을 새로 생성한다. 이후 native를 복구하면 AST를 다시 계산한다. Cache JSON은 내부 저장 형식으로, 외부의 임의 fact 파일을 받아들이는 API가 아니다.

`scan --json`의 `cache`:

- `frontendHits/Misses`: 비-test 파일 수.
- `summaryHits/Misses`: SCC 수. 함수 수와 다를 수 있다.
- `engine`: 엔진 fingerprint.
- `committed`: 이번 결과가 실제 snapshot에 commit됐는지 여부.

현재 구현은 파일을 모두 읽고 import 연결과 fact 저장도 다시 수행한다. 변경 없음이 O(1)이라는 보장은 없다. `bs`/`audit`의 source 규칙 분석에 이 cache를 적용하지 않는다.

## 저장된 facts 질의

```bash
cxt query entities --where '[{"column":"file_path","op":"prefix","value":"src/"}]' --limit 50 --json
cxt query calls --where '[{"column":"resolution","op":"eq","value":"unresolved"}]' --json
cxt query summaries --where '[{"column":"completeness","op":"eq","value":"partial"}]' --json
```

Views: `entities`, `calls`, `cfg`, `flows`, `summaries`. 실제 SQL views는 `cxt_query_<view>`다. 필드 목록은 `src/analysis/factQuery.ts`의 `factViews`가 정본이다. `SqliteRegistryStore.queryFacts(projectId, query)`를 통해 API에서도 동일한 검증을 적용한다.

- raw SQL, 표현식, 임의 table/column은 입력으로 받지 않는다.
- project ID는 필수 바인딩 조건이며 모든 값은 prepared statement parameter다.
- 최대 16개 `eq`/`prefix` 조건, 문자열 최대 512자. prefix의 `%`, `_`, `!`는 literal로 escape한다.
- `limit` 1–500(기본 100), `offset` 0–100000, 고정된 정렬 및 전체 column tie-break.
- SQLite statement의 `readonly`/`reader`를 확인한다. 거부된 문법은 실행하지 않는다.
- JSON은 `source: persisted-snapshot`, `freshness: not-verified`를 반환한다. query 성공/빈 결과가 최신 source 분석이나 전체 coverage를 보장하지 않는다.
- 기존 registry open은 schema migration/복구를 수행할 수 있다. 읽기 전용 계약은 query가 facts를 변조하지 않는다는 뜻이며 DB 파일을 OS readonly로 여는 모드는 아니다.

## 검증과 성능 재현

`tests/registry/incrementalScan.test.ts`는 unchanged/reopen, 엔진 변경, 파일 변경/삭제, 전이 caller, recursive SCC, 모델 변경, parser 복구, 강제 전체 결과 동등성, commit 실패와 cache corruption rollback을 검사한다. v8 migration은 기존 facts/FTS를 보존하고 누락 view를 복원한다. 레거시 entity rebuild는 파생 view를 같은 transaction에서 제거한 뒤 재생성한다.

Query 검사는 11개 mutation 문자열을 5개 구조 필드에 넣어 55개를 거부하고, 같은 문자열의 filter value는 inert data로 처리한다. 잘못된 limit, project 간 격리, pagination, 전체 entity 보존도 확인한다. 이는 명시된 API 계약 검사이며 임의 SQL 엔진에 대한 포괄적인 보안 증명이 아니다. 실제 tarball 설치에서도 warm/full scan, query 및 mutation 거부를 실행한다.

```bash
npm run bench:incremental -- /absolute/path/to/git/repository 5
```

Git의 tracked 및 unignored 파일을 임시 snapshot에 복사하고 cold/warm 각 5회, 매번 새 Node 프로세스로 측정한다. 모든 실행에서 entity/call/CFG/flow/summary/model/relation 내용을 비교한다(UUID·시간·cache bytes 제외). source SHA, engine SHA, 모든 raw 결과, DB와 snapshot을 출력한 `/tmp/cxt-incremental-bench-*`에 남긴다. 벤치 중 engine을 바꾸면 실패한다. 입력 저장소에 symlink가 있으면 명시적으로 실패한다.

사전 성능 budget: cold ≤60초, warm ≤15초, scan 직후 프로세스 max RSS ≤1 GiB. RSS에는 Node/native/SQLite 및 모든 분석이 포함된다. DB hash 검증 뒤의 peak도 raw 결과에 별도 남긴다. 표본 5개의 nearest-rank p95는 최대값이며 일반적인 workload의 p95 추정으로 해석하지 않는다. 분석 partial 비율은 성능 성공과 별개로 보고한다.

### 2026-09-27 실제 cxt 측정

원자료: `bench/incremental-baseline.json`, `/tmp/cxt-incremental-bench-U5UlKV/`. Node 24.20.0/Linux x64/Ryzen 7 5800X, 별도 학습·CI 작업이 실행 중인 호스트다. 각 실행의 CPU time/load average도 보존했다. OS filesystem cache를 비우지 않았으므로 cold는 **빈 cxt DB**를 의미한다.

| 모드 | n | p50 | p95 (표본 최대) | scan peak RSS 최대 |
|---|---:|---:|---:|---:|
| cold | 5 | 35.113초 | 40.499초 | 819.7 MiB |
| warm | 5 | 9.194초 | 11.186초 | 559.3 MiB |

59파일/1,603 entities, CFG·flow·summary 1,225개. warm은 frontend 59개/SCC 1,210개를 전부 재사용했다. 10개 실행의 전체 facts SHA가 동일하고 오류 0/commit true이며 사전 budget을 통과했다. **Local flow complete 1,083/partial 142, summary complete 14/partial 1,211**이다. 이 비율을 캐시 적중률이나 실행 성공으로 덮지 않는다. DB는 약 182 MiB로 cache/facts 중복 저장 비용이 있다.

이전 실패 측정 `/tmp/cxt-incremental-bench-IPjtZp/`도 보존했다. 첫 3쌍은 통과했지만 네 번째 cold가 60.017초에 dataflow timeout/rollback하여 전체 게이트는 실패했다. CPU profile에서 반복된 추상값 정규화 비용을 확인하고, 이미 정규화된 choice를 보존하여 같은 정의만 합치도록 최적화했다. 같은 고정 입력의 전체 facts SHA 일치(`/tmp/cxt-phase9-merge-equivalence/`) 및 기존 CFG 226개 결과 일치를 확인했다. 분석 의미·work budget·60초 제한은 유지했다.

최종 검증: 742 tests, lint/build, 실제 tarball 설치(`/tmp/cxt-packed-frontends-3LzhFv`)의 native 존재/부재·warm/full·query mutation 검사. 독립 정확도·운영 환경 전체의 성능 보장은 별도 평가다.
