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
- TypeScript resolver에 `tsconfig.json`의 project-relative `baseUrl`/wildcard `paths` mapping 옵션을 추가하고 `scanRepository`의 persisted call-site pass에서 자동 적용했다. alias 대상이 실제 indexed module일 때만 import resolution으로 승격하며, malformed/미설정 config는 기존 unresolved/external 경계를 유지한다. full type inference와 workspace package exports는 아직 미완료다.
- workspace 내부 `package.json`의 `name`을 source root로 색인해 TypeScript package/subpath import도 indexed module에 연결했다. direct resolver와 실제 scan 회귀를 추가했으며 package `exports` 조건·workspace protocol·패키지 타입 추론은 아직 보수적 경계다.
- `package.json#exports`가 있는 workspace package는 명시된 string export만 source target으로 연결하고, export되지 않은 subpath는 `missing-module`로 남긴다. 조건부/배열 외의 복잡한 exports와 workspace protocol은 여전히 보수적으로 미지원이다.
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

## 실행 기록 — 2026-09-27, 6차 조건부 라이브러리 계약

- 6: external import module/symbol을 보존하고 DB v8 `external_json`/`code_model_manifests`에 저장한다. strict JSON schema를 갖춘 기본/사용자 pack을 함수 요약에 연결했다. 모델/pack ID·버전·내용 SHA-256·대상 버전·가정·적용/거절 이유는 flow/summary/parameter impact에 남는다. [계약과 설정](LIBRARY_MODELS.md).
- Node path 10개, Python math 7개, Rust std::cmp 2개 대표 계약을 추가했다. project-declared 정확한 버전, unmodified-external-bindings 가정, 현재 callable identity, positional arity/primitive argument domain이 충족되어야 적용한다. 사용자 객체 변환, namespace callable 미확인, keyword/spread, 중복 후보, 버전 누락/불일치는 unknown을 유지한다. unknown 효과 이후 원래 binding과 미리 복사한 callable을 구분한다.
- 검증: 전체 테스트 628개, lint/build, 실제 설치 CLI의 모델 적용/거절 및 strict 0/2 통과(`/tmp/cxt-packed-frontends-GoZ7yG`). v7→v8 migration/FTS/기존 facts 보존, malformed/missing user pack 거부, 잘못된 config와 후반 저장 오류에서 snapshot/manifest rollback 확인.
- 실제 소스 `/tmp/cxt-models-verified-KgWglZ`: project `cxt`, 47 files / 1,347 entities / errors 0 / 52.452초 / max RSS 903,432 KiB. local flows 938 complete / 117 partial; summaries 11 complete / 1,044 partial. 기본 설정에서 모델 적용 0이며 reachable flow calls 중 unmodeled 308 / assumption-missing 18. 실제 프로젝트에 버전/가정을 임의 선언하여 coverage를 높이지 않았다. 현재 snapshot의 정확도 개선을 주장하지 않는다.
- audit의 project ID를 scan과 맞춰 registry.total 1,347 / untested 368 / highRisk 1 / warnings 0을 확인했다. BS는 83 files / critical 0 / warning 33 / minor 25 / errors 0 / pass true다. **이전 5차 audit는 project ID 불일치로 registry.total=0이었으므로 BS 근거로만 사용한다.** audit pass는 현행 critical/error 정책의 결과이며 전체 semantic completeness 판정이 아니다.
- 실패 증거 `/tmp/cxt-models-verified-DwYoPt`: inline `import(...).Type[]`를 new Map generic 안에 쓰면 tsc는 허용하지만 현재 tree-sitter grammar가 syntax-error를 반환한다. 해당 자체 소스를 `import type`으로 고치고 재측정했다. 전체 snapshot commit 0을 보존했으며 일반 문법 지원 gap은 AGT-4564에 기록했다.
- 제한: runtime/lockfile 자동 버전 확인, namespace/default/receiver, framework callbacks, resource lifecycle/Rust ownership 및 독립 평가가 남는다. 명시한 가정 하의 제한된 모델 계약이다. 다음은 7 AST 규칙과 8 진단 출력이며, 4의 resource/ownership 기준은 계속 열린 상태다.

## 실행 기록 — 2026-09-27, 7차 구조적 규칙

- 7: 기존 20패턴을 AST로 이식하고 completed local dataflow에서만 진단하는 uninitialized-read를 추가했다. 규칙 ID/version/rationale/precision policy/positive-negative fixture, 명시적 path role, comment-only category suppression, JSON source span/flow evidence를 제공한다. [계약 및 의미 변경](STRUCTURAL_RULES.md).
- 10: 21규칙/42개 수기 개발 fixture, 규칙별 precision/recall/span gate 및 extra/missing/duplicate/wrong-rule/span mutation 검사. 현재 각 규칙 1.0이며 2개 fixture의 partial flow는 별도 표시한다. CodeQL 동등성이나 실세계 정밀도 근거가 아니다.
- 검증: 전체 테스트 722개, lint/build, rule/call/flow gates, 실제 tarball 설치와 native 부재 시 BS/scan/CFG/flow/impact CLI 검사 통과(`/tmp/cxt-packed-frontends-nJ9C2N`). 기존 BS 82개 회귀검사는 잘못된 소스 fixture를 실제 문법으로 고쳤으며, Rust partial_cmp unwrap의 잘못된 NaN 면제를 제거했다.
- 실제 소스에서 object property를 lexical local로 취급하던 오류가 definite-uninitialized 36개로 드러났다. TS object/class의 member-only scope를 변수 lookup에서 제외하고 object initializer의 원래 caller를 유지했다. member lookup/lexical TDZ positive/call target/parameter dependency 회귀로 고정했다.
- 최신 BS(`/tmp/cxt-rules-verified-de3LoW`): 91 files / critical 0 / warning 120 / minor 53 / errors 0 / 52.586초. partial 진단 unsupported-effect 280 / work-budget 23 / partial-cfg 1. definite-uninitialized 0. 같은 프로세스의 전체 fact DB scan은 60.706초에 dataflow timeout으로 rollback했고 registry total 0이다. 성공한 최신 snapshot으로 오인하지 않는다. 전체 max RSS 899,868 KiB.
- 성능 수정: partial CFG/effect의 결과는 확정 finding에 쓸 수 없어 solver 전에 사유를 기록한다. 이전 BS timeout(49 files)에서 전체 91 files 처리로 개선됐으며 cap은 늘리지 않았다. 전체 DB scan 성능은 9단계에서 추가로 해결한다.
- AGT-3915: 현재 vega-router tracked src/scripts Python 70파일의 legacy 44 → AST 16 후보. 원래 HTTP/IP/상수 오탐은 사라지고 shortlist_models.py:230의 400은 유지됐다. 과거 64파일과 범위가 달라 전체 FP≤20%는 미입증이며 이 이슈는 유지한다. 새 평가 코드/가격 단위 후보의 판정이 남았다.
- 7 핵심 구현은 In Review로 옮기고 8 SARIF/자동화 결과 계약을 진행한다. resource/ownership, grammar/동적 의미 지원, 8–10 및 독립 평가를 완료하지 않았으므로 전체 목표는 계속 진행 중이다.

## 실행 기록 — 2026-09-27, 8차 SARIF와 자동화 상태

- 8: scan/bs/audit에 JSON/SARIF 2.1.0 및 공통 outcome을 연결했다. exit 0=complete/pass, 1=finding policy, 2=partial, 3=tool failure; failed>partial>finding 우선순위이며 findingsFail은 별도 보존한다. check aliases는 같은 handler를 사용한다. [출력·호환성 계약](ANALYSIS_REPORTS.md).
- SARIF: rule metadata, UTF-16/exclusive range, 상대 URI/encoding, content+occurrence fingerprint, 실제 definition/read 위치의 relatedLocations/codeFlows, tool notifications와 executionSuccessful. endpoint evidence를 전체 runtime trace라고 주장하지 않는다. source 위치를 모르면 줄 번호를 만들지 않는다. legacy credential matched text도 가린다.
- 검증: 732개 테스트, lint/build, 실제 tarball 설치 full/missing-native CLI와 schema 검증(`/tmp/cxt-packed-frontends-TdMKYW`). OASIS approved-errata draft-04 전체 schema를 출처/해시와 함께 고정했다. 추가/누락 출력, Unicode/URI, line-shift fingerprint, normal/partial/syntax/config failure, JSON+verbose 순수 stdout 및 snapshot 보존을 검사했다.
- 실제 현재 저장소 CLI `bs --sarif -v`(`/tmp/cxt-sarif-verified-BIlDJK`): 96 files / 179 findings / 57.166초 / exit 2 / schema valid. parser/flow diagnostics 322개를 partial 상태로 출력했다. 실제 GitHub 업로드나 alert acceptance는 실행하지 않았다. 전체 fact DB timeout은 아직 9단계 해결 대상이다.
- 한 기존 self-scan 테스트가 부하에서 5초를 넘겼다. 이 테스트의 본래 대상인 실제 bsDetector.ts 전체 파일의 AST critical 규칙을 직접 검사하도록 좁혔고 unrelated warning dataflow solver는 분리했다. timeout 값을 늘리지 않았으며 전체 CLI/패키지의 solver 검증은 유지했다.
- 8 핵심 구현은 In Review. 다음 9의 증분 cache/invalidation/read-only query와 cold scan 성능을 진행한다. 10의 독립 평가·CI 및 4 resource/ownership, AGT-3915 전체 FP 목표는 열린 상태다.

## 실행 기록 — 2026-09-27, 9차 증분 snapshot과 fact query

- 9: DB v9에 content/engine/parser frontend cache와 linked CFG/callee summary/model manifest SCC cache를 추가했다. 매 scan 현재 imports를 재해석하며 전체 facts/cache를 원자적으로 교체한다. `scan --full` 재계산과 `query entities|calls|cfg|flows|summaries`의 project-bound/allowlist/parameterized/bounded read 계약을 제공한다. [계약과 측정](INCREMENTAL_FACTS.md).
- 검증: 전체 742 tests, lint/build, 실제 tarball 설치 CLI(`/tmp/cxt-packed-frontends-3LzhFv`). 변경 없음/엔진·파일·전이 의존성·삭제·재귀 SCC·모델 변경·native 복구, incremental/full 동등성, cache corruption 및 저장 실패 rollback. 55개 query 구조 mutation 거부, filter data 무해 처리, project 격리와 기존 facts 보존을 확인했다. 레거시 table rebuild가 query view 때문에 실패하는 사례를 실제 재현하고 transaction 안에서 파생 view를 재생성하도록 수정했다.
- 초기 5회 측정은 4번째 cold가 60.017초 dataflow timeout/rollback으로 실패(`/tmp/cxt-incremental-bench-IPjtZp`). CPU profile에 따라 추상값 정규화 반복을 줄였고 동일 고정 입력의 전체 facts SHA 및 기존 CFG 226개의 결과 일치를 확인했다. cap/분석 budget을 늘리지 않았다.
- 최종 5쌍의 새 프로세스 측정(`/tmp/cxt-incremental-bench-U5UlKV`, `bench/incremental-baseline.json`): cold p50/p95 35.113/40.499초, warm 9.194/11.186초, scan peak RSS 최대 cold 819.7/warm 559.3 MiB. 사전 cold≤60초/warm≤15초/RSS≤1 GiB budget 통과. 59파일/1,603 entities의 10개 실행 facts SHA가 모두 같다. p95는 표본 5개의 최대값이며 호스트에 다른 학습/CI 작업이 실행 중이었다.
- Local flow 1,083 complete/142 partial, 함수 요약 14 complete/1,211 partial. Warm frontend 59/SCC 1,210 hit는 의미적 coverage 개선이 아니다. Query는 source freshness 미검증을 명시한다. BS/audit의 직접 source 분석은 cache 대상이 아니다.
- 9 핵심 구현은 In Review. 10 실제/held-out 평가와 CI, 4 resource/ownership 및 AGT-3915 전체 FP 기준은 계속 열린 상태다. 원격 ci-templates의 constitution-gate.yml은 현재 존재함을 확인했지만 Node 언어 workflow는 아직 없다. 전체 목표를 완료로 표시하지 않는다.
- fact query view에 flow의 resource/ownership finding count와 summary의 formal move/borrow parameter count를 추가했다. DB schema v10 migration에서 기존 v9 fact view를 원자적으로 재생성하고, 재오픈 시 불필요한 DDL을 반복하지 않는다. query API가 semantic ownership coverage를 구조적으로 필터링할 수 있는 실제 migration 회귀를 추가했다.

## 실행 기록 — 2026-09-27, 10차 실제 선언 코퍼스 착수

