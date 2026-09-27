# 정적 분석 정확도 코퍼스

추적: [AGT-3878](https://linear.app/intrect/issue/AGT-3878), [AGT-3879](https://linear.app/intrect/issue/AGT-3879).

현재 선언 코퍼스는 언어당 20개, 총 60개 합성 fixture의 선언 100개를 수기로 라벨링했다. 별도의 호출 코퍼스는 다중 파일 사례 39개, 호출 위치 55개다. 소스와 정답을 같은 JSON 파일에서 검토할 수 있다. 현재 parser 출력을 정답으로 생성하지 않는다. export/parameter metadata, 실제 저장소 슬라이스 및 held-out 계층은 후속 작업이며, 기존 P0 전체 완료 조건을 충족했다고 주장하지 않는다.

## 재현

```bash
npm run bench:accuracy
npm run bench:calls
npm run bench:cfg
npm run bench:accuracy -- --engine lexical --no-gate
npm test
npm run test:package
```

`--output <path>`로 JSON을 저장한다. 기본 AST 실행은 gates.json을 적용하고 실패 시 exit 1이다. `--no-gate`는 과거 lexical 기준선 측정용이며 보고서에 `gateEnforced: false`가 표시된다. `--engine lexical`만 지정하면 현재 AST 게이트를 통과하지 못하고 exit 1이 된다.

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

`corpus/cfg.json`은 언어별 9개, 총 27개의 수기 fixture다. `complexity`, `completeness`, `paths: [fromNodeText, toNodeText, reachable]`가 정답이다. 호출·멤버 접근의 잠재 예외를 포함하는 CFG에서 경로를 확인한다. 존재하지 않는 label은 negative 경로가 맞았다고 세지 않는다. 언어마다 의도적으로 미지원인 구문 1개를 넣어 `partial` 보고도 검사한다.

`structuralComplexity`는 명시적 분기 지점 + 1이다. if/elif, 조건이 있는 loop, switch의 비-default case, match의 비-wildcard arm, guard/catch, 단락 평가, 기본 매개변수, Rust `?`, with 예외 억제 분기를 센다. 암묵적 예외 edge와 finally 경로 복제는 중복 계산하지 않는다. 전체 예외 그래프의 E−N+2 수치와는 구분한다.

게이트: 그래프 생성률 ≥0.98, 구조 복잡도 정확도 ≥0.95, completeness 및 경로 정답 100%. `cfg-baseline.json`: 언어별 9/9 생성, 그중 complete 8/partial 1, 총 경로 45/45, 복잡도 27/27. **생성률은 완전 지원률이 아니다.** 누락 그래프·틀린 복잡도·조작된 completeness·return 뒤 우회 edge·없는 노드 mutation을 모두 실패시킨다. basic block은 모든 노드를 정확히 한 번 포함하고 블록 사이 edge를 보존하는지도 검사한다. 실제 언어/프로젝트 일반화와 path feasibility는 독립 후속 평가 대상이다.
