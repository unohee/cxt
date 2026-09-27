# 정적 분석 정확도 코퍼스

추적: [AGT-3878](https://linear.app/intrect/issue/AGT-3878), [AGT-3879](https://linear.app/intrect/issue/AGT-3879).

합성 선언 코퍼스는 언어당 20개, 총 60개 fixture의 선언 100개를 수기로 라벨링했다. 별도의 호출 코퍼스는 다중 파일 사례 39개, 호출 위치 55개다. 실제 소스 계층은 세 언어 3개 구간/32개 선언과 export/parameter metadata를 추가했고, 자기 코드 계층은 독립 compiler로 보조 작성한 50개 선언이다. 현재 parser 출력을 정답으로 생성하지 않으며 라벨 오류 수정 이력도 보존한다. held-out 계층, 다른 fact family의 실제 소스 정답 및 독립 라벨 리뷰는 후속 작업이며, 기존 P0 전체 완료 조건을 충족했다고 주장하지 않는다.

## 재현

```bash
npm run bench:accuracy
npm run bench:calls
npm run bench:cfg
npm run bench:rules
npm run bench:external
npm run bench:self
npm run bench:incremental
npm run bench:accuracy -- --engine lexical --no-gate
npm test
npm run test:package
```

`--output <path>`로 JSON을 저장한다. 기본 AST 실행은 gates.json을 적용하고 실패 시 exit 1이다. `--no-gate`는 과거 lexical 기준선 측정용이며 보고서에 `gateEnforced: false`가 표시된다. `--engine lexical`만 지정하면 현재 AST 게이트를 통과하지 못하고 exit 1이 된다.

## 실제 소스 선언 계층

`npm run bench:self`는 f711a50의 entityScanner.ts 전체 snapshot에서 최상위 이름 있는 선언 50개를 검사한다. 정답은 독립 TypeScript 5.9.3 compiler AST로 보조 작성하고 source 경계를 확인했다. 수기 라벨이나 독립 PR 리뷰로 부르지 않는다. 첫 AST 평가의 선언/span/scope/export/parameter 지표는 모두 1.0이다. 같은 소스의 lexical은 recall24/50(48%), span23/24, export24/50, parameter22/50이다. 중첩 선언을 분모/분자에 넣지 않으며 자기 코드에서 call/flow 정답을 만들지 않는다. 과거 문서의 49개는 이전 source revision의 개수다.

`npm run bench:external`은 Zod 4.3.6(TypeScript), CPython 3.12(Python), rust-fnv 1.0.7(Rust)의 고정 소스 구간과 수기 라벨 32개를 검사한다. 각 소스의 라이선스·패키지 버전·원본/구간/라벨 SHA는 `corpus/real-world/provenance.json`에 있다. span/scope와 syntactic export/parameter count를 각각 측정하고, source/license/label hash가 달라지면 분석 전에 실패한다. Declaration 네 지표는 각각 ≥0.98, export/parameter 지표는 1.0을 요구한다. 중복·누락·위치·scope·export·parameter mutation이 게이트를 실패시키는지 검사한다.

첫 결과 `external-first-evaluation.json`은 TS/Python 전 지표 1.0, Rust scope 5/8이었다. 수기 라벨이 세 trait method에서 trait 한정자를 누락한 것이 원인이며 Rust Reference 및 기존 `rust/trait-impl` 계약에 따라 정정했다. 최초 라벨과 SHA, 정확한 세 수정은 `expected.v1.json`/`label-revisions.json`에 보존했다. 엔진 변경 없이 정정 결과 `external-baseline.json`은 32개 전 지표 1.0이다. 이 결과는 라벨 검토 후 회귀 기준선이며 unseen 평가나 독립 PR 리뷰 결과로 부르지 않는다. 선택한 소스 구간의 선언/metadata 정확도이고 calls/flow/rules의 실제 소스 정확도를 측정한 것은 아니다.

## 증분 성능

`npm run bench:incremental -- /absolute/git/repo 5`는 입력을 임시 snapshot에 고정하고 cold/warm을 각각 새 프로세스에서 측정한다. 전체 fact 내용의 동등성, 사전 cold 60초/warm 15초/scan peak RSS 1 GiB budget을 검사하며 모든 raw 결과와 DB를 보존한다. 표본 5개 p95는 최대값이다. [무효화·질의·측정 계약](../docs/INCREMENTAL_FACTS.md)을 참고한다.

## 정답 포맷

`corpus/{typescript,python,rust}.json`은 fixture 배열이다. 필드는 `id`, `language`, `filePath`, `source`, `expected`이며, expected의 각 항목은 `[kind, name, lineStart, lineEnd, scopedName?]`다. 범위는 1부터 시작하는 양끝 포함 줄 번호다. 마지막 항목 생략 시 스코프 없는 name과 동일하다. 선언에 붙은 export/decorator는 범위에 포함한다. 중첩 함수·클래스·메서드는 별도 항목이다. 함수 내부 일반 지역 변수는 선언 인벤토리 대상에서 제외한다. Rust 매크로 토큰 내부 텍스트는 확장된 코드로 추정하지 않는다.

Zod로 언어/종류/범위/필수 필드를 검증하고, 중복 fixture ID 및 소스를 벗어나는 span은 오류로 종료한다. precision/recall은 `(kind,name,lineStart)`의 multiset 일치다. 중복 prediction을 set으로 없애지 않는다. spanAccuracy와 scopeAccuracy는 일치한 선언 중 lineEnd 및 scopedName이 맞는 비율이다. 파싱 실패가 있으면 다른 점수가 높아도 gate 실패다.

## 2026-09-27 기준선

| 엔진 | 언어 | precision | recall | spanAccuracy |
|---|---|---:|---:|---:|
| lexical | TypeScript | 100.0% | 34.2% | 92.3% |
| lexical | Python | 89.3% | 73.5% | 92.0% |
| lexical | Rust | 82.8% | 85.7% | 54.2% |
| AST | 세 언어 각각 | 100.0% | 100.0% | 100.0% |

원자료: `lexical-baseline.json`, `ast-baseline.json`. 동일 corpus SHA-256을 기록했다. Node 24/Linux 단일 실행에서 lexical 약 9 ms, AST 약 196 ms였다. 초기 native 로드와 쿼리 컴파일을 포함한다. max RSS는 전체 benchmark 프로세스(tsx 포함)의 최대값이므로 엔진 순수 메모리로 해석하지 않는다.

게이트는 현재 실측치에서 2%p 낮은 0.98이며 언어별로 독립 적용한다. 낮추려면 검토 가능한 근거와 Linear 기록이 필요하다. scorer 회귀검사는 중복 prediction, 빈 결과, 틀린 span/scope를 주입해 gate 실패를 확인한다.

패키지 검사는 임시 prefix에 실제 글로벌 설치 후 CLI를 실행한다. 이어서 해당 임시 설치의 native parser 패키지만 별도 임시 디렉터리로 옮겨 모듈 부재를 실제로 만들고, auto fallback 및 ast 실패를 검증한다. 이 환경의 npm 11.19.0은 글로벌 설치 `--omit=optional`에도 peer로 연결된 parser를 설치했으므로 그 플래그만으로 부재를 가정하지 않는다.

이 코퍼스는 개발 중 구현을 확인하는 회귀 자료다. CodeQL 대비 정확도, 실제 프로젝트의 일반화, 취약점 탐지율 또는 전체 언어 지원을 입증하지 않는다. 이후 심볼/CFG/dataflow/규칙마다 별도 fact family와 독립 정답을 확장한다.

## 호출 정답과 게이트 — AGT-4565

`corpus/calls.json`: `id`, `language`, `files`(상대경로→소스), `expected` 배열.
라벨은 `[file, line, column, targetQualifiedNameOrNull, resolution?, endLine?, endColumn?]`이다.
줄/열은 1부터 시작하고 끝 위치는 exclusive다. `run()()`처럼 시작점이 같은 호출은 끝 위치도 라벨링한다.
해석 가능한 대상은 qualified name, 미해석 대상은 null이다. `resolution` 기본값은 target이 있으면 resolved, 없으면 unresolved이며 외부 모듈은 external을 명시한다.

정확한 위치와 대상이 일치해야 true positive다. 잘못된 대상은 false positive와 false negative를 각각 하나씩 늘린다. 미해석 정답에 대상을 지어내면 false positive다. 중복·누락 위치도 점수를 낮춘다. `siteAccuracy`는 일치 위치 / (일치+추가+누락), `resolutionAccuracy`는 대상과 상태가 모두 맞는 위치 / 같은 분모다. 언어별 게이트는 precision≥0.95, recall TS≥0.90/Python≥0.85/Rust≥0.75, siteAccuracy=1, resolutionAccuracy≥0.95다. gate 실패는 exit 1이며 틀린 대상·위치·누락·중복을 넣는 mutation 회귀검사가 있다.

`call-baseline.json`은 TS 17개 fixture/25개 위치(확정 대상 17), Python 11/15(10), Rust 11/15(11)를 기록한다. 현재 이 개발 코퍼스에서는 모든 측정값이 1.0이다. import/re-export/namespace, shadowing, alias, recursion, 간단한 receiver, 미해석·외부·재할당과 순환 관계를 포함한다. 알려진 범위를 겨냥한 합성 자료이므로 실제 프로젝트 정확도나 일반화의 근거로 사용하지 않는다.

## CFG 정답과 게이트 — AGT-4566

`corpus/cfg.json`은 언어별 10개, 총 30개의 수기 fixture다. `complexity`, `completeness`, `paths: [fromNodeText, toNodeText, reachable]`가 정답이다. 호출·멤버 접근의 잠재 예외를 포함하는 CFG에서 경로를 확인한다. 존재하지 않는 label은 negative 경로가 맞았다고 세지 않는다. 언어마다 의도적으로 미지원인 구문 1개를 넣어 `partial` 보고도 검사한다. await 구현 후 기존 TypeScript 미지원 예제를 yield로 교체하고, 세 언어의 await 중단/재개 정답을 추가했다. 중단 terminal에서 후속 문장으로 직접 이동할 수 없으며 재개 edge는 별도로 존재한다.

`structuralComplexity`는 명시적 분기 지점 + 1이다. if/elif, 조건이 있는 loop, switch의 비-default case, match의 비-wildcard arm, guard/catch, 단락 평가, 기본 매개변수, Rust `?`, with 예외 억제 분기를 센다. 암묵적 예외 edge와 finally 경로 복제는 중복 계산하지 않는다. 전체 예외 그래프의 E−N+2 수치와는 구분한다.

게이트: 그래프 생성률 ≥0.98, 구조 복잡도 정확도 ≥0.95, completeness 및 경로 정답 100%. `cfg-baseline.json`: 언어별 10/10 생성, 그중 complete 9/partial 1, 총 경로 54/54, 복잡도 30/30. **생성률은 완전 지원률이 아니다.** 누락 그래프·틀린 복잡도·조작된 completeness·return 뒤 우회 edge·없는 노드 mutation을 모두 실패시킨다. basic block은 모든 노드를 정확히 한 번 포함하고 블록 사이 edge를 보존하는지도 검사한다. 실제 언어/프로젝트 일반화와 path feasibility는 독립 후속 평가 대상이다.

## 함수 내부 dataflow 정답과 게이트 — AGT-4567

`corpus/dataflow.json`: 언어별 9개, 총 27개 수기 fixture. `parameters`는 가능한 정상 반환값의 명시적 입력 의존성, `reads`는 `[useLine, useColumn, variableName, definitionLines, mayBeUninitialized]`이다. `atoms`가 있으면 추상 반환값 집합도 정확히 비교한다. source 줄/열은 1부터 시작한다. 조건의 control dependence는 이 value-dependence 라벨에 포함하지 않는다. Rust uninitialized 예제는 컴파일 가능한 정상 프로그램을 주장하는 대신 불완전 소스 분석을 검사한다.

정의/사용 라벨은 지정한 read 위치에서 definition source line까지의 집합이다. 동일 줄의 여러 정의를 구분하는 정답 코퍼스는 아니다. 반환 parameter relation과 합쳐 언어별 precision/recall을 측정한다. 미지원 예제를 각 언어에 하나 포함한다. `partial`은 라벨 정확도 통과와 별도로 남는다.

게이트는 라벨 precision/recall=1, 명시된 atom·uninitialized·completeness 정답 일치다. 2026-09-27 개발 기준선 `dataflow-baseline.json`은 관계 30/30, read 상태 21/21, completeness 27/27이다. 임의의 결과 부재, 정의 누락, 거짓 parameter dependence, completeness 조작, assignment effect 삭제, solver 예산 소진 mutation은 실패해야 한다. 이 점수는 선택한 개발 라벨의 일치도이며 실제 프로젝트 정확도·CodeQL 동등성·resource/ownership 분석 완료를 의미하지 않는다.

## Parameter value impact 비교 — AGT-4568

`corpus/impact.json`은 언어별 5개, 총 15개 수기 fixture다. `target`, `parameter`, `expected` caller 목록, `completeness`, `pathCalls: [callerName, expectedCallText]`를 기록한다. discarded/overwritten 결과, 무시한 formal parameter, 여러 call site, wrapper chain, 외부 미해석 경계를 포함한다. 경로의 call node/원본 span과 라벨 call text도 검사한다.

기존 `SqliteRegistryStore.getImpactSet`을 실제 메모리 DB에서 실행하여 같은 parameter-value 정답에 대조한다. 일반적인 코드 변경 전체의 정답을 바꿔 측정하는 것이 아니다. 새 질의의 명시적 value-dependence 작업에서 기존 caller 후보가 얼마나 과다한지 측정한다. 각 언어의 complete fixture 4개만 precision/recall 분모에 넣고, partial fixture 1개는 상태·경로 회귀로 분리한다.

개발 기준선 `impact-baseline.json`: 언어별 기존 TP 3/FP 3(precision 0.5), 새 TP 3/FP 0/FN 0(precision/recall 1.0), +50%p. 게이트는 precision/recall=1 및 기존 대비 최소 +15%p이고, 모든 fixture의 상태와 경로가 맞아야 한다. 후보 누락/추가/중복·틀린 call node/span mutation은 실패해야 한다. 작은 개발용 표본이며 일반 변경 영향·implicit control dependence·독립 프로젝트 정답률을 입증하지 않는다.