- AGT-3878/3879: Zod 4.3.6 util.ts 구간, Ubuntu CPython 3.12.3 fnmatch.py 전체, rust-fnv 1.0.7 lib.rs 구간을 원본/구간/license SHA와 함께 고정했다. `bench:external`은 수기 선언 라벨 32개(TS18/Python6/Rust8)의 span/scope/syntactic export/parameter count를 검증한다. 현재 parser의 출력을 정답으로 사용하지 않는다. source/license/label integrity를 분석 전에 검사하며, vendored 코드의 라이선스를 별도 보존하고 제품 자체 scan에서는 제외한다.
- 첫 결과 `external-first-evaluation.json`: TS/Python 전 필드 일치, Rust scope 5/8. 원인은 세 trait method 라벨에서 trait 한정자를 누락한 것이었다. Rust Reference와 기존 `rust/trait-impl` 정답에 따라 라벨만 고치고 최초 라벨·SHA·세 수정의 근거를 `expected.v1.json`/`label-revisions.json`에 보존했다. 엔진 변경 없이 정정 회귀 기준선은 모든 지표1.0이다. 첫 결과를 덮어쓰거나 corrected 결과를 unseen 성능으로 주장하지 않는다.
- 같은 소스 lexical 기준선: TS recall 2/3, Python precision/recall 2/3, Rust precision 8/11/recall1. span/scope/metadata는 `external-lexical-baseline.json`에 별도 기록했다. 세 소스 구간의 선언 평가이며 호출·flow·규칙의 실세계 성능을 의미하지 않는다.
- 검증: 전체745 tests, 기존 src lint와 신규 benchmark/test의 별도 strict typecheck, AST/lexical gate 실행. source/license/label 변조 및 export/parameter/중복/누락/span/scope mutation의 실패를 확인했다. 로컬 package runtime 변경이 없어 이전 설치 검증을 재사용한다.
- self/held-out 계층·독립 PR 라벨 리뷰·실제 call/flow/rule 정답·CI는 계속 열린 상태다. AGT-3878/3879는 In Progress를 유지한다.

### 10차 후속 — 자기 코드 선언 inventory

- `bench:self`: f711a50의 entityScanner.ts 전체 source/Git blob/license snapshot을 고정했다. 독립 TypeScript 5.9.3 compiler AST로 보조 작성하고 source boundary를 검토한 최상위 이름 있는 선언50개다. 수기/독립 PR 리뷰 라벨로 부르지 않으며 이 자기 코드로 call/flow 정답을 만들지 않는다. 원격 commit 존재를 주장하지 않고 provenance의 검증 경로를 local-git-commit으로 구분했다.
- 첫 AST 평가(`self-first-evaluation.json`)는 선언/span/scope/export/parameter 전부50/50. 같은 snapshot의 lexical은 recall24/50, span23/24, export24/50, parameter22/50. 과거49개 코퍼스와 source revision이 다르다. 중첩 선언은 별도 범위이며 extra/missing 최상위 선언이 점수를 낮추는 회귀를 추가했다.
- self/real-world loader의 source/license/label 무결성 및 scanner와 독립적인 정답 출처를 유지한다. 다음은 held-out 및 CI이며 독립 라벨 리뷰·실제 call/flow/rule labels·resource/ownership 등의 열린 기준은 남아 있다.

### 10차 후속 — 공유 Node CI와 실제 self-scan

- AGT-3880을 In Progress로 시작했다. 기존 원격 constitution gate를 호출하는 cxt workflow와 Node 22·24 × ubuntu·macOS reusable workflow를 추가했다. 공통 Node 게이트는 lint/test/build, 8개 accuracy corpus gate, package smoke, self-scan을 실행한다. Node reusable workflow 변경은 `ci-templates` 소유 저장소에 두고, cxt에는 caller만 둔다.
- 전체 저장소 self-scan 1회는 61개 파일/1,634 entity, errors 0, snapshot commit 성공, flow 1,098/1,242 complete·144 partial로 끝났다. 반복 실행 1회는 snapshot commit timeout(60초)으로 실패했다. 이를 근거로 CI smoke는 `src/analysis/report.ts`의 실제 source slice를 격리해 API/DB snapshot 경로를 검증한다: 1 file/10 entities, errors 0, snapshot commit 성공, 7/9 flow complete·2 partial. partial은 명시된 coverage이며 `failed`, scan errors, uncommitted/empty snapshot은 실패한다.
- 로컬 검증: 746 tests, lint/build, declaration/call/CFG/dataflow/impact/rules/external/self accuracy gate, packed package smoke, focused self-scan 모두 통과. `workflow_integrity.py`는 cxt의 두 workflow 및 ci-templates의 네 workflow에서 위반 0건, ci-templates gate fixture는 각 실행에서 17 tests 통과.
- 아직 원격 workflow 실행 결과나 GitHub required-check 지정은 없다. ci-templates Node workflow가 원격 `main`에 게시되기 전까지 cxt의 caller는 해당 경로를 해석할 수 없다. AGT-3880 DoD의 PR 4-matrix green과 required-check 설정은 미검증이며 열린다.

### 규칙 오탐 후속 — positional domain 인자

- AGT-3915의 실제 Python 코드베이스 `src` 범위(읽기 전용 재검사, 46 files, errors 0, partial/exit 2)에서 `magic_number` 10건을 확인했다. 두 건은 함수 인자 이름이 문자 길이 제한임을 시그니처에서 알 수 있었다.
- Python 함수 호출에서 같은 소스 안에 이름이 유일한 함수/메서드 정의가 있고 positional parameter가 `limit`, `size`, `timeout` 등 기존 domain-name 규칙에 맞을 때만 직접 숫자 인자를 억제한다. 메서드는 호출자와 정의가 같은 클래스 안의 `self`/`cls` 호출일 때만 연결하고, star expansion 뒤의 인자는 억제하지 않는다. typed parameter, 중복 함수 정의, 산술 계수도 각각 테스트했다. 동일 명령/범위에서 magic-number 결과가 10→8로 감소했다. 산술 코퍼스 정탐은 유지됐다.
- 남은 8건은 해당 프로젝트에서 benchmark/probe 역할을 하는 코드로 보이나, 자동 path inference의 충분한 근거는 확보하지 못했다. 전역 경로 예외를 추가하지 않았으며 프로젝트의 명시적 path-role 설정 또는 사람의 분류가 필요하다. 10→8은 건수 변화이지 precision/FP 비율 개선으로 계산하지 않는다. AGT-3915의 전체 FP≤20% DoD는 여전히 미검증이다.
- 검증: focused AST rule tests 46, 전체 747 tests, lint/build, `bench:rules`, packed package smoke 통과. 실제 CLI는 외부 Python source tree를 읽기 전용으로 평가했다.

### dataflow 후속 — Python context-manager target

- `with manager as target` CFG가 `as_pattern` 전체를 일반 expression으로 평가하던 경로를 수정했다. context expression만 평가하고, `__enter__` operation에서 target에 unknown 값을 정의한다. 따라서 target을 enter 전에 읽은 것처럼 기록하지 않는다.
- unknown enter value와 lifecycle은 완료로 단정하지 않는다. 해당 fact에 `unsupported-effect` diagnostic을 남겨 dataflow를 partial로 유지한다. alias/`__enter__` 반환, `__exit__` close/suppress semantics 및 ownership state는 아직 구현되지 않았다.
- AGT-4569 모델 schema에 명시적 `resource` 계약(`acquire|release`, `return|receiver|argument`, argument index 검증)을 추가했다. 이는 외부 API의 선언된 lifecycle 사실을 보존하는 기반이며, solver가 아직 이를 소비하지 않으므로 resource state/close 누수 검출 완료로 해석하지 않는다.
- 적용된 resource 계약은 dataflow `resourceEvents`와 `FlowCall.resource`에 acquire/release identity를 남긴다. identity를 증명하지 못한 release는 `proven=false`로 보존하며, cleanup pairing·누수 진단은 다음 단계다.
- resource state를 path state에 유지해 추적 가능한 use-after-release와 종료 leak 후보를 `resourceFindings`로 산출한다. release의 throw/unknown effect가 있으면 `possible`로 보수화하고, 반환값에 resource atom이 남으면 ownership transfer로 leak에서 제외한다. generic `with`의 `__exit__` pairing은 아직 미지원이다.
- repository scan 결과에도 `resourceFindings` 집계(total/definite/possible/useAfterRelease/leak)를 노출해 저장된 flow JSON 외부에서도 lifecycle coverage를 확인할 수 있게 했다.
- `with manager as target`에서 Python `as_pattern`의 실제 manager child를 평가하도록 고쳤고, `__exit__` cleanup node가 같은 manager temporary를 참조한다. 따라서 manager call에 적용된 resource 계약은 정상/예외 cleanup edge에서 release state로 연결된다. `__enter__` 반환값 자체와 suppression semantics는 여전히 generic unknown이다.
- 함수 summary에도 fresh resource 반환 사실을 보존해 acquire wrapper를 호출한 caller가 새 identity를 다시 만들 수 있게 했다. callee의 구체적인 resource atom은 caller로 그대로 복사하지 않고 remap하며, wrapper의 release/use-after-release 경로를 회귀 검증했다.
- release wrapper도 formal parameter index를 `releasesResource`로 요약해 caller의 actual resource state를 닫는다. local resource를 닫는 내부 호출은 summary contract로 올리지 않으며, provenance가 하나로 증명되지 않으면 보수적으로 unknown으로 남긴다.
- borrowed-return wrapper도 formal parameter resource provenance가 모든 반환 경로에서 일치할 때만 `returnsResource: { source: 'parameter', parameter }`로 승격한다. caller는 actual argument alias만 전달하며 plain value와 혼합/모호한 반환은 보수적으로 제외한다.
- Rust ownership 후속: heap/resource identity가 증명된 값의 move 후 사용을 intraprocedural flow와 scan/CLI 결과에 `ownershipFindings.useAfterMove`로 집계한다. primitive Copy와 `&value` borrow는 회귀로 구분하며, 타입 정보가 없는 unknown 값 전체를 move로 단정하지 않는다. struct trait/Copy 구현, 함수 인자별 move·borrow 계약은 아직 독립 평가 전이다.
- 모델 계약 후속: `ownership.moves`/`ownership.borrows`를 model pack schema와 `FunctionSummary.movesParameters`에 추가했다. 명시된 Rust external API와 그 wrapper만 actual argument move를 caller에 전파하며, 계약 없는 호출은 상태를 바꾸지 않는다. 기본 pack에는 `std::mem::drop` consuming contract를 추가했다.
- Alias summary 후속: 모든 반환 경로가 같은 formal parameter identity를 반환하는 wrapper를 `returnsParameter`로 요약하고 caller actual object/resource atom을 재대입한다. broad unknown return atom을 그대로 복사하지 않아 wrapper 뒤 field mutation alias를 보존한다.

### 10차 후속 — held-out dataflow tier

- `bench/corpus/held-out/dataflow.json`에 TS/Python/Rust 6개 fixture와 `provenance.json`을 추가했다. synthetic corpus와 ID/source 중복을 loader가 거부하고, `bench:flow:heldout`으로 별도 report/baseline을 생성한다.
- 현재 held-out-review 결과는 TS/Python/Rust 각각 2/2 fixture pass, 관계·read status·completeness 모두 일치한다. 다만 label은 single-agent source review이며 독립 second-reviewer sign-off가 pending이므로 CodeQL 수준 정확도 또는 독립 평가로 해석하지 않는다.
- 독립 review gate는 primary/secondary reviewer가 모든 held-out fixture를 중복 없이 검토하고, 각 reviewer의 label SHA가 현재 label bytes와 일치할 때만 통과한다. 일부 fixture만 검토하거나 stale label을 서명한 manifest는 fail-closed다.
- 증분 benchmark가 실제 cxt source의 `resolveSymbols.ts`에서 tree-sitter syntax error를 발견했다. `abstract` reserved property key를 `isAbstract`로 바꾸고 self-source parse 회귀를 추가해 cold/warm scan이 다시 commit되도록 고쳤다. 3-sample 결과는 cold p95 29.3s, warm p95 6.4s, max RSS 963 MiB로 현재 60s/15s/1 GiB budget 안이며, semantic fact hash가 cold/warm 동일하다.
- `bench:flow --require-independent-review` gate를 추가해 primary/secondary reviewer 식별자, fixture coverage, reviewer별 label SHA-256과 pending 해제를 요구한다. 현재 provenance에서는 의도적으로 실패하며, 실제 second review가 추가되기 전 독립 정확도 주장을 차단한다.
- `bench:flow:review-bundle`을 추가해 analyzer output 없이 held-out source/expected labels, 현재 label SHA-256, reviewer sign-off template를 전달할 수 있게 했다. bundle 생성은 독립 review나 pending gate 해제를 의미하지 않는다.
- `with` manager factory는 자체 CFG expression에서 한 번만 실행하고 `__enter__` node는 그 temporary를 재사용한다. Python external acquire model의 정상 return edge에서 acquire event 1회와 cleanup release를 확인했다.
- exception exit도 resource state를 검사한다. `__enter__`가 끝나기 전 throw하는 unknown edge는 cleanup이 보장되지 않으므로 definite leak 후보로 남기고, body throw 뒤 cleanup을 통과한 edge는 release event와 함께 가능한 잔여 leak만 보존한다.
- acquire 계약의 `enter=same`를 명시하면 `as` alias에만 manager identity를 전달한다. 따라서 `with` 밖 alias 사용을 close 이후 use-after-release로 찾을 수 있고, 기본 `unknown`은 기존 보수적 동작을 유지한다.
- 회귀는 use가 uninitialized가 아니고 source definition을 가지며, lifecycle diagnostic과 `resource-enter` CFG binding이 있는지 검증한다. 다중 manager에서 각 target의 suite 내부 binding을 확인하고, 두 번째 `__enter__` 실패를 앞선 `__exit__`가 억제해 suite 뒤로 진행하는 경우 두 번째 target은 may-uninitialized로 남긴다. `analyzeSemanticRules` 경로는 이런 CFG를 partial로 내고 definite `uninitialized-read`를 발행하지 않는다. 전체 750 tests, CFG 30 fixtures/54 paths, flow 27 fixtures, lint/build 및 package smoke 통과.

