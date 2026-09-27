# 함수 내부 dataflow 구현 계약

추적: [AGT-4567](https://linear.app/intrect/issue/AGT-4567). 상태: 핵심 solver/DB/CLI 구현, lifecycle·ownership 모델과 독립 평가 진행 전. 아래 구현 계약과 현재 검증 범위를 구분한다.

## 사실과 평가 순서

- 기존 AST scopes/bindings에 source offset 범위를 붙여 지역·parameter·외부 binding을 구분한다. 변수 identity는 파일·scope·이름이다. 동명 변수나 Python global/nonlocal을 합치지 않는다.
- CFG node에 AST effect를 붙인다. assignment의 LHS를 일반 read로 세지 않고, compound assignment는 기존 값을 읽는다. temporaries는 AST source span으로 식별해 인자의 평가 도중 재할당되어도 먼저 읽은 값을 보존한다.
- ternary/short-circuit/optional chain은 선택된 경로에만 값 생산 노드를 둔다. default parameter, iterator의 성공한 반복, catch parameter의 정의 시점도 CFG에 명시한다. Python except alias는 handler를 떠날 때 해제한다.
- 예외 edge에서는 성공한 반환값·write를 적용하지 않는다. finally 복제와 await resume/exception 경로를 그대로 사용한다. suspension terminal은 정상 return summary가 아니다.

## Solver

- CFG 위 finite worklist fixed point. 변수별 reaching definitions는 재할당 시 strong kill, join에서 union한다. loop에서 새 definition ID를 반복 생성하지 않는다. 진단은 수렴 후 상태에서 도출한다.
- 값 domain: uninitialized/undefined/null/boolean/비-null/unknown, allocation-site points-to, parameter dependence. 객체 alias는 같은 allocation ID를 공유한다. 단일 대상 field write는 strong update, 여러 대상은 weak update한다.
- 지역 lexical binding은 uninitialized, JS var는 undefined, parameter/외부 입력은 unknown으로 시작한다. 초기화 여부와 값이 알려지지 않음을 구분한다. function declaration/import는 별도 binding 사실을 따른다.
- unknown call/await는 알 수 없는 외부 효과를 지닌다. alias heap 및 캡처·외부 binding을 안전하다고 가정하지 않는다. 함수 요약(AGT-4568)과 library/resource model(AGT-4569)이 확인된 효과를 제공할 때 정밀도를 높인다. API 이름만 보고 open/close 의미를 정하지 않는다.
- partial CFG, 지원하지 않는 effect, iteration budget 초과는 partial 결과다. 수렴하지 않은 중간 상태를 검증된 안전성으로 보고하지 않는다.

## 검증과 노출

- 수기 언어별 oracle: strong kill, diamond merge, zero/many loop iterations, lexical shadowing, aliases/field updates, null refinements, catch/finally 및 await failure.
- 평가 순서 회귀: conditional RHS를 실행하지 않은 경로, parameter default 미적용 경로, iterator 0회 경로, catch alias 삭제, 호출 인자 중 재할당.
- 잘못된 kill/merge/누락 edge/iteration cap mutation은 gate가 실패해야 한다. 언어별 precision/recall과 미지원·외부 효과 수를 분리한다.
- 실제 AST→CFG→solver→scan snapshot→`flow` CLI를 연결한다. 기존 snapshot은 분석/저장 실패 시 보존한다. resource 상태 및 함수 간 요약의 미완료 의존성을 명시한다.

## 구현된 경로와 현재 한계

- `treeSitter.ts` → `dataflowFacts.ts` → `analyzeDataflow` → v6 `code_dataflow` → `flow --json --strict`. 기존 v5 DB는 데이터 손실 없이 이관하며 이전 CFG에서 flow 결과를 지어내지 않는다. 재scan이 필요하다.
- 작업량 예산은 transfer 횟수, 저장 cell 수, 값·alternative의 누적 처리량을 각각 제한한다. 초과는 `iteration-budget` / `state-budget` / `work-budget`과 partial이다. 전체 scan deadline 초과와 저장 실패는 entities/calls/CFG/flow/relations 전체 rollback이다.
- 뒤에서 다시 읽지 않는 변수·temporary는 edge마다 제거한다. unknown call/getter/setter/operator/await는 heap과 캡처·외부 변수를 무효화하고, 직접 eval은 지역 변수도 무효화한다. effect 위치는 결과 `unknownEffects`에 남는다.
- 전역 연산 의미 전체를 증명하지 않는다. Python dynamic rethrow context, context-manager binding/lifecycle, 동적 pattern binding은 partial로 표시한다. Rust move/borrow 및 resource lifecycle은 AGT-4569 의미 모델과 함께 구현할 남은 의존성이다. 지원된 primitive/alias domain의 complete는 프로그램 안전성이나 언어 전체 의미 분석 완료를 뜻하지 않는다.
- 27개 수기 개발 fixture는 source 위치별 reaching definition, 반환 parameter dependence, uninitialized 여부, 일부 정확한 반환 atom을 검사한다. 실제 프로젝트의 독립 정답률은 아직 측정하지 않았다.
