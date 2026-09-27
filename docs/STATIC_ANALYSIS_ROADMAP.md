# cxt 정적 분석 개선 계획 — 2026-09-27

요청: CodeQL 수준의 정적 코드 검사기로 발전시키기 위한 개선 10개를 도출하고 구현하며, 모든 작업을 Linear에 기록한다.

정본 추적: [AGT-3877](https://linear.app/intrect/issue/AGT-3877). 시작 상태는 main `7c80e126d2847e7b9ebe384dbcf335573d2aeab6`, 테스트 310개 통과, lexical frontend만 활성화. 과거 PR #6/#7은 이미 main에 병합되었으므로 새 작업은 최신 main에서 시작한다.

## 범위와 완료 판단

우선 지원 언어는 기존 결정대로 TypeScript/TSX/JavaScript, Python, Rust다. Go/Java/C/C++/C# lexical 결과를 시맨틱 분석 결과로 표시하지 않는다. 보안 taint/CWE 범위 확대는 사용자 확인 중이며 공통 기반 작업은 진행한다. CodeQL과 동일한 언어 전체·취약점 탐지 성능을 달성했다고 주장하려면 별도의 독립 비교 평가가 필요하다.

각 항목은 코드 존재뿐 아니라 실제 CLI 경로, 정답 코퍼스, 실패/오탐 회귀검사, 배포 패키지까지 해당 범위의 근거가 있어야 완료다. 10개 전체 목표는 이 조건을 항목별로 확인하기 전에는 완료하지 않는다.

## 근거

- [CodeQL dataflow](https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/): AST와 dataflow graph는 다르며 local/global flow, alias, 외부 라이브러리, 동적 호출이 별도 문제다.
- [CodeQL path queries](https://codeql.github.com/docs/writing-codeql-queries/creating-path-queries/): 탐지 결과는 코드 위치와 경로로 설명되어야 한다.
- [Node tree-sitter](https://tree-sitter.github.io/node-tree-sitter/): native parser와 언어 문법, 구문 범위 기반 추출.
- 현행 `src/registry/entityScanner.ts`, `bsDetector.ts`, `sqliteStore.ts` 및 기존 epic의 측정/설계.

## 1. AST 프론트엔드와 정확한 선언·범위 추출

[AGT-4564](https://linear.app/intrect/issue/AGT-4564/codeql-개선-110-ast-프론트엔드와-정확한-선언범위-추출)

현행 regex는 비-export type/const, multiline 선언과 실제 구문 경계를 놓친다. LanguageFrontend 계약 + tree-sitter TS/TSX/JS/Python/Rust + 명시적 lexical fallback을 실제 scan에 연결한다. CXT_PARSER=auto|ast|lexical, 엔진별 진단, 파싱 실패 시 기존 DB 보존. .scm 쿼리와 고정 native 패키지 사용.

완료 기준: 선언/메서드/중첩 scope/정확한 line span fixtures, syntax error 및 parser unavailable 회귀검사, 실제 scan 저장 검증, npm pack→깨끗한 prefix 설치→AST 파싱. 전체 회귀 테스트. AGT-3883 spike 재사용.

## 2. 스코프·import·타입을 반영한 심볼 및 호출 해석

[AGT-4565](https://linear.app/intrect/issue/AGT-4565/codeql-개선-210-스코프import타입을-반영한-심볼-및-호출-해석)

이름 일치 대신 lexical binding, import alias/re-export, namespace/member/constructor, overload·shadowing을 해석한다. code_call_sites에 caller/callee/위치/해석근거/confidence/unresolved 원인을 저장하고 relations는 파생한다.

완료 기준: 동명 함수, alias, 순환 import, 재귀·간접 호출, 외부 및 동적 호출의 정답 코퍼스; precision ≥0.95, recall TS ≥0.90/Python ≥0.85/Rust ≥0.75; 미해석을 엣지로 날조하지 않음.

## 3. 예외·루프·조기 반환을 포함하는 CFG

[AGT-4566](https://linear.app/intrect/issue/AGT-4566/codeql-개선-310-예외루프조기-반환을-포함하는-cfg)

언어별 AST를 기본 블록과 분기/예외/정상종료 edge로 낮춘다. if/switch/match, loops/break/continue, return/throw/try/finally, Python with, Rust ?를 명시적으로 다룬다.

완료 기준: 각 제어구조 positive/negative fixture와 reachability oracle; finally 후 return/throw 의미 보존; 지원 밖 구문 diagnostic; CFG 구성 ≥98%, cyclomatic 일치 ≥95%.

## 4. 함수 내부 dataflow와 alias·정의/사용 분석

[AGT-4567](https://linear.app/intrect/issue/AGT-4567/codeql-개선-410-함수-내부-dataflow와-alias정의사용-분석)

CFG 위 worklist fixed-point solver, reaching definitions/def-use, 값 상태 및 field/alias 전파를 구현한다. 재할당 kill, merge, loop convergence, null/uninitialized와 소유권·리소스 상태를 표현한다.

완료 기준: 분기 합류/재할당/alias/루프/예외 fixtures; iteration budget 초과를 정상 완료로 보고하지 않음; 실제 AST→CFG→결과 CLI 통합. 정밀도/재현율 언어별 실측.

## 5. 함수 간 dataflow·요약 및 설명 가능한 영향 분석

[AGT-4568](https://linear.app/intrect/issue/AGT-4568/codeql-개선-510-함수-간-dataflow요약-및-설명-가능한-영향-분석)

매개변수→반환값/side effect/throw 요약을 만들고 call graph SCC 고정점으로 전파한다. 호출 문맥과 recursion budget, unknown external effects를 표시한다. impact/preflight --param/--explain에서 실제 경로를 제공한다.

완료 기준: 여러 파일·wrapper·재귀·서로 다른 call site 간 오염 방지 fixtures; 변경-영향 코퍼스 precision 기존 대비 ≥15%p; 불완전 요약은 불완전 상태로 노출.

## 6. 외부 라이브러리·프레임워크 의미 모델

[AGT-4569](https://linear.app/intrect/issue/AGT-4569/codeql-개선-610-외부-라이브러리프레임워크-의미-모델)

소스가 없는 외부 API에 대한 argument/return/side-effect/exception 모델과 검증되는 model pack schema를 만든다. 패키지·심볼·버전에 묶고 unknown model을 안전하다고 가정하지 않는다.

완료 기준: TS/Python/Rust 표준 라이브러리 대표 모델 및 wrapper 회귀검사, 사용자 모델 validation, 모델 버전 결과 기록. 보안 taint/CWE 확대 여부는 사용자 확인 중이며 답변 후 source/sink/sanitizer 정책을 명시한다.

## 7. AST·dataflow 기반 규칙과 규칙 팩 계약

[AGT-4570](https://linear.app/intrect/issue/AGT-4570/codeql-개선-710-astdataflow-기반-규칙과-규칙-팩-계약)

라인 regex BS 규칙을 구조적 query+predicate로 승격한다. rule ID/version/severity/rationale/precision/언어/positive-negative fixture 계약, category suppression 범위, path-role 설정을 도입한다. swallowed error·fake execution·magic number 등 기존 패턴 우선.

완료 기준: 기존 20패턴 이식, 기존 BS 회귀검사 유지 또는 의미 변경 근거와 회귀 대체 명시; 주석/문자열 negative corpus와 magic_number AGT-3915 검증. 규칙 별 precision/recall.

## 8. SARIF·경로 설명·분석 완전성 및 자동화 exit 계약

[AGT-4571](https://linear.app/intrect/issue/AGT-4571/codeql-개선-810-sarif경로-설명분석-완전성-및-자동화-exit-계약)

진단에 source range, stable fingerprint, rule metadata, related location, dataflow codeFlows를 부여하고 SARIF 2.1.0으로 내보낸다. scan/bs/audit의 파싱 실패·미지원·시간초과·부분분석·발견건수를 구분한다.

완료 기준: SARIF schema validation, 여러 파일 경로, relative URI 및 escaping, 결과 fingerprint 안정성, CLI text/JSON/SARIF 결과 동등성, finding과 tool error exit code 회귀검사.

## 9. 증분 fact DB·의존성 무효화 및 안전한 query

[AGT-4572](https://linear.app/intrect/issue/AGT-4572/codeql-개선-910-증분-fact-db의존성-무효화-및-안전한-query)

내용 해시 + parser/rule/model version으로 facts/summary 캐시를 관리한다. 파일 변경/삭제·import 및 요약 변경의 역의존성을 무효화하고 snapshot을 transaction으로 교체한다. facts/calls/flows read-only query API와 제한된 SQL views를 제공한다.

완료 기준: cold/warm 및 파일·의존성 변경 결과 동등성; 중단/실패 시 이전 snapshot 보존; 읽기 전용 mutation fuzz 0건; 실제 저장소 p50/p95/메모리 실측 및 성능 budget.

## 10. 독립 정답 코퍼스·정확도·성능·회귀 게이트

[AGT-3879](https://linear.app/intrect/issue/AGT-3879)를 재사용하고 [AGT-3878](https://linear.app/intrect/issue/AGT-3878)(코퍼스), [AGT-3880](https://linear.app/intrect/issue/AGT-3880)(CI), [AGT-3882](https://linear.app/intrect/issue/AGT-3882)(기준선 문서)를 연결한다.

언어×fact family별 precision/recall/F1, 정확한 span, 미해석률, runtime/메모리를 기록한다. 골든 코퍼스 50–70개, negative fixtures, 실제 저장소 및 held-out 평가를 사용한다. 기준선보다 나빠지면 nonzero로 종료하고, 결함 mutation을 주입해 gate 실패를 확인한다. 현행 lexical 기준선과 AST 이후 수치를 모두 발행한다. CI는 원격 `unohee/ci-templates`에서 사용 가능한 workflow를 확인한 뒤 적용한다.

## 실행 순서

1. 1과 10의 parser/선언 측정 기반.
2. 2 → 3 → 4 → 5; 외부 모델(6)은 flow에 통합.
3. 7 → 8; 각 규칙을 corpus에 추가.
4. 9에서 증분/쿼리 안전성·실제 규모 검증.
5. 10의 전체 품질/성능/패키지/CI 근거와 1–9 완료 기준을 재감사.

## 실행 기록 — 2026-09-27, 1차 구현

- 브랜치: `feat/agt-4564-semantic-frontends`.
- 1: AST frontend를 실제 scan에 연결했다. TS/TSX/JS/JSX/Python/Rust, `.scm` assets, scoped identity, 정확한 줄 범위/parameter count, parser 선택/진단, syntax/query 실패 시 이전 snapshot 보존을 구현했다.
- 10: 60개 합성 fixture와 100개 선언 수기 라벨, schema 검사, precision/recall/span/scope 게이트, lexical/AST 기준선을 추가했다. [평가 방법과 원자료](../bench/README.md).
- 검증: lint/build, Vitest 387개, 기존 benchmark harness 6개 통과. 실제 tarball 글로벌 설치 후 6개 grammar probe와 CLI scan 통과. 임시 설치의 native 패키지를 옮긴 뒤 auto fallback/강제 ast 실패를 확인했다. 잘못된 소스의 CLI exit 1 확인. lexical을 현행 정확도 게이트에 넣으면 exit 1.
- 현재 소스의 격리 DB scan: 28 files / 435 entities / parser diagnostics 0 / scan errors 0. audit: critical 0, warning 18, minor 11, errors 0, pass true. 이 수치는 관계 그래프 정답률을 의미하지 않는다.
- 남은 범위: 2–9 구현, 10의 호출 정답/실세계·held-out 계층과 CI. AGT-3878/3879의 전체 DoD는 아직 미완료다. 보안 확대 답변 없이 기존 보안 제외 범위를 임의로 바꾸지 않는다.

## 실행 기록 — 2026-09-27, 2차 구현

- 2: AST의 scope/binding/import/re-export/alias/간단한 receiver type을 실제 scan에 연결했다. 미해석을 별도 상태·이유로 남기고 v4 `code_call_sites`에서 source span/caller/target/reason/confidence를 조회한다. relation은 해석된 호출에서 파생하며 recursion을 보존한다. `calls --json` 및 text로 미해석도 확인할 수 있다.
- 10: 다중 파일 수기 호출 코퍼스 39개/55개 위치와 언어별 precision/recall/site/resolution 게이트, 잘못된 대상·위치·누락·중복 mutation 검사를 추가했다. 현재 개발 코퍼스는 모든 값 1.0이며 독립 평가로 해석하지 않는다.
- 검증: Vitest 444개, lint/build, 기존 benchmark harness 6개, 선언·호출 게이트, npm tarball의 실제 설치/CLI 조회 통과. v3→v4 migration에서 엔티티/FTS 보존, 호출 저장 실패와 최종 relation 저장 실패 시 이전 snapshot rollback 검증.
- 실제 현 소스 격리 scan(`/tmp/cxt-symbol-self-MQRsxe`): 32 files / 852 entities / errors 0 / diagnostics 0. 4,061 calls 중 resolved 1,012, unresolved 2,189, external 860. 호출 정답률을 측정한 결과가 아니며 coverage gap을 보여준다.
- 2의 현재 한계: tsconfig 및 workspace/package 경로, full type inference/subtype dispatch, member mutation, decorator/macro/framework callback 의미는 미완료다. confidence 1/0.9/0은 정책 값이며 확률 보정값이 아니다. 재할당은 CFG/dataflow 전까지 보수적으로 미해석한다. anonymous callback 안의 호출은 별도 함수 소유로 기록한다.
- 다음: 3 CFG → 4 intraprocedural dataflow → 5 interprocedural summaries. 실제 저장소·held-out 평가 및 나머지 6–9와 CI는 계속 열린 상태다.

## 실행 기록 — 2026-09-27, 3차 구현

- 3: AST→operation CFG/basic blocks→DB v5 `code_control_flow`→`cxt cfg <name> --json --strict`를 연결했다. 부분 CFG는 strict exit 2, 부재는 exit 1이다. scan snapshot과 함께 원자적으로 교체한다.
- 제어구조: if/elif, 단락·삼항·optional chain·logical assignment, 기본 parameter, loop/do/label/break/continue, switch fallthrough, match guard, return/throw, try/catch/else/finally, Python with/loop else, Rust `?`. finally를 pending completion별로 복제하여 cleanup 이후 경로와 override를 보존한다.
- 10: 언어별 9개 CFG fixture, 총 27개/경로 45개를 수기로 라벨링했다. 그래프 생성/구조 복잡도/completeness/reachability 모두 정답과 일치한다. 언어별 partial 1개를 포함하므로 생성률 100%를 완전 지원률로 부르지 않는다. gate mutation 및 basic block 분할·edge 보존 검사 포함.
- 검증: lint/build, Vitest 494개, 선언/호출/CFG 게이트, 실제 npm 설치 CLI의 CFG complete/partial strict exit 0/2 및 기존 호출·parser fallback 검사 통과. v4→v5 migration 및 snapshot rollback 확인.
- 최종 소스 격리 scan(`/tmp/cxt-cfg-verified-iojxfO`): 36 files / 964 entities / errors 0. CFG 721개 중 complete 674 / partial 47, 47,784 nodes / 59,443 edges / 16,775 blocks. 127개 await 및 1개 yield 지점이 partial의 원인이다. audit critical 0 / warning 22 / minor 13 / errors 0 / pass true.
- 남은 범위: await/yield suspension, comprehensions/macros/exception groups 및 더 넓은 독립 평가. CFG complete는 이 모델 내 제어구조 변환 완료이며 실행 경로의 값·타입 타당성, 종료 보장, 전체 runtime 의미를 입증하지 않는다. AGT-4566은 추가 지원을 위해 In Progress로 유지한다.

### 3차 후속 — await suspension

- await를 별도 suspension terminal과 `suspend`/`resume`/exception edge로 낮췄다. TS/Python await 실패는 catch/finally 경로를 따르고 정상 후속 문장으로 새지 않는다. Rust await도 명시하며 deferred async block과 yield는 partial로 유지한다. scheduler가 실제 재개한다는 보장은 하지 않는다.
- CFG 코퍼스는 30개/경로 54개로 확장했다. 언어별 complete 9/partial 1이며 모든 정답과 일치한다. 기존 unsupported-await negative는 지원 완료 후 yield로 교체하고 세 언어의 await positive를 별도로 추가했다.
- 검증: lint/build, 전체 테스트 500개, CFG gate, 실제 패키지 설치 CLI의 await resume edge·strict 0/2 확인. 최신 소스 snapshot `/tmp/cxt-await-verified-0WfxF9`: 36 files / 965 entities / errors 0. CFG 722개 중 complete 721 / partial 1(yield), 47,938 nodes / 59,701 edges / 16,852 blocks. 46개 CFG가 suspension을 포함한다. audit critical 0 / warning 22 / minor 13 / errors 0 / pass true.
- 3 구현을 In Review로 옮기고 4 함수 내부 dataflow를 시작한다. yield/async iteration/macros/exception groups/독립 평가와 전체 10개 목표는 미완료다.

## 실행 기록 — 2026-09-27, 4차 핵심 구현

- 4: AST effect → finite worklist → v6 `code_dataflow` → `flow --json --strict` 연결. 정의/사용·재할당 kill·merge·primitive/null/uninitialized·allocation alias·field 갱신·parameter dependence·finally return override·await를 추적한다. 생존 변수/temporary만 유지하며 종료 노드는 도달 여부만 합친다.
- 10: dataflow 수기 개발 코퍼스 27개(언어별 9), 명시적 관계 30/30·read 상태 21/21·completeness 27/27 일치. 잘못된 정의/거짓 의존성/assignment 제거/예산 소진 mutation 검사를 추가했다. 독립 실세계 정답률은 아니다.
- 검증: 전체 테스트 565개, lint/build, 선언·호출·CFG·flow 게이트, benchmark harness 6개, 실제 tarball 설치의 flow 값/위치/strict exit 0/2 통과. v5→v6 migration/FTS 보존 및 분석 timeout·저장 실패 시 이전 전체 snapshot rollback을 확인했다. 패키지 증거 `/tmp/cxt-packed-frontends-x654KQ`.
- 최신 소스 격리 snapshot `/tmp/cxt-flow-verified-I5ohO2`: 41 files / 1,155 entities / scan errors 0 / 45.4초. 함수 flow 893개 중 complete 796 / partial 97. 진단은 unsupported-effect 141, work-budget 42, partial-cfg 1건이며 하나의 함수에 겹칠 수 있다. unknown effect 위치 11,534개. 프로세스 max RSS 약 738 MiB. audit critical 0 / warning 26 / minor 16 / errors 0 / pass true.
- 실패 근거도 보존: `/tmp/cxt-flow-profile-FdhcTL`은 제한 전 source profile 도중 180초에 종료됐고, `/tmp/cxt-flow-verified-mQbLAl`은 최신 전체 scan이 60초를 넘겨 rollback했다. 이후 종료 노드에서 쓰지 않는 heap 합류를 제거하고 같은 scan 설정으로 성공했다. 예산은 늘리지 않았다.
- 현재 분석은 transfer/state/work 예산 초과를 partial로 표시한다. partial 비율과 unknown effects는 coverage gap이다. 정상 수렴을 프로그램 안전성으로 해석하지 않는다. 정확한 resource lifecycle·Rust move/borrow·동적 pattern/context-manager/rethrow 모델과 독립 평가가 남아 AGT-4567은 In Progress다. 다음은 AGT-4568 함수 간 요약이며 resource/ownership은 AGT-4569 의미 모델과 함께 마무리한다.

## 실행 기록 — 2026-09-27, 5차 핵심 구현

- 5: exact source span으로 CFG와 resolved calls를 연결하고 callee-first SCC 고정점 요약을 v7 `code_function_summaries`에 저장한다. 반환/throw/외부 state에 대한 formal parameter 의존성을 call site별로 대입한다. 재귀/전체 component 예산, unknown effect, 외부/closure 값, 반환 heap, async/generator 호출 envelope는 구분한다. 정적 해석 이후에도 현재 callable abstract value를 확인한다.
- `flow --json`은 local/summary/combined completeness를 나누고 strict는 요약 부재도 partial로 처리한다. `impact/preflight --param --explain`은 현재 explicit parameter value가 caller 출력에 도달하는 정의·위치 경로를 제공한다. 제어 의존성·signature 변경·새 동작 전체에 대한 영향 질의로 해석하지 않는다.
- 10: 수기 parameter-value 영향 코퍼스 15개. 언어별 complete 4개에서 기존 DB call-graph precision 0.5 → 1.0(+50%p), recall 1.0 유지. 언어별 partial 1개는 정밀도 분모에서 제외하고 경계·경로 상태를 별도로 검사한다. 개발 합성 코퍼스이며 독립 정확도 근거는 아니다.
- 검증: 전체 테스트 609개, lint/build, 기존 5개 fact-family gate, tarball 실제 설치 CLI 통과(`/tmp/cxt-packed-frontends-8epXaE`). v6→v7 migration/FTS/flow 보존, future schema 거부, 분석·저장 실패 시 전체 rollback 확인.
- 최신 소스 snapshot `/tmp/cxt-summary-verified-2zFPQ6`: 46 files / 1,288 entities / errors 0 / 43.606초 / max RSS 772,596 KiB. local flow 1,013개 중 complete 899 / partial 114. **함수 요약은 complete 9 / partial 1,004**다. 이유는 unknown-external-effect 986, external-value-dependence 499, returned-heap-or-closure 172, unsupported-effect 90, resumable-call-contract 60, work-budget 43, unsupported-parameter-binding 21, partial-cfg 1이며 중복 가능하다. audit critical 0 / warning 33 / minor 18 / errors 0 / pass true.
- AST 추출 timeout 근거 `/tmp/cxt-summary-verified-mVpGxm`도 보존한다(61.501초, 37 files에서 중단, facts commit 0). AST offset/scope/binding 인덱스를 재사용해 unchanged `sqliteStore.ts` 추출 wall 9,409→524ms, CPU 9,555→695ms, entities 142/CFG 125 동일. scan 예산을 늘리지 않았다.
- 핵심 요약 구현은 In Review로 옮긴다. 실제 소스의 높은 partial 비율은 6 외부 의미 모델과 동적 dispatch 지원의 필요성을 보여준다. resource/ownership, 독립 평가 및 6–10의 나머지 기준은 열린 상태다.