### 10차 후속 — Rust ownership과 dataflow gate

- Rust intraprocedural flow가 proven heap/resource identity의 assignment/return move 뒤 읽기를 `ownershipFindings.use-after-move`로 노출한다. primitive Copy 값과 명시적 `&value` borrow는 moved로 표시하지 않으며, 타입 정보가 없는 unknown 값은 임의로 move로 단정하지 않는다. scan 결과와 `cxt flow` text/JSON에 ownership 집계를 추가했다.
- dataflow corpus에 move/borrow positive-negative fixture를 추가했다. 현재 합성 gate는 TS 9/Python 9/Rust 11, relation 32/32, read status 23/23, ownership 29/29, completeness 29/29로 통과했다. 이는 synthetic-development 회귀이지 held-out/실세계 정확도 증거가 아니다.
- 검증: 전체 44 files / 754 tests, build, lint, diff check, `bench:flow`, packed package smoke 통과. Rust Copy trait/struct semantics와 함수 인자별 move/borrow summary는 미완료로 남긴다.

### 10차 후속 — TypeScript package exports 조건·패턴

- workspace `package.json#exports`의 root conditional target(`import`/`require`/`default`/`node`/`types`)을 우선순위대로 후보화하고, `./features/*` 같은 subpath pattern을 실제 indexed source path로 확장한다. `.js`/`.d.ts` target도 저장된 `.ts` 구현을 먼저 확인한다.
- `exports`가 없는 package의 기존 root/subpath 동작은 유지한다. exports가 있는 package에서 명시되지 않은 private subpath, 알 수 없는 조건만 있는 target, indexed source가 없는 target은 `missing-module`로 남긴다. runtime condition 선택·workspace protocol·full type inference는 지원 완료로 해석하지 않는다.
- direct resolver 및 실제 scan에 conditional root/wildcard/private-path 회귀를 추가했다. focused 90 tests, build, lint 통과. 변경은 AGT-4565에 기록했다.

### 10차 후속 — generator yield suspension

- TypeScript/Python generator의 `yield`를 값 평가 → `suspend`/`suspensionExit` → `resume` continuation으로 CFG에 낮췄다. 재개 시 주입될 예외는 abrupt throw edge로 보존해 try/finally cleanup 경로가 끊기지 않는다.
- 기존 yield partial fixture를 complete 정답으로 교정했다. CFG/dataflow/CLI/SARIF 테스트의 partial 계약은 실제 미지원 구문과 async context-manager의 남은 lifecycle effect에 맞춰 갱신했다.
- async iteration의 iterator-next와 Python async context-manager의 enter/exit를 `suspend`/`resume`으로 낮추고 injected exception edge를 추가했다. TS/Python async-for와 async-with의 제어 경로는 complete CFG에서 보존되지만, async context-manager resource identity/ownership semantics는 dataflow에서 아직 partial이다.
- 검증: 전체 44 files / 778 tests 통과. generator TS/Python suspension 회귀, CFG 및 dataflow accuracy gate, CLI strict exit와 SARIF partial 계약을 확인했다. scheduler의 실제 재개 순서와 `yield from`의 완전한 delegation semantics는 아직 모델링하지 않는다.
- Python `yield from`은 delegated expression을 평가한 뒤 exhaustion condition과 반복 `yield from resume` suspension cycle을 CFG에 보존하고, 각 재개 지점의 injected exception edge도 연결한다. delegation의 실제 iterator value/throw/send protocol은 여전히 추상 condition으로 유지한다.
- ownership finding에는 use node와 moved state를 만든 `FlowDefinition` ID를 함께 저장해 `flow.definitions`와 join 가능한 path provenance를 제공한다.
- resource finding에도 `sourceNodes`를 추가해 acquire/release CFG node와 use-after-release 또는 leak 진단을 정적으로 연결한다. `cxt flow --json`의 `locations`와 join할 수 있으며 실행 경로 trace로 해석하지 않는다.
- `ownership.borrows`도 `FunctionSummary.borrowsParameters`로 전파해 모델·wrapper의 borrow 계약을 move 계약과 구분한다. borrow는 caller의 moved state를 변경하지 않으며, Rust trait/Copy 타입 증명 자체는 아직 열린 범위다.
- `cxt flow --sarif`를 추가해 resource/ownership finding을 SARIF result와 static `codeFlows`로 내보낸다. acquire/release 또는 moved-state definition node는 related location으로 연결하며, partial 분석은 exit 2와 notification을 유지한다.
- `scan --sarif`도 현재 commit된 flow snapshot의 semantic result를 병합한다. incomplete scan에서 이전 snapshot을 현재 source의 finding으로 재사용하지 않으며, rule index를 재계산해 SARIF consumer가 안정적으로 읽게 한다.
- semantic flow SARIF fingerprint도 rule/file/normalized source text/provenance SHA-256으로 고정해 line shift에서 결과 identity가 흔들리지 않게 했다.
- Rust ownership 후속에서 literal-only fixed arrays/tuples를 Copy로 판정하고, struct expression은 non-Copy로 유지했다. `use-after-move` 회귀가 실제 non-Copy struct에서만 발생하고 `[1,2]` 대입에는 발생하지 않는지 synthetic/held-out gate에 반영했다. 사용자 `Copy` impl, generic bound, trait dispatch는 별도 타입 frontend가 필요하다.
- 같은 파일의 `impl Copy for Type` AST 선언도 확인해 해당 struct만 Copy로 승격한다. 현재 synthetic gate는 TS 9/Python 9/Rust 12 fixture에서 relation 32/32, read status 23/23, ownership 30/30, completeness 30/30으로 통과했다. 이는 개발 회귀이며 Rust 전체 trait/generic 의미를 검증한 결과가 아니다.
- Rust 함수 본문에서 typed non-primitive formal parameter를 직접 대입/반환하는 move와 `&parameter` borrow를 `DataflowResult`에 기록하고 `FunctionSummary.movesParameters`/`borrowsParameters`로 승격했다. primitive/reference type은 휴리스틱으로 제외하며, generic bound·trait dispatch·cross-crate type resolution은 아직 완전한 타입 의미가 아니다. direct move/borrow summary 회귀를 추가했다.
- 프로젝트 `Copy` 집합을 parameter variable에도 적용해 다른 파일에서 정의된 Copy struct를 인자로 받는 함수의 move 오탐을 막았다. allocation과 parameter 양쪽에 cross-file 회귀를 추가했지만, 동명이인·generic specialization은 여전히 이름 기반 보정의 한계다.
- Rust reference parameter 판정이 `&T`, `&mut T`, `*const T`, `*mut T` 전체를 borrow/reference 경계로 인식하도록 수정했다. 네 가지 parameter 형태가 move summary와 use-after-move를 만들지 않는 회귀를 추가했다.
- cross-file `Copy` 보정은 이제 프로젝트 내 Rust type declaration 이름이 유일할 때만 적용한다. `Copy` 선언과 non-Copy 동명 타입이 함께 있으면 보수적으로 move를 유지하는 실제 `scanRepository` 회귀를 추가했다.
- Rust `#[derive(Copy, Clone)]`의 attribute AST를 struct/enum/union 선언과 연결해 `impl Copy for T`와 동일한 ownership fact로 승격했다. `Clone`만 있는 타입은 계속 non-Copy로 유지하며, direct dataflow·cross-file scan·개발 dataflow corpus 회귀를 추가했다. Rust generic bounds와 derive macro 내부 의미는 여전히 타입 frontend 범위 밖이다.

### 10차 후속 — 모델이 증명한 sync/async context-manager lifecycle

- AGT-4569: external model의 `resource={action: acquire, identity: return, enter: same}`가 manager factory와 일치할 때만 `with`/`async with`의 generic `Context-manager return value and ownership lifecycle are not modeled` diagnostic을 제거한다. `enter=unknown`, 모델 부재, version/assumption 불일치는 계속 partial로 남긴다.
- manager factory의 실제 call effect를 source span으로 다시 찾아 계약을 검증하므로, 같은 함수의 다른 call이나 이름만 같은 local manager를 승격하지 않는다. sync/async cleanup event와 resource identity는 기존 dataflow/SARIF provenance를 그대로 사용한다.
- 회귀: Python `builtins.open` sync/async 모델 적용에서 lifecycle diagnostic 부재와 proven acquire/release를 확인하고, generic manager는 기존 partial 경계를 유지한다.
- 검증: 전체 44 files / 839 tests, `npm run build`, `npm run lint`, `git diff --check`, `npm run test:package` 통과. 이는 모델이 선언한 lifecycle 계약 범위의 완전성만 증명하며 arbitrary context-manager protocol, suppression semantics, 실제 scheduler ordering은 여전히 미지원이다.
- Rust `T: Copy` generic bound를 함수 parameter metadata에 보존해 generic parameter의 move를 Copy로 처리한다. `T: Clone`만 있는 경우는 move/use-after-move를 유지하며, direct dataflow와 개발 corpus(`Rust 14`, relation/read/ownership/completeness 18/18·14/14·14/14·14/14)를 추가 검증했다.
- generic declaration의 `derive(Copy)`는 specialization별 trait 증명이 없으므로 전역 Copy fact로 승격하지 않는다. 따라서 `Wrapper<NonCopy>`를 Copy로 잘못 판정하지 않으며, trait solver 도입 전까지 보수적 unresolved/move 경계를 유지한다.

### 10차 후속 — async resource lifecycle 경계

- Python `async with`의 CFG enter/exit suspension을 dataflow에 연결했다. suspension 전후 state에서 기존 manager temporary와 `resource-enter` binding을 유지하며, custom acquire model fixture의 acquire/release event가 proven으로 기록된다.
- async context-manager CFG operation text를 Python protocol에 맞춰 `__aenter__`/`__aexit__`로 보존하고, sync `with`는 `__enter__`/`__exit__`를 유지한다. dataflow call-effect 인식과 suspend/cleanup 회귀를 갱신했으며, `__aexit__` 반환값의 실제 suppression semantics는 여전히 partial이다.
- async context-manager 반환값·ownership transfer·`__aexit__` suppression의 완전한 semantics는 아직 partial/보수 처리한다. 검증: 전체 44 files / 781 tests, build, lint, diff check 통과.

### 10차 후속 — TypeScript interface receiver dispatch

- interface 타입 receiver의 member call을 프로젝트 내 구현 class로 연결한다. 구현 class가 하나일 때만 `receiver-type` resolved edge를 만들고, 여러 구현이 있으면 `ambiguous-binding` unresolved로 유지한다.
- direct resolver와 실제 `scanRepository` persisted call-site 회귀를 추가했다. 기존 synthetic call gate는 TS/Python/Rust 모두 precision/recall/site/resolution 1.0을 유지했으며, full type inference·union narrowing·runtime dynamic dispatch는 아직 미지원이다.

### 10차 후속 — Rust trait receiver dispatch

- Rust `impl Trait for Type`의 trait/type AST facts를 저장하고, trait-typed receiver의 method call을 유일한 concrete impl로 연결한다. 구현이 여러 개면 `ambiguous-binding`으로 남기며 trait declaration 자체를 concrete target으로 가장하지 않는다.
- direct resolver 및 실제 scan persisted call-site 회귀를 추가했다. 전체 44 files / 786 tests, build, lint, diff check 통과; synthetic call gate는 기존 TS/Python/Rust 지표 1.0을 유지한다. dyn-trait runtime dispatch, generic bounds, cross-crate coherence는 미지원이다.

### 10차 후속 — TypeScript union receiver dispatch

- `A | B` type annotation을 union symbol value로 보존하고 각 arm의 receiver member를 독립 해석한다. 모든 arm이 같은 concrete method로 수렴할 때만 resolved edge를 만들며, divergent method나 unresolved arm은 `ambiguous-binding`으로 남긴다.
- 공통 base method 수렴과 divergent method 회귀를 추가했다. full control-flow narrowing(`instanceof`/discriminant), generic conditional types, runtime union refinement는 아직 미지원이다.
- Rust trait 구현은 `SymbolResolution.bases`와 저장소 relation에도 `implements` edge로 보존해 impact/query 경로가 call resolution과 같은 trait graph를 사용하도록 했다.
- Rust generic function의 `T: Trait` bound를 function scope fact로 보존하고 `x.method()`를 concrete impl로 추측하지 않은 채 trait declaration method로 연결한다. 여러 bound 중 indexed trait를 찾지 못하거나 bound가 없는 generic receiver는 unresolved로 유지하며, generic specialization·dyn-trait runtime dispatch·cross-crate coherence는 아직 solver 범위 밖이다. 전체 44 files / 812 tests와 synthetic call gate(TS/Python/Rust precision·recall·site·resolution 1.0)로 검증했다.
- TypeScript generic function의 단일 `T extends Interface` bound도 같은 방식으로 interface method signature를 abstract target으로 resolve한다. same-file 및 imported interface method signature를 symbol scope에 보존하고, union/conditional bound는 추측하지 않는다.
- 단순 identity conditional alias(`T extends string ? A : B`)는 구체적인 `Alias<number>`/`Alias<string>`에서 branch type을 선택해 return receiver를 연결한다. subtype 관계, `infer`, object/union/conditional 중첩은 unresolved로 유지한다.
- Python base-class receiver에 indexed subclass override가 있으면 base method를 확정하지 않고 `ambiguous-binding`으로 낮춘다. subclass가 method를 상속만 하는 경우에는 동일 target을 중복 추가하지 않는다.
- library model은 namespace/default import의 정적 property callable도 external identity와 callee proof를 유지한 채 적용한다. unknown effect가 먼저 binding을 오염시킨 경우에는 기존 `callee-not-proven` 경계를 유지한다. framework callback과 async envelope는 아직 미지원이다.
- library model에 `callbacks` parameter contract를 추가해 registration API가 받은 proven function target을 `FlowCall.callbacks`에 보존한다. wrapper summary는 `callbackParameters`로 formal provenance를 전달하고 registry snapshot에는 `registers` relation을 적재한다. 실제 scheduler 재호출·async envelope는 아직 해석하지 않는다.
- 명시적 library model taint source/sink 계약을 추가했다. source 반환의 `tainted` atom이 wrapper를 거쳐 sink parameter에 도달하면 flow finding과 scan aggregate로 기록된다. `propagatesParameters`로 명시적 변환 함수의 taint 보존을, `sanitizesParameters`로 명시적 sanitizer의 taint 제거를 지원하며, 이름 기반 추론·복합 변환·framework 전파는 여전히 보수적으로 미지원이다.
- Python의 무수입 builtin call도 callee가 local binding이 아닌 external name일 때만 `builtins` model catalog로 연결한다. 따라서 `input()`/`eval()` 같은 일반 호출은 versioned taint/resource contract를 적용하고, 같은 이름의 local `eval` shadowing은 model 적용 대상이 아니다.
- TypeScript/JavaScript 전역 `eval()`도 같은 external-binding 경계를 사용해 `global.eval` sink model을 적용한다. `node:fs.readFileSync` source와의 조합을 검사하지만 local `eval` 선언은 승격하지 않는다.
- taint sink finding을 `cxt flow --sarif`와 `scan --sarif`의 `cxt/taint-sink` result로 내보내고, scan outcome의 `findingsFail`에 반영했다. partial 분석은 exit 2를 우선하지만 finding 존재를 숨기지 않는다. 2026-09-28 검증은 전체 44 files / 817 tests, build, lint, diff check, call benchmark 통과다.
- modeled sink를 감싼 사용자 함수의 formal parameter provenance도 `taintSinkParameters` summary로 승격해 caller taint를 interprocedural finding으로 연결했다. 직접 모델 contract가 없는 내부 wrapper도 sink 경계를 보존하지만, sanitizer/복합 변환의 자동 추론은 하지 않는다.
- sink wrapper가 `unknown` side effect 때문에 `partial`이어도 명시된 taint source/sink/propagation/sanitizer contract는 caller에서 소비한다. 따라서 불확실한 heap/value effect는 보수적으로 유지하면서 `source → wrapper → effectful sink` finding을 잃지 않는다. Python `input → load → run → eval` 다중 파일 회귀를 추가했다.
- taint finding에 source definition ID를 보존하고 SARIF related location/code flow로 source-to-sink 정적 provenance를 내보낸다. 이는 실행 trace가 아니며, source definition을 복원하지 못한 finding은 sink 위치와 atom만 유지한다.
- taint SARIF codeFlow가 `FlowDefinition.dependencies`를 재귀적으로 펼쳐 source→중간 assignment→sink의 정적 definition chain을 포함한다. `pathDefinitions`와 propagation location을 함께 내보내며, runtime execution trace로 해석하지 않는다. schema 및 intermediate-chain 회귀를 추가했다.
- callback model에 명시적 `arguments` mapping을 추가해 registration argument의 taint를 callback summary sink까지 연결한다. scheduler 재호출 순서, callback return/exception envelope, framework별 event semantics는 여전히 모델 범위 밖이다.
- 기본 식의 산술·문자열 결합(`+`, `-`, `*`, `/`, `%`)과 opaque expression은 입력 `tainted` atom을 보존한다. 따라서 단순한 로컬 변환은 별도 library model 없이 sink까지 도달하지만, sanitizer 의미나 복잡한 API 변환은 여전히 명시적 model이 필요하다.
- 기본 Node library model에 timer/process callback registration(`setTimeout`, `setInterval`, `setImmediate`, `nextTick`)을 추가했다. callback target과 빈 input mapping만 증명하며 실제 scheduler ordering/cancellation/async exception envelope는 미지원이다.
- callback model에 명시적 `variadic` arity를 추가해 timer callback 뒤의 extra positional arguments를 argument-mapping 실패 없이 허용한다. 추가 인자의 callback 전달 의미는 아직 자동 추론하지 않는다.
- `variadicArgumentsFrom` callback mapping을 추가해 모델이 선언한 extra argument 구간만 callback dataflow/taint 입력으로 연결한다. wrapper가 임의의 variadic 호출 순서를 재구성하거나 scheduler semantics를 추론하지는 않는다.
- nullish fallback(`??`)도 data-producing expression으로 taint를 보존한다. 반대로 `undefined`/boolean predicate는 데이터 결과가 아니므로 taint를 전달하지 않는 회귀를 추가했다.
- TypeScript non-null assertion(`!`)도 값의 타입만 좁히고 데이터 identity는 바꾸지 않으므로 taint를 보존한다. sanitizer나 API 의미를 자동 추론한 것은 아니다.

### 10차 후속 — TypeScript `instanceof` narrowing

- positive `if (x instanceof A)` consequence span과 lexical block scope를 symbol facts에 저장하고 해당 함수 흐름 내부 union receiver만 `A` instance로 좁힌다. nested function shadowing은 refinement를 상속하지 않으며 branch 밖 호출은 기존 union ambiguity를 유지한다.
- braces 없는 single-statement consequence도 가장 안쪽 enclosing lexical scope로 기록해 동일한 narrowing을 적용한다.
- direct resolver 및 실제 scan persisted call-site 회귀를 추가했다. interface와 object type-alias fixture, imported module fixture를 포함한 전체 44 files / 812 tests, build, lint, diff check 통과. 동일 discriminant의 `OR` disjunction과 다른 guard와 결합한 positive consequence를 지원하며, else의 compound semantics·서로 다른 조건 조합과 복합 generic conditional types는 아직 미지원이다.

### 10차 후속 — TypeScript discriminant narrowing

- interface의 literal property(`kind: "a"`/number literal)를 discriminant fact로 저장하고 `x.kind === literal` consequence 안에서 union arm을 하나로 좁힌다. 일치 arm이 하나가 아니거나 interface 구현 method가 여러 개면 `ambiguous-binding`으로 유지한다.
- 구현 class가 하나씩 있는 `A | B` interface 및 object type-alias fixture의 direct resolver·실제 scan persisted call-site 회귀를 추가했다. `===`/`!==`의 consequence와 else branch를 모두 좁히며, imported module의 discriminant 선언도 전체 파일 map에서 resolve한다. 같은 property에 대한 `x.kind === "a" || x.kind === "b"` disjunction과 `x.kind === "a" && ready`의 consequence도 지원한다. else의 compound semantics·서로 다른 조건 조합과 generic conditional type semantics는 아직 미지원이다.
- TypeScript `switch (x.kind)`의 literal `case`와 `default` clause를 same-file 및 imported union arm narrowing으로 연결하고, persisted call-site 회귀를 추가했다. 종료하지 않는 case의 fallthrough에서는 누적된 literal 값을 다음 case에 전달하며, 그 fallthrough로 도달한 `default`는 보수적으로 narrowing하지 않는다. generic conditional types는 아직 미지원이다.
- TypeScript conditional alias에 union type argument가 들어오면 각 arm의 branch를 따로 평가한다. 모든 arm이 같은 branch를 고를 때만 dispatch를 확정하고, mixed branch는 `ambiguous-binding`으로 유지한다. 호출 반환형에서 발생한 resolver failure reason도 보존해 `unknown-receiver`로 뭉개지지 않게 했다. `infer`와 일반 subtype 계산은 여전히 미지원이다.
- 단일 generic container 형태인 `T extends Box<infer U> ? U : ...`는 `ConditionalTypeFact.infer`로 보존하고 `Box<Result>`에서 `Result`를 추출해 receiver dispatch에 사용한다. 여러 container/중첩 infer, union subtype 및 일반 conditional subtype solver는 여전히 미지원이다.
- TypeScript `if (x instanceof A) ... else ...`의 alternative span에 `A` exclusion fact를 저장해, `A | B` receiver가 else branch에서 유일한 `B` 구현으로 해석되도록 했다. direct resolver와 실제 persisted scan call-site 회귀를 추가했으며, negated/compound `instanceof`, full control-flow type solver는 아직 미지원이다.
- negated `instanceof`(`if (!(x instanceof A))`)도 조건 polarity를 뒤집어 consequence에는 A exclusion, alternative에는 A narrowing을 저장한다. direct resolver 회귀로 양쪽 호출이 각각 B/A 구현에 도달함을 확인했으며, compound negation과 일반적인 boolean constraint solver는 아직 미지원이다.
- `x instanceof A && ready`처럼 conjunction에 하나의 직접 `instanceof`가 포함된 경우 consequence에만 A narrowing을 적용한다. alternative에는 A가 거짓이라고 단정하지 않아 false narrowing을 피하며, disjunction과 compound negation은 계속 보수적으로 unresolved로 둔다.
- 같은 변수의 직접 검사만으로 구성된 `x instanceof A || x instanceof B`는 consequence를 `A | B`로 보존하고 alternative에서 A·B를 모두 제외한다. 다중 exclusion을 동시에 적용하는 resolver 회귀로 C 단일 구현을 확인했으며, 혼합 disjunction은 여전히 unresolved다.
- TypeScript `"property" in x` 검사도 union target별 실제 member binding을 조회해 positive/negative branch를 좁힌다. `A | B`에서 `run`/`stop`이 서로 다른 class member인 direct resolver와 persisted scan 회귀를 통과했으며, dynamic property·혼합 표현식은 unresolved로 유지한다.
- property-presence fact는 TypeScript parser 경로에만 활성화해 Python membership(`"run" in x`)을 union narrowing으로 오인하지 않는다. Python negative regression과 전체 flow 회귀를 통과했다.
- Python `A | B` annotation을 union SymbolValue로 보존하고 `isinstance(x, A)`의 consequence/else를 narrowing/exclusion fact로 연결했다. direct resolver와 실제 persisted scan에서 A/B method 호출을 각각 resolve하며, `isinstance` tuple/dynamic type은 unresolved로 유지한다.
- Python `not isinstance(x, A)`는 polarity를 반전하고 `isinstance(x, (A, B))`는 positive union narrowing 및 alternative 다중 exclusion으로 낮춘다. direct/persisted regression에서 negated A|B와 tuple A|B|C의 B/C 분기를 확인했으며, 동적 tuple 항목은 unresolved다.
- standard model pack에 Python `builtins.open` resource contract를 추가했다. `path` prefix 뒤 mode/options를 variadic으로 허용하고 `enter=same` 반환 resource를 선언해 sync/async context-manager flow의 proven acquire/release event를 direct regression으로 확인했다.
- packed CLI smoke의 stale partial fixture를 현재 CFG 의미에 맞게 갱신했다. 지원된 generator `yield` 대신 unsupported TypeScript `with`를 사용해 strict exit 2/partial 경계를 실제로 검사하며, full/missing parser·cache·BS/SARIF·CFG/flow/impact/query mutation smoke를 통과했다.

### 10차 후속 — Python 표준 sanitizer 모델

- AGT-4569: standard model pack에 Python 3.12 `html.escape`의 module/symbol 기반 taint sanitizer contract를 추가했다. 이름이나 문자열 패턴으로 sanitizer를 추론하지 않고, 정확한 external identity·runtime version·assumption이 모두 맞을 때만 적용한다.
- 모델 argument-domain 검증은 taint label을 runtime type과 분리한다. 따라서 tainted string/number가 명시된 sanitizer contract에 전달될 때 taint metadata 때문에 `argument-domain`으로 거절되지 않는다. 실제 값 타입 검증은 계속 수행한다.
- Python `read_input` source → `html.escape` → `execute` sink 회귀에서 sanitizer model `applied`와 sink finding 부재를 확인했다. 모델이 없거나 source/symbol이 다르면 기존 보수적 taint 경계가 유지된다.
- 검증: 전체 44 files / 841 tests, build, lint, diff check, packed package smoke 통과. 이는 한 표준 API 계약의 증거이며 Python sanitizer 전체나 CodeQL 수준 보안 커버리지를 의미하지 않는다.

### 10차 후속 — Python command sanitizer

- `shlex.quote`를 Python 3.12 exact external sanitizer model로 추가했다. `os.getenv` source가 `shlex.quote`를 통과하면 `os.system`, `subprocess` 계열 command sink에서 taint finding을 제거한다.
- 이름이나 문자열 패턴으로 sanitizer를 추론하지 않으며, shell 실행 방식, quoting 결과의 downstream 사용, command parser와 실제 OS 실행 semantics는 증명하지 않는다. Standard model pack은 47개 계약이다.
- 회귀는 source → `shlex.quote` → `os.system` 경로에서 sanitizer/sink model 적용과 finding 부재를 확인했다.
- `safe(value) -> shlex.quote(value)` wrapper summary가 `taintSanitizesParameters`를 formal parameter에 보존하고 caller sink에서 소비하는 회귀도 추가했다.

### 10차 후속 — 외부 모델 keyword argument 매핑

- model schema에 optional `parameterNames`를 추가하고, Python call AST의 `keyword_argument` 이름을 선언된 parameter index에 매핑한다. 고정 positional 모델은 기존 동작을 유지하고, unknown spread만 계속 `argument-mapping`으로 fail-closed한다.
- Python `subprocess.run(args=...)`에서 `os.getenv` taint가 sink에 도달하는 회귀를 추가했다. 모델 이름이 없거나 local shadowing이면 외부 contract를 적용하지 않는다.
- 현재 keyword mapping은 선언된 이름과 positional prefix만 사용하며, `**kwargs` 확장·overload별 keyword signature·runtime descriptor dispatch는 추론하지 않는다.

### 10차 후속 — 모델 기반 context-manager suppression

- AGT-4569: resource schema에 `suppress=never|possible|always`를 추가했다. Python `builtins.open`은 `suppress=never`를 선언하며, 실제 manager call이 argument/callee proof와 `resource-self` identity를 통과한 경우에만 `__exit__`/`__aexit__`의 true suppression edge를 제거한다.
- 모델 부재, invalid argument, callee 오염, `possible`/생략 계약은 suppression 양쪽 경로를 유지한다. 따라서 이름만 같은 context manager가 예외를 삼키는 것으로 승격되지 않는다.
- cleanup suppression CFG node에도 manager source span을 보존해 flow edge와 contract를 연결했다. `never` 회귀에서 exceptional body exit의 true edge가 도달 불가가 되고, 기존 generic manager의 보수 경계는 유지된다.
- 검증: 전체 44 files / 841 tests, build, lint, diff check, packed package smoke 통과. arbitrary `__exit__` return protocol과 실제 async scheduler ordering은 여전히 미지원이다.
- 경계 회귀로 `suppress=never`의 sync `with`와 async `async with` exceptional exit true edge 제거, suppress 생략 모델의 true edge 도달 가능성을 각각 확인했다. focused library-model suite는 22/22이다.

### 10차 후속 — Python `contextlib.suppress` 모델

- standard pack에 Python 3.12 `contextlib.suppress`를 `enter=unknown`, `suppress=possible` resource contract로 추가했다. 예외 타입 추적이 없는 현재 분석에서 `suppress(ValueError)`를 모든 exception에 적용하지 않도록 body exception 양쪽 경로를 유지한다.
- `enter=unknown`이어도 모델 acquire가 증명한 resource marker와 manager source span을 사용해 suppression 계약을 연결한다. 임의 context manager는 marker가 없어 기존 양쪽 경로를 유지한다.
- 회귀: `contextlib.suppress(ValueError)` 모델이 적용되지만 suppression condition의 body exception false edge와 cleanup exception 가능성을 모두 보수적으로 유지하는지 확인했다. 예외 타입 기반 `always` 승격은 후속 범위다.

### 10차 후속 — Python exact exception type flow

- `DataExpr`에 exact exception type/source와 exception-match condition을 추가하고, Python `raise ValueError`/`raise ValueError()` 및 `except ValueError`의 CFG condition을 dataflow `pending:exception`과 연결했다. `raise error`처럼 lowercase/dynamic expression은 unknown exception으로 남긴다.
- `contextlib.suppress(ValueError)`의 `suppress=possible` 계약은 정적으로 식별된 exact type이 일치할 때 suppression true path를, 불일치할 때 false path를 선택한다. unknown constructor, subclass hierarchy, cleanup exception은 보수적으로 유지한다.
- 회귀: thrown parameter provenance 보존, ValueError handler/TypeError mismatch, suppress exact match/mismatch를 검증했다. 전체 exception hierarchy와 async scheduler semantics는 아직 미지원이다.

### 10차 후속 — 모델이 증명한 async cleanup completeness

- `with_item` lifecycle 진단을 synthetic cleanup node에서 중복 발행하지 않도록 정리했다. `resource-enter` 모델이 동일 manager source span의 `enter=same` identity를 증명하면 sync/async enter·cleanup·exit 전체가 `complete`로 수렴한다.
- 모델 부재, `enter=unknown`, invalid argument, 또는 generic manager는 기존 `partial`과 lifecycle diagnostic을 유지한다. 따라서 completeness 승격은 선언된 resource contract 범위에만 적용된다.
- `contextlib.suppress(ValueError)`의 `async with`에서도 `raise ValueError`는 suppression node에서 제거되고 `raise TypeError`는 throw path에 남는 회귀를 추가했다. 이는 async scheduler ordering이나 임의 `__aexit__` protocol을 증명하지 않는다.
- Python built-in의 닫힌 parent map을 추가해 `ValueError`가 `Exception`/`BaseException` handler에 매칭되고 sibling `TypeError`에는 매칭되지 않도록 했다. 임의 사용자 class와 hierarchy 밖 이름은 exact-only/보수 경계로 남긴다.
- `SymbolFacts.bases`에서 같은 Python 파일의 class base 배열을 `DataflowFacts.exceptionParents`로 전달해 `class MyError(ValueError, OSError)`의 모든 parent 경로가 `except` 및 suppress hierarchy에 참여하도록 했다. 외부/unresolved base는 추측하지 않는다.
- 기본 pack은 이제 23개 계약이며, 전체 검증은 focused library-model 22/22 및 이전 전체 841 tests/build/lint/diff-check/packed smoke를 통과했다.

### 10차 후속 — Python exception tuple handlers

- `except (ValueError, TypeError)` 조건을 단일 클래스 이름으로 오인하지 않고 outer tuple의 각 정적 exception name을 독립 매칭한다. built-in/local parent hierarchy 결과와 결합하며, dynamic/nested tuple 표현은 기존 보수적 unknown 경계를 유지한다.
- `raise TypeError`의 tuple handler hit와 `raise OSError`의 miss 회귀를 추가했다. exception groups, `except*`, runtime tuple construction과 scheduler semantics는 여전히 미지원이다.

### 10차 후속 — Python cross-file exception hierarchy

- `scanRepository`가 Python symbol facts 전체에서 class base 관계를 수집해 dataflow에 전달한다. short class name이 프로젝트 안에서 하나의 선언에만 대응할 때만 `exceptionParents`를 병합한다.
- 여러 파일에 같은 class name이 있거나 base가 import/unresolved이면 관계를 승격하지 않고 exact-only 경계를 유지한다. 따라서 파일 간 편의 추론이 모호한 예외를 삼키는 방향으로 동작하지 않는다.
- `errors.py: MyError(ValueError)`와 `app.py: raise MyError / except Exception` 실제 repository scan 회귀를 추가했다. summary API에도 명시적 parent map 주입 경계를 검증한다.

### 10차 후속 — Python input/eval taint 경계

- standard pack에 Python 3.12 `builtins.input` taint source와 `builtins.eval` taint sink를 추가했다. 정확한 external identity·version·assumption이 맞을 때만 적용하며, `eval`의 unknown effect는 제거하지 않는다.
- `input('expression') → eval(...)` 회귀에서 두 모델이 applied이고 sink finding의 source definition이 input call을 가리키는지 확인했다. 모델이 없는 동명 local function은 기존 unresolved/unknown 경계를 유지한다.
- 기본 pack은 25개 계약으로 늘었다. 검증: focused library-model 23/23, 전체 tests/build/lint/diff-check 및 packed smoke 통과 후 Linear AGT-4569에 기록한다.

### 10차 후속 — Python `exec` dynamic-code sink

- standard pack에 Python 3.12 `builtins.exec` dynamic-code taint sink contract를 추가했다. `input() → exec(...)`에서 source definition과 sink finding을 보존하며 unknown effect는 유지한다.
- unqualified `exec`는 external binding일 때만 model로 승격하고 local `exec` shadowing은 lexical target으로 남긴다. 실행 namespace와 import side effect는 추론하지 않는다.
- 기본 pack은 39개 계약이며 input-to-exec 및 shadowing 회귀를 추가했다.

### 10차 후속 — effectful call 뒤 external callable identity 보존

- `unmodified-external-bindings` 가정으로 proven된 external callable variable은 effectful/unknown call의 보수적 havoc에서도 callable identity를 유지하도록 수정했다. 같은 imported API의 두 번째 호출이 `callee-not-proven`으로 잘못 하락하지 않는다.
- external data/heap effect와 captured/local state의 보수적 havoc는 유지한다. 이는 unknown call의 side effect를 제거하거나 runtime mutation을 증명하는 변경이 아니다.
- 같은 `node:fs.readFileSync` imported callable을 한 함수에서 두 번 호출하는 회귀를 추가했고 두 call 모두 model `applied`를 확인했다.

### 10차 후속 — Python `compile` taint propagator

- standard pack에 Python 3.12 `builtins.compile` propagator contract를 추가했다. 첫 source 인자의 taint를 반환값으로 보존해 `input → compile → exec` chain의 중간 opaque call을 명시한다.
- compile은 `effects=none`으로 모델링하지만 generated code, namespace, import side effect는 추론하지 않는다. local `compile` shadowing과 model version/assumption 경계는 기존 external contract와 같다.
- source-to-compile-to-exec regression에서 compile model과 exec sink model, 중간 provenance를 확인했다. 기본 pack은 40개 계약이다.

### 10차 후속 — Python environment-to-subprocess taint

- standard pack에 Python 3.12 `os.getenv` environment source와 `subprocess.run` command sink를 추가했다. 두 모델은 정확한 external identity/version/assumption이 필요하고, subprocess의 unknown effect는 유지한다.
- `os.getenv('COMMAND') → subprocess.run(...)` 회귀에서 두 모델 applied와 source definition provenance를 확인했다. shell mode, list-vs-string 실행 semantics, sanitizer는 자동 추론하지 않는다.
- 기본 pack은 27개 계약이다. focused library-model 24/24, 전체 tests/build/lint/diff-check 및 packed smoke 통과 결과를 Linear AGT-4569에 기록한다.

### 10차 후속 — Python command sink family

- standard pack에 `subprocess.Popen`, `os.system`, `os.popen` command taint sink 계약을 추가했다. 각 계약은 exact external identity와 Python 3.12 version boundary를 요구하고 첫 command 인자만 sink으로 표시한다.
- process lifecycle, shell/list semantics, stream/return object 동작은 unknown effect로 유지한다. source model이 없는 동명 local function은 자동 sink으로 승격하지 않는다.
- `os.getenv('COMMAND')`에서 세 API로 전달되는 source-to-sink provenance와 model reference를 회귀 검증했다. 기본 pack은 38개 계약이다.

### 10차 후속 — Node child-process command sink

- standard pack에 Node 22–26 `node:child_process.exec` command taint sink를 추가했다. exact external identity와 runtime version이 필요하고, shell options·callback scheduling·command parsing은 unknown effect로 유지한다.
- custom source model과 함께 `readInput() → exec(...)` 회귀에서 sink model applied 및 source definition provenance를 확인했다. local 동명 `exec`나 다른 module은 자동 sink로 추론하지 않는다.
- 기본 pack은 28개 계약이다. focused library-model 25/25, 전체 tests/build/lint/diff-check 및 packed smoke 통과 결과를 Linear AGT-4569에 기록한다.

### 10차 후속 — Node child-process sink family

- `node:child_process`의 `execFile`, `execSync`, `spawn`, `spawnSync`를 기존 `exec`와 같은 exact external identity·Node 22–26 version boundary의 command taint sink으로 추가했다. 각 계약은 첫 command/path 인자만 sink으로 표시한다.
- shell option, argument-array semantics, callback scheduling, child-process lifecycle은 추론하지 않고 unknown effect로 유지한다. 따라서 모델 추가가 실행 성공이나 shell escaping을 증명하지 않는다.
- 하나의 custom source에서 네 API로 전달되는 source-to-sink finding과 각 model reference를 회귀 검증했다. 기본 pack은 34개 계약이며 focused library-model suite는 32/32이다.

### 10차 후속 — Node file-content taint source

- standard pack에 Node 22–26 `node:fs.readFileSync` opaque taint source를 추가했다. 반환값은 Buffer/string encoding을 구분하지 않는 unknown abstract value이며, file existence/permission/I/O semantics는 추론하지 않는다.
- 실제 `readFileSync('config.json', 'utf8')` call에서 source model applied와 반환 taint atom을 회귀 검증했다. encoding을 보고 string으로 단정하거나 파일 내용을 계산하지 않는다.
- 기본 pack은 29개 계약이다. focused library-model 26/26, 전체 tests/build/lint/diff-check 및 packed smoke 통과 결과를 Linear AGT-4569에 기록한다.

### 10차 후속 — TypeScript global eval sink

- standard pack에 Node/TypeScript 전역 `eval`의 `global.eval` taint sink contract를 추가했다. `node:fs.readFileSync` source와 조합할 때 명시적 source-to-sink finding을 보존한다.
- 무수입 `eval`은 external binding일 때만 승격하며 local `eval` 선언은 계속 lexical target으로 남긴다. 모델 적용은 Node 22–26 version boundary와 `unmodified-external-bindings` 가정을 따른다.
- 기본 pack은 30개 계약이며, unqualified global eval 및 shadowing 회귀를 포함해 전체 44 files / 856 tests, build, lint, package smoke, real-world benchmarks를 통과했다.

### 10차 후속 — Node `process.env` member source

- 호출이 아닌 member expression인 Node `process.env`를 intrinsic taint source로 연결했다. `process.env.CODE`처럼 후속 property를 읽어도 명시적 taint atom과 source definition이 보존되어 global `eval` sink까지 도달한다.
- `process`가 unresolved external binding일 때만 적용하며, local/parameter shadowing과 computed/unknown property는 source로 승격하지 않는다. Node 환경값의 실제 key 존재 여부, 문자열 변환, process mutation은 추론하지 않는다.
- 회귀: `process.env.CODE → eval` finding과 `function f(process){...}` shadowing 부재를 확인했다. focused library-model suite는 31/31이다.

### 10차 후속 — Python `os.environ` member source

- Python external `os.environ` member read를 intrinsic environment taint source로 추가했다. `os.environ['CODE']`와 후속 member read가 `tainted:python-os-environ` 및 source definition을 유지해 modeled `eval` sink까지 도달한다.
- `os`가 external binding일 때만 적용하므로 local/parameter shadowing은 승격하지 않는다. key 존재 여부, string conversion, environment mutation과 process scheduling은 추론하지 않는다.
- 회귀: `import os; eval(os.environ['CODE'])` source-to-sink finding과 `f(os)` shadowing 부재를 확인했다.

### 10차 후속 — TypeScript global `Function` code sink

- standard pack에 Node/TypeScript 전역 `Function` constructor의 taint sink contract를 추가하고, unqualified external `Function(...)` 호출을 `global.Function`으로 연결했다. `readFileSync` source에서 동적 code sink까지 source definition을 보존한다.
- local `Function` 선언은 lexical target으로 남기며 자동 sink로 승격하지 않는다. `new Function(...)`은 constructor가 정확히 global `Function`일 때만 동일 call model로 낮추고, 다른 constructor의 allocation semantics는 변경하지 않는다.
- 회귀: global/`new` Function source-to-sink finding과 local shadowing 부재를 확인했다. 기본 pack은 35개 계약이다.

### 10차 후속 — Node timer string-code sink

- 기존 `node:timers.setTimeout`/`setInterval` callback model에 첫 인자 taint sink contract를 결합했다. tainted string overload는 `cxt/taint-sink` finding으로 기록하고, 함수 callback은 기존 callback registration fact만 생성한다.
- timer ordering, cancellation, callback exception envelope는 추론하지 않으며 `setImmediate`/`nextTick`에는 이 sink을 적용하지 않는다.
- `process.env.CODE`를 각각 두 timer API에 전달하는 회귀를 추가했다. 표준 pack contract 수는 유지되며 focused callback/model 회귀가 통과한다.

### 10차 후속 — Node `vm` dynamic-code sink family

- `node:vm`의 `runInThisContext`, `runInNewContext`, `runInContext`, `compileFunction`을 Node 22–26 exact external dynamic-code sink model로 추가했다. 첫 code 인자의 taint와 source provenance를 기록한다.
- VM context/timeout/generated-function semantics와 실행 순서는 unknown effect로 유지하며, local same-name function은 model로 승격하지 않는다.
- `process.env.CODE`를 네 API에 전달하는 model/reference/source-to-sink 회귀를 추가했다. 기본 pack은 44개 계약이다.

### 10차 후속 — Node `fs.readFile` callback taint

- callback contract에 `taintArguments`를 추가해 외부 API가 callback positional argument로 공급하는 opaque 데이터를 명시할 수 있게 했다. wrapper summary도 이 callback source 위치를 보존하며, callback sink summary까지 정적 source-to-sink finding을 연결한다.
- callback 위치를 고정 index 또는 `last`로 표현할 수 있게 해 optional `options` overload에서도 callback target을 보존한다. Node 22–26 `node:fs.readFile(path, callback)` 모델은 callback의 두 번째 인자(data)를 `tainted:fs.readFile.callback-taint`와 외부 callback provenance로 표시한다. callback target은 기존 `registers`/callback resolution 경계를 따른다.
- Node 22–26 `node:fs/promises.readFile`도 opaque file-content taint source로 추가했다. Promise/Buffer/string 구체 타입과 실제 I/O 결과는 추론하지 않는다. Standard model pack은 46개 계약이다.
- options overload, Buffer/string encoding, file I/O 결과와 실제 callback scheduler/exception envelope는 보수적으로 unknown으로 유지한다. 전체 options overload를 지원한다고 해석하지 않는다.

### 10차 후속 — frozen real-world call-site benchmark

- `bench/corpus/real-world-call-labels.json`과 `bench/real-world-call-accuracy.ts`를 추가해 기존 upstream provenance 파일의 Python `fnmatch`, Rust `fnv`, TypeScript `zod-util`에서 사전 선택한 contiguous scope 3개를 call-site 평가 대상으로 고정했다.
- 각 scope의 call을 수기로 라벨하고, scope 밖의 실제 call은 partial label 때문에 점수에 섞이지 않도록 명시적인 scope policy로 제외한다. 현재 6개 call site( resolved 3, unresolved 1, external 2)를 모두 match하며 precision/recall/site/resolution 1.0이다.
- 이 benchmark는 real-world source slice의 회귀 및 라벨 무결성을 제공하지만, 표본이 작고 독립 second-reviewer sign-off가 없어 CodeQL 수준의 일반화나 독립 정확도 증거로 해석하지 않는다. 실행은 `npm run bench:calls:real-world`다.

### 10차 후속 — frozen real-world flow/rule benchmark

- `bench/real-world-flow-accuracy.ts`와 `bench/corpus/real-world-flow-labels.json`을 추가해 CPython `fnmatch`/`fnmatchcase`, rust-fnv `Hasher::finish`, Zod `assertEqual`/`assertNotEqual`/`nullish`의 upstream 함수 6개를 dataflow 정답으로 고정했다. parameter return, read definition, abstract atoms, completeness를 source 기반 수기 라벨로 검사하며 provenance SHA-256과 exact owner를 실행 전에 확인한다.
- `bench/real-world-rule-accuracy.ts`와 `bench/corpus/real-world-rule-labels.json`을 추가해 Zod `any-type`, CPython `magic-number`, rust-fnv `rust-incomplete`의 rule scope 3개를 검사한다. 각 scope 밖 finding은 제외하고 span까지 검증한다.
- `npm run bench:calls:real-world`, `npm run bench:flow:real-world`, `npm run bench:rules:real-world`가 모두 통과한다. 이는 real-world source 회귀 계층을 call/flow/rule까지 확장한 것이며, 총 12 fixture의 작은 표본과 pending independent second-reviewer 때문에 CodeQL 수준 일반화나 독립 정확도 증거는 아니다.
- flow real-world tier에 CPython `fnmatch` wrapper 및 Zod `assertNotEqual`/`nullish` scope를 추가해 Python 2개, TypeScript 3개를 포함한 총 6개 fixture로 확장했다. 모든 fixture가 relation/read-status/completeness/value gate를 통과하지만, source slice가 작고 independent second-reviewer가 없어 일반화 증거로 승격하지 않는다.

### 10차 후속 — keyword callback contract 매핑

- 외부 model의 `parameterNames`를 callback registration에도 적용해 Python keyword 순서가 바뀐 호출에서 callback target과 callback invocation의 formal argument provenance가 canonical parameter로 복원된다.
- direct dataflow의 callback target/taint 입력과 wrapper summary의 `callbackParameters`/`callbackInvocations`가 같은 매핑을 사용한다. 이름 없는 `**kwargs` expansion과 내부 user-function keyword 호출은 기존 fail-closed/partial 경계를 유지한다.
- Python `register(cb=cb, data=data)` 회귀에서 model `applied`, callback formal `1`, argument formal `0`을 확인했다. callback scheduler의 실제 재호출 순서와 exception envelope는 여전히 모델링하지 않는다.

### 10차 후속 — callback contract schema fail-closed

- model schema가 numeric callback parameter를 선언된 model arity 밖으로 내보내거나 callback argument index를 중복 선언하지 못하도록 검증을 강화했다.
- 잘못된 contract는 callback target/taint provenance를 조용히 버리지 않고 pack 로드 단계에서 거부한다. `last` callback 위치와 scheduler 실행 semantics는 그대로 유지한다.
- out-of-range callback parameter 및 duplicate callback argument regression을 추가했다.

### 10차 후속 — symbolic member mutation for parameter receivers

- concrete allocation ID가 없는 parameter/unknown receiver도 reaching definition을 symbolic heap key로 사용해 `obj.payload = value; return obj.payload`의 동일 receiver read/write를 연결한다.
- 서로 다른 definition은 별도 field cell로 분리하고 computed property와 dynamic receiver는 계속 unknown/partial 경계를 유지한다. unknown call havoc와 기존 allocated-object strong update는 보존한다.
- TypeScript parameter member literal regression 및 modeled `readInput() → obj.payload → execute()` taint regression을 추가했다. 이는 arbitrary alias/type inference를 증명하지 않는다.

### 10차 후속 — held-out independent gate status transition

- held-out loader가 `pending` 상태를 항상 요구하던 조건을 수정해, 일반 개발 tier는 pending을 유지하고 `--require-independent-review` tier는 `approved` 상태를 소비하도록 분리했다.
- 이전 구현은 second-reviewer provenance를 추가해도 pending 검사에서 먼저 실패해 independent gate를 영구적으로 통과할 수 없었다. 현재 pending fixture는 일반 held-out 실행은 통과하고 independent 실행은 fail-closed한다.
- status transition helper regression에서 approved/required는 허용되고 pending/required 및 approved/development는 거부되는지 확인했다. 실제 second-reviewer 서명은 아직 존재하지 않는다.

### 10차 후속 — Node EventEmitter framework callback registration

- external instance receiver를 `external-instance` target으로 보존해 `new EventEmitter(); emitter.on(...)` 같은 member call을 `node:events.EventEmitter.on` identity로 해석한다.
- standard model pack에 `on`, `addListener`, `once`, `prependListener`, `prependOnceListener` callback registration contract를 추가했다. 정적으로 증명된 local callback target은 `FlowCall.callbacks`에 남고, 첫 registration의 effectful havoc 뒤에도 captured callback identity를 유지한다.
- 실제 scheduler ordering, event payload type narrowing, callback exception envelope는 추론하지 않는다. callback registration provenance와 listener removal 범위의 regression을 추가했다.

### 10차 후속 — TypeScript JSON serialization taint propagation

- external global binding으로 증명된 `JSON.parse`/`JSON.stringify`를 taint propagator model로 추가해 file/content source가 serialization 경계를 지나 dynamic-code sink까지 도달하도록 했다.
- local `JSON` shadowing은 global model로 승격하지 않으며, JSON object shape/parse 결과 타입과 runtime syntax exception은 추론하지 않는다.
- `readFileSync → JSON.parse/stringify → eval` 및 local shadowing regression을 추가했다.

### 10차 후속 — EventEmitter emit contract groundwork

- model schema에 callback registration의 `eventParameter`와 dispatcher의 `emits` contract를 추가하고 Node `EventEmitter.emit` standard model을 선언했다.
- registration callback identity는 abstract state cell에 보존하고, receiver/event가 증명되지 않으면 payload delivery를 연결하지 않는다. 같은 함수의 proven receiver/event에서 `readFileSync → emit → handler → eval` taint finding을 회귀로 확인했다.
- allocation 자체가 외부 local havoc로 imported source callable을 지우지 않도록 분리했다. 같은 함수에서 proven receiver/event에 대해 `off`/`removeListener`의 callback 단위 제거와 `removeAllListeners`의 event 단위 제거를 적용한다. cross-function scheduler dispatch, payload type narrowing, callback exception envelope는 여전히 지원하지 않는다.
- dynamic event name과 `register()`/`dispatch()` 함수 경계를 연결하지 않는 negative regression을 추가해 intraprocedural 및 literal-event 경계를 고정했다.

### 10차 후속 — modeled source taint return preservation

- 적용된 library model의 `taint.source` 계약을 직접 return value에도 generic `tainted` atom으로 보존한다. 외부 summary가 unknown return atoms를 제공해도 source 계약 자체가 사라지지 않는다.
- `node:fs.readFileSync` direct return regression을 추가했다. 구체적인 Buffer/string 타입과 source-specific label은 추론하지 않으며 기존 sink finding의 generic taint 표현을 유지한다.
- modeled sink contract가 wrapper formal로 매핑되면 `FunctionSummary.taintSinkParameters`에 승격하는 regression도 추가했다. 실제 callback scheduler 재호출 semantics와는 분리된 formal contract 보존이다.

### 10차 후속 — persisted fact freshness check

- read-only fact query가 snapshot의 마지막 entity update 시각과 indexed file mtime을 비교해 `current`/`stale`/`not-verified`를 구분한다. 변경되었거나 사라진 indexed file은 stale로 fail-closed한다.
- 이는 source hash 기반의 완전한 freshness 증명이 아니라 보수적 mtime guard이며, 무시 디렉터리·20,000개 초과 tree·clock skew는 여전히 `not-verified` 한계로 남긴다.
- frontend analysis cache가 저장한 `engine + parser mode + language + content` 입력 hash를 query 시 재계산해 현재 source content와 비교한다. cache metadata가 없거나 현재 engine/parser 조건으로 재현할 수 없는 파일은 `not-verified`로 남기며, mtime만으로 `current`를 주장하지 않는다.
- indexed source 중 하나라도 frontend hash가 없으면 일부 파일만 검증해 `current`로 올리지 않고 `not-verified`로 fail-closed한다. 이는 cache가 없는 legacy snapshot의 의미적 freshness를 과장하지 않기 위한 경계다.
- persisted hash가 scan 시점의 `auto`/`ast`/`lexical` parser mode 중 어느 것으로 생성됐는지 query가 알 수 없는 경우에도 세 mode의 입력 hash를 비교한다. 동일 content면 parser mode 설정 차이로 `not-verified`가 되지 않고, 모든 mode에서 불일치할 때만 `stale`이다.

### 10차 후속 — Node EventEmitter once listener lifecycle

- callback contract에 `once` 수명을 추가하고 `once`/`prependOnceListener` 등록을 별도 abstract callback atom으로 보존한다. proven receiver/event의 첫 `emit` 뒤 one-shot callback을 상태에서 제거해 후속 dispatch가 callback sink로 재전달되지 않는다.
- 일반 listener와 one-shot listener가 같은 event에 공존할 때 일반 listener만 남기는 상태 갱신과 두 번의 dispatch 회귀를 추가했다. 실제 scheduler ordering, listener identity aliasing, cross-function dispatch는 여전히 추론하지 않는다.

### 10차 후속 — external URL request sink models

- Node global `fetch`와 Python `urllib.request.urlopen`을 exact external identity 기반 taint sink model로 추가했다. `process.env`/`os.getenv`에서 유래한 URL이 request sink까지 도달하는 source-to-sink finding을 보존한다.
- local shadowing, URL parsing, redirect/ DNS/ network runtime semantics는 추론하지 않으며, model version과 external-binding assumption이 맞을 때만 적용한다.
- Node 표준 `node:http`/`node:https`의 `get`/`request`도 첫 URL 인자에 한정한 sink contract로 추가했다. options object 내부 URL, redirect, DNS rebinding은 분석하지 않는다.
- allocation abstract value가 literal object field의 taint atoms와 source definitions를 보존하도록 수정해 `http.request({ hostname: process.env.HOST })` 같은 options object도 sink까지 연결한다. 동적 property/alias merge와 실제 URL parser semantics는 여전히 추론하지 않는다.
- Python `urllib.request.Request`를 URL taint propagator로 추가해 `Request(os.getenv('URL')) → urlopen(request)` 객체 경계를 연결한다. Request header/method/redirect semantics와 arbitrary wrapper object는 분석하지 않는다.
- TypeScript `new URL(value)`를 같은 propagator contract로 lowering해 `new URL(process.env.URL) → fetch(...)` 경계를 보존한다. `URL`의 base resolution, normalization, protocol validation과 다른 constructor semantics는 분석하지 않는다.

### 10차 후속 — variadic taint propagation contracts

- library model taint schema에 `propagatesVariadic`를 추가해 선언된 arity 뒤의 모든 positional argument taint를 반환값에 보존한다. 비-variadic model에서 이 플래그를 쓰는 pack은 validation 단계에서 거부한다.
- Node `path.join`/`path.resolve` 및 Python `os.path.join`과 기존 path 변환 함수에 명시적 propagation을 적용해 `join('safe', process.env.CODE) → eval(...)` 또는 subprocess sink 같은 추가 인자 경계를 연결한다. path normalization과 filesystem semantics는 실행하지 않는다.
- `**kwargs`, spread alias와 dynamic argument expansion은 여전히 보수적 unresolved/partial 경계다.

### 10차 후속 — typed external receiver model application

- resolver가 `node:events.EventEmitter.on`처럼 typed external receiver의 module identity를 증명한 경우, local value lattice에 `function:<target>` atom이 없어도 external member model을 적용한다.
- 이 완화는 member receiver와 resolver가 제공한 external identity에만 한정하며, imported callable이 unknown effect 뒤 오염된 경우와 local shadowing은 기존 `callee-not-proven` 경계를 유지한다.
- typed receiver model application 및 unknown-call 후 imported callable 보수성 회귀를 추가했다.

### 10차 후속 — optional library overloads and removeAllListeners()

- library model schema에 trailing `optionalParameters`를 추가해 선언된 overload만 인자 생략을 허용한다. 누락된 optional argument는 domain 검증과 exceptional provenance에서 unknown으로 처리한다.
- Node `EventEmitter.removeAllListeners()`의 event 이름 생략을 모델링해 proven receiver의 모든 callback-event state를 삭제한다. event 이름을 제공한 기존 동작은 유지한다.
- 임의의 누락 인자나 variadic 호출을 자동 허용하지 않으며, callback identity aliasing과 cross-function scheduler semantics는 여전히 미지원이다.

### 10차 후속 — CI template availability recheck

- 현재 caller `.github/workflows/ci.yml`은 `unohee/ci-templates/.github/workflows/node-ci.yml@main`을 참조하지만, 2026-09-28 원격 workflow 목록에는 `constitution-gate.yml`, `python-ci.yml`, `self.yml`만 존재한다.
- 존재하지 않는 reusable workflow를 로컬 복제해 성공처럼 보이게 만들지 않는다. Node CI template publish와 remote required-check 검증이 완료되기 전에는 CI DoD를 완료로 판정하지 않는다.

### 10차 후속 — Python comprehension taint preservation

- list/set/dict comprehension은 nested `for` clause와 각 clause 뒤의 순차 `if` filter들의 false back-edge까지 complete local flow로 제공한다. generator expression은 lazy evaluation/resume semantics가 없어 partial로 남긴다.
- zero/many iteration, nested binding, ordered filter edge와 nested iterable parameter provenance를 회귀로 검증했지만, generator resume/scheduler semantics와 clause 사이 filter ordering은 여전히 주장하지 않는다.
- Python `os.environ['CODE']`가 comprehension 결과까지 도달하는 회귀를 추가했다. exception group, async iteration과 macro semantics는 별도 범위다.
- simple, nested, multi-filter comprehension complete 회귀를 추가하고, 이후 전체 테스트에서 CFG/dataflow completeness 계약을 확인한다.
- async Python comprehension의 `async for` iterator advancement도 `suspend`/`resume` 및 exception edge로 낮추고 parameter provenance 회귀를 추가했다. 실제 async iterator protocol과 scheduler의 재개 순서까지 증명하는 것은 아니다.
- nested clause 사이 filter를 해당 clause의 loop header에 연결해 `[x+y for x in xs if x for y in ys if y]`의 평가 순서와 두 filter의 back-edge를 complete로 검증했다.
- generator expression은 생성 시 outermost iterable만 평가하도록 CFG eager effects를 제한하고, element/filter body를 lazy operation으로 표시했다. deferred iteration/resume 자체는 partial로 유지하며 호출·throw가 생성 시점에 잘못 발생하는 오탐을 막는다.
- Python handler 안의 bare `raise`를 새 unknown exception으로 만들지 않고 `pending:exception`을 재전파하도록 낮췄다. 중첩 try/except의 원래 `ValueError`가 바깥 handler에 도달하는 complete 회귀를 추가했으며, handler 밖의 invalid bare raise와 runtime envelope는 보수적 unknown 범위로 남긴다.
- Python `match`의 dict/list capture pattern을 subject의 member value로 lowering해 capture variable의 definition과 parameter provenance를 보존했다. literal/class/guard pattern constraint와 OR-pattern의 full narrowing은 아직 별도 타입·패턴 의미 모델 범위다.
- OR-pattern은 모든 alternative에 공통인 capture만 첫 alternative의 member provenance로 보수적으로 binding한다. alternative별 capture 불일치로 존재하지 않는 변수를 만들지 않으며, full type narrowing은 여전히 지원하지 않는다.
- class pattern의 positional/keyword capture도 subject member provenance로 낮췄다. 실제 `__match_args__`, class type existence, guard narrowing은 추론하지 않으며 symbolic member dependence만 제공한다.
- Python match wildcard `_`는 capture definition으로 만들지 않도록 보정하고 회귀를 추가했다.
- Rust `match`의 tuple-struct/struct field capture를 subject member provenance로 lowering해 binding definition을 보존했다. enum variant/type narrowing과 move semantics는 기존 ownership/type boundary로 남겼다.
- Rust `let_condition`을 dataflow effect로 낮춰 `if let`/`while let`의 tuple-struct capture binding과 subject value dependence를 보존했다. pattern/type narrowing 자체는 여전히 추론하지 않는다.
- Rust by-value `match` capture가 직접 identifier scrutinee를 소비하도록 연결해 capture 뒤 scrutinee use-after-move를 ownership finding으로 보존했다. `ref`/`&` pattern, enum type narrowing과 borrow checker 전체 semantics는 미지원이다.
- `ref_pattern`/`reference_pattern` binding은 `borrowedPattern` effect로 기록해 scrutinee를 moved state로 만들지 않도록 했다. borrow lifetime, mutable alias exclusivity와 full borrow checker semantics는 여전히 미지원이다.
- TypeScript/JavaScript `rest_pattern` destructuring은 residual shape를 unknown으로 보수화하면서 source parameter/taint provenance를 유지한다. computed rest keys와 exact residual property set은 추론하지 않는다.

### 10차 후속 — Rust bounded generic `Copy` proof

- `#[derive(Copy)]`가 붙은 generic `struct`/`enum`/`union`은 모든 type parameter에 명시적 `Copy` trait bound가 있을 때만 project `copyTypes`로 승격한다. 일부 parameter만 bound된 선언과 `where` clause 추론은 보수적으로 non-Copy로 남긴다.
- `Wrapper<T: Copy>`의 by-value 재사용은 move finding 없이 통과하고, `Pair<T, U: Copy>`는 unconstrained `T` 때문에 use-after-move를 유지하는 회귀를 추가했다. 이는 Rust trait solver나 specialization별 실제 bound 증명을 대체하지 않는다.
- `where T: Copy` 형식의 Rust `where_clause`도 inline bound와 동일하게 수집한다. 모든 generic parameter가 inline 또는 where clause에서 Copy로 제한된 경우만 승격하며, 누락된 bound는 계속 non-Copy로 처리한다.
- 검증: dataflow/external tests 62/62, `npm run lint`, `npm run build` 통과.

### 10차 후속 — TypeScript multi-infer conditional aliases

- conditional type fact에 같은 generic container의 direct `infer` 인자를 여러 개 저장한다. `Pair<infer A, infer B>`를 concrete `Pair<First, Second>`에 적용하면 선택된 branch의 `A`/`B`를 각각 해당 type argument로 치환한다.
- union arm들의 branch 또는 inferred mapping이 다르면 기존처럼 `ambiguous-binding`으로 fail-closed한다. nested infer, mapped/conditional subtype solver와 runtime type erasure는 지원 범위 밖이다.
- `PickFirst<Pair<First, Second>>` receiver dispatch 회귀를 추가했다. resolver 테스트 85/85, `npm run lint`, `npm run build` 통과.
- nested direct path도 구조적으로 매칭해 `Pair<infer A, Box<infer B>>`에서 `B`를 `Box`의 concrete argument로 치환한다. 중첩 pattern의 container/arity가 맞지 않으면 inferred mapping을 만들지 않고 unresolved 경계를 유지한다.
- nested infer 회귀 후 resolver 테스트는 86/86이다. 일반 mapped type, distributive conditional과 subtype solver는 여전히 미지원이다.

### 10차 후속 — CodeQL toolchain comparison smoke

- 로컬 CodeQL CLI 2.26.4와 javascript/python/rust extractor가 설치되어 있음을 확인하고, 동일한 최소 함수 fixture로 세 언어의 `database create --build-mode=none`을 생성했다. 언어별 qlpack을 분리한 CodeQL `Function` query가 JavaScript/Python/Rust 각각 `f` 한 건을 반환했고 cxt AST extraction도 동일한 `f` 선언 한 건을 반환했다.
- 이 실행은 CodeQL extractor/query toolchain과 비교 가능한 환경이 있음을 확인하는 smoke evidence다. 전체 dataflow/rule 결과 동등성, query-pack 정책 차이, 실제 프로젝트 정확도는 아직 비교하지 않았으며 CodeQL 수준 달성 주장으로 사용하지 않는다.

### 10차 후속 — Python exception-group handler splitting

- tree-sitter-python의 `except*`가 일반 `except_clause`로 표현되는 점을 반영해 literal `*` child를 구분자로 사용한다.
- 각 `except*` arm은 매칭 subgroup의 정상 경로를 보존하고, 불일치 remainder를 다음 arm으로 전달한다. 모든 arm을 통과한 remainder만 exception exit으로 전파되어 일반 first-match `except`와 구분된다.
- dataflow effect lowering도 `exception group matches ...`를 `exception-match`로 연결하고 `except T as name`의 `as_pattern`에서 matcher 대상과 binding alias를 분리한다. 따라서 typed exception provenance와 기존 alias cleanup을 함께 보존한다.
- `raise ExceptionGroup(..., [ValueError(), TypeError()])`처럼 정적으로 보이는 literal member constructor는 `exception-group:ValueError|TypeError` provenance로 보존하고 `except*` match outcome 계산에 사용한다. known member 중 일부만 매칭되면 matched/unmatched 양쪽 경로를 유지하고, 동적 member list·nested group·runtime subgroup 재구성은 unknown으로 남긴다.
- `except*`의 실제 ExceptionGroup 계층 분해, subgroup 재구성 순서, handler 내부의 runtime exception envelope는 이 local CFG 모델의 범위 밖이다. 따라서 scheduler/runtime semantics를 완전하게 증명한다고 해석하지 않는다.
- 회귀와 전체 검증: `npm test` 45 files / 904 tests, `npm run lint`, `npm run build`, `git diff --check` 통과.

### 10차 후속 — nested Python ExceptionGroup provenance

- `raise ExceptionGroup(..., [ExceptionGroup(..., [ValueError()]), TypeError()])`처럼 정적으로 구성된 nested group을 재귀적으로 펼쳐 `exception-group:ValueError|TypeError` provenance로 보존한다. 중복 type은 제거하고, 동적 member list와 runtime subgroup 재구성은 계속 unknown으로 남긴다.
- `except*` handler가 nested group의 inner type과 outer sibling type을 함께 검사하는 dataflow 회귀를 추가했다. 이는 Python runtime의 실제 subgroup 객체 재구성이나 exception hierarchy 전체를 증명하는 것이 아니다.
- 검증: `tests/analysis/dataflow.test.ts` 및 `tests/analysis/controlFlow.test.ts` 90/90, `npm run lint`, `npm run build` 통과.

### 10차 후속 — taint aggregate fail-closed semantics

- scan aggregate의 `taintFindings.total`은 partial flow의 finding도 보존하지만, `proven`은 dataflow `completeness=complete`인 flow에서만 증가하도록 수정했다.
- partial flow의 sink 도달은 가능성 evidence로 노출하고 proven finding으로 승격하지 않는다. partial scan은 기존 exit code 2를 유지하며, complete flow의 explicit sink는 기존 `findingsFail` 동작을 유지한다.
- complete/partial flow의 total/proven 분리 회귀를 CLI JSON output에 추가했다.

### 10차 후속 — partial taint SARIF certainty

- `toDataflowSarif`가 partial flow의 taint sink를 `warning`/`possible`로 내보내고 `analysisStatus=partial`을 properties에 기록한다. complete flow만 `error`/`proven` 및 `findingsFail=true`가 된다.
- partial taint도 SARIF result와 static code flow provenance는 보존하지만, 자동화가 incomplete 분석을 확정 취약점으로 승격하지 않도록 exit 2와 `findingsFail=false`를 유지한다.
- complete/partial SARIF schema 및 level/certainty 회귀를 추가했다.

### 10차 후속 — partial resource/ownership certainty

- partial dataflow의 resource/ownership finding은 aggregate `definite`에서 제외하고 `possible`로 집계한다. `total`은 finding 수를 보존한다.
- SARIF도 partial flow의 use-after-release/use-after-move를 warning/possible 및 `analysisStatus=partial`로 출력하며, complete flow에서만 error/proven과 findingsFail을 허용한다.
- partial resource/ownership SARIF와 complete/partial aggregate 회귀를 추가했다.

### 10차 후속 — CLI certainty wording

- scan text output도 taint `total/proven/possible`을 분리해 표시한다. partial finding을 더 이상 전체 proven sink reach로 표현하지 않는다.
- complete/partial JSON·SARIF와 동일한 수치를 CLI human output에서 확인하는 회귀를 추가했다.

### 10차 후속 — aggregate benchmark ratchet

- `bench/all.ts`와 `npm run bench:all`이 entity/call/CFG/dataflow/impact/rule/external/self 및 frozen real-world gate에 packed package smoke와 실제 self-scan을 더해 순차 실행한다. 개별 프로세스의 spawn 오류와 non-zero exit를 값으로 보존하고, 하나라도 실패하면 aggregate도 exit 1이다.
- `--output` JSON에는 각 gate의 exit code, duration, stdout/stderr tail과 원 보고서를 함께 기록해 어느 단계에서 ratchet이 깨졌는지 재현할 수 있다. 증분 성능은 repo와 표본 인자가 필요하므로 별도 `bench:incremental`로 유지한다.
- `--require-independent-review`는 held-out dataflow의 second-reviewer provenance를 필수화한다. 현재 pending provenance에서는 의도적으로 실패하며, synthetic/real-world 통과를 독립 정확도 증거로 승격하지 않는다.
- 2026-09-28 검증: 기본 aggregate는 정확도 11개와 packed package/self-scan을 포함한 13개 gate로 확장했으며, 독립 리뷰 요구 모드는 held-out gate에서 fail-closed한다. 원격 Node reusable workflow 부재는 CI DoD blocker로 남아 있다.

### 10차 후속 — incremental performance evidence refresh

- 현재 checkout을 frozen input으로 고정해 `node bench/incremental.mjs . 3`을 새 프로세스에서 실행했다. 세 cold/warm sample 모두 fact hash가 동일했고 cache contract(frontend cold miss/warm hit, summary warm hit)와 snapshot commit이 통과했다.
- 측정값은 cold p50 27.3초 / p95 32.4초 / max RSS 996 MiB, warm p50 6.3초 / p95 6.5초 / max RSS 682 MiB로, 사전 budget(cold 60초, warm 15초, RSS 1 GiB)을 통과했다. 3개 표본은 성능 경향과 현재 구현의 budget 근거이며, 기존 5개 표본 baseline을 대체하거나 다른 machine의 일반화 수치로 해석하지 않는다.

### 10차 후속 — TypeScript intersection receiver dispatch

- TypeScript `A & B` receiver를 `union`으로 뭉개지 않고 `intersection` fact로 보존해, 교집합 타입이 확실히 제공하는 member를 dispatch할 수 있게 했다. `Runner & Tagged`의 `run()` 호출은 `Runner.run`으로 resolve된다.
- intersection의 각 arm이 서로 다른 구현을 가리키거나 generic/subtype solver가 필요한 경우는 여전히 `ambiguous-binding` 또는 unresolved로 fail-closed한다. 이는 완전한 TypeScript structural subtype solver나 CodeQL 동등성을 의미하지 않는다.
- 검증: `tests/analysis/resolveSymbols.test.ts` 87/87, 전체 suite 45 files / 930 tests, `npm run lint`, `npm run build`, `git diff --check`, aggregate 13/13 gate 통과. 이 결과는 intersection dispatch 회귀와 기존 gate 비회귀를 확인하지만 CodeQL 동등성 증거는 아니다.

### 10차 후속 — TypeScript generic intersection bounds

- `T extends Runner & Tagged`의 tree-sitter `constraint/intersection_type`를 bound 이름들로 보존하고, generic receiver를 여러 bound의 `intersection` target으로 반환한다. 따라서 `x.run()`은 `Runner.run`으로 resolve되고, 각 bound가 제공하는 member를 공통 dispatch 경로에서 조회한다.
- conflicting implementation, generic bound 자체의 subtype 계산, mapped/conditional constraint와 runtime erasure는 여전히 fail-closed다. 다중 bound를 지원한다고 해서 완전한 TypeScript constraint solver나 CodeQL 동등성을 의미하지 않는다.
- 다중 bound 중 하나라도 unresolved/failure이면 증명된 arm만 남기지 않고 전체 generic receiver를 `unknown-receiver`로 유지한다. 부분적인 bound 지식으로 확정 dispatch를 만들지 않는 fail-closed 회귀를 추가했다.
- nested generic constraint(`T extends Box<Result>`)는 외부 `Box` 하나의 bound로 유지하고 `Result`를 별도 bound로 오인하지 않는다. generic type 내부 argument의 subtype 검증은 아직 수행하지 않지만 constraint 구조를 보존한다.
- Rust `where T: Runner + Tagged`도 동일한 intersection target으로 수집해 `T`의 `run()`을 `Runner.run`으로 연결한다. where-bound의 associated type/ higher-ranked lifetime/trait solver는 아직 지원하지 않는다.
- generic Rust bound의 각 arm은 `isAbstract`로 유지해 indexed concrete `impl`을 임의로 선택하지 않는다. 구체 타입 receiver에서만 유일한 impl dispatch를 허용하고, generic trait bound는 trait declaration method로 남긴다.
- TypeScript union constraint(`T extends A | B`)는 별도 `union` target으로 보존한다. 모든 arm이 같은 member target으로 수렴할 때만 dispatch를 확정하고, 한 arm이 member를 제공하지 않거나 구현이 갈리면 `ambiguous-binding`으로 fail-closed한다.
- 검증: `tests/analysis/resolveSymbols.test.ts` 91/91, 전체 suite 45 files / 934 tests, `npm run lint`, `npm run build`, `git diff --check`, aggregate 13/13 gate 통과. 이 결과는 TypeScript/Rust generic intersection dispatch, partial-bound fail-closed, nested generic constraint 회귀를 확인하지만 CodeQL 동등성 증거는 아니다.

### 10차 후속 — TypeScript type assertion receiver facts

- `value as Runner`와 `<Runner>value`를 원래 `value`의 unknown 상태로 버리지 않고 asserted type의 `instance` fact로 보존한다. 이후 member dispatch는 `Runner.run`처럼 정적 assertion target에서 해석한다.
- assertion은 runtime validation이나 실제 객체 shape 검증을 증명하지 않는다. 존재하지 않는 type, cast soundness, conditional/mapped type assertion은 기존 unresolved 경계를 유지한다.
- 검증: `tests/analysis/resolveSymbols.test.ts` 95/95, 전체 suite 45 files / 938 tests, `npm run build`, `git diff --check`, aggregate 13/13 gate 통과. union bound는 공통 target 수렴만 확정하며 일반 union subtype solver나 CodeQL 동등성을 의미하지 않는다.

### 10차 후속 — flow-sensitive member mutation dispatch

- `x.member = value` 형태의 member write를 symbol facts에 source offset과 receiver 이름으로 보존하고, 이후 같은 receiver의 `x.member()` dispatch에서 stale class/interface method를 확정하지 않도록 `reassigned-binding`으로 낮춘다.
- mutation object identity를 증명하지 못하는 computed/dynamic property, alias를 통한 heap mutation, cross-function writes는 보수적으로 완전한 alias solver를 주장하지 않는다. 현재 직접 named receiver assignment만 연결한다.
- 검증: `tests/analysis/resolveSymbols.test.ts` 96/96, 전체 suite 45 files / 939 tests, `npm run build`, `git diff --check`, aggregate 13/13 gate 통과. 직접 member mutation 이후 stale dispatch를 차단했으며 alias/computed heap mutation은 여전히 별도 범위다.
