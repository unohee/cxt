# 함수 간 요약 구현 계약

추적: AGT-4568. 상태: 핵심 구현 검증, 제한과 측정은 STATIC_ANALYSIS_ROADMAP.md 참조.

- resolved call-site의 파일·시작/끝 위치와 caller를 사용해 CFG call effect를 연결한다. 이름 문자열이나 프로젝트 전체 동명 검색으로 대상을 추정하지 않는다.
- formal argument index/receiver 및 미지원 binding을 AST에서 기록한다. keyword/spread/default/destructuring 등 정확한 대응을 증명하지 못하는 호출은 unknown으로 유지한다.
- 요약은 정상 반환의 abstract atom/parameter dependence, 가능한 throw, heap/captured binding effects, 불완전 이유를 담는다. value dependence와 control dependence를 구분한다. 초기 단계에서 argument의 실제 atom을 identity처럼 대입하지 않는다. 입력이 반환값에 영향을 준다는 사실만으로 identity 함수임을 증명할 수 없기 때문이다.
- resolved call graph의 SCC를 callee부터 처리한다. recursive component는 유한 bottom에서 시작해 monotone join 고정점으로 전파하고, round/work 예산 초과는 component 전체를 partial로 만든다. partial 요약을 정밀한 effect-free 요약으로 소비하지 않는다.
- 각 call site에서 실제 argument의 정의/parameter 관계를 별도로 대입한다. 서로 다른 호출의 arguments를 한 함수 전역 상태에 합치지 않는다. unknown call/receiver/parameter mapping은 conservative effects를 유지한다.
- resource lifecycle summary는 `returnsResource: fresh`로 callee 내부 acquire 결과를 선언한다. caller는 callee의 concrete resource atom을 재사용하지 않고 call site identity를 새로 만들어 aliasing을 방지한다. release/ownership state는 caller path에서 다시 계산한다.
- release wrapper는 `releasesResource: { parameter }`를 summary에 보존한다. caller는 해당 actual argument의 resource atoms만 닫으며, wrapper 내부 local resource나 모호한 argument provenance는 계약으로 승격하지 않는다.
- borrowed-return wrapper는 반환값 전체가 하나의 formal parameter resource provenance를 보존할 때만 `returnsResource: { source: 'parameter', parameter }`로 요약한다. caller는 실제 argument의 resource atom을 반환값에 대입하고, plain value나 모호한 provenance는 resource로 추론하지 않는다.
- 일반 identity wrapper도 모든 반환 경로가 같은 `parameter:<key>` provenance를 보존할 때 `returnsParameter: <index>`로 요약한다. caller는 summary의 broad unknown atom을 재사용하지 않고 실제 argument atom을 alias로 대입해 object field mutation과 resource identity를 보존한다.
- Rust dataflow는 현재 heap/resource identity가 증명된 값의 대입·반환 move를 추적하고, 이후 읽기를 `use-after-move` ownership finding으로 노출한다. primitive Copy 값과 명시적 reference borrow는 moved로 표시하지 않으며, 타입 추론이 없는 unknown 값은 보수적으로 partial 경계에 남긴다.
- ownership finding은 사용 node와 moved state를 만든 `FlowDefinition` ID를 함께 반환한다. JSON consumer는 `definitions`를 `flow.definitions`에 join해 move source와 use location을 path로 표시할 수 있다.
- resource finding도 `sourceNodes`에 acquire/release를 만든 정적 CFG node ID를 선택적으로 반환한다. 이는 runtime trace가 아니며, JSON consumer가 `locations`와 join해 lifecycle source와 진단 지점을 설명할 수 있게 한다.
- 외부 또는 함수 간 summary의 `movesParameters`는 명시된 formal argument만 caller에서 moved로 전파한다. 모델이 없는 호출과 borrow 계약은 state를 변경하지 않으며, 타입/trait 증명이 없는 heap 값의 finding certainty는 `possible`이다.
- `borrowsParameters`는 모델 또는 wrapper가 참조만 보유한 formal argument를 별도로 보존한다. borrow는 caller state를 moved로 바꾸지 않으며, JSON summary에서 소비 계약과 구분된다.
- Rust 함수 본문에서 typed non-primitive formal parameter를 직접 대입·반환하면 `DataflowResult.movedParameters`로, `&parameter`를 만들면 `borrowedParameters`로 기록한 뒤 summary formal index로 승격한다. primitive/reference type은 현재 타입 텍스트 휴리스틱으로 제외하며 generic bound·trait dispatch·crate 간 타입 해석은 이 계약의 증거가 아니다.
- Rust ownership solver는 구조체 표현을 보수적 non-Copy heap identity로 취급하고, literal-only fixed arrays/tuples와 primitive 값을 Copy 경계로 구분한다. 같은 파일의 `impl Copy for Type` 선언은 해당 struct를 Copy로 승격한다. Copy로 증명된 heap identity는 대입/호출/반환에서 moved state를 만들지 않는다. generic/subtype 증명은 아직 모델 밖이다.
- 함수 본문의 return과 async/generator 호출이 반환하는 Promise/coroutine/Future/iterator는 구분한다. 이 호출 envelope를 모델링하기 전에는 partial 요약으로 유지한다. 정적 callee 해석 후 unknown 효과가 binding을 바꾼 경우에도 callable 추상값을 재확인한다.
- `impact/preflight --param --explain`은 지원하는 value-dependence 경로와 불완전 경계를 함께 반환한다. 일반 call-graph 영향과 의미가 다른 만큼 parameter 영향으로 제외된 후보를 모든 종류의 변경에서 안전하다고 주장하지 않는다.
- 검증: 다중 파일 wrapper·무시한 argument·서로 다른 call sites·recursion·throw/effect·미지원 mapping, old snapshot 보존, 수기 변경 영향 oracle와 기존 graph baseline 비교. 실제 프로젝트 및 독립 정확도는 별도 보고한다.

## 구현된 질의 의미

`impact/preflight --param`은 선택한 formal parameter의 명시적 value dependence가 callee 반환 정의를 거쳐 caller의 출력에 닿는지를 역방향으로 추적한다. 호출 결과를 버리거나 덮어쓴 caller는 제외할 수 있다. 초기 입력만으로 모든 제어 의존성·signature 변경·새로 작성될 코드의 영향을 예측하지 않는다. 기본 impact의 일반 역방향 relation 질의는 그대로 사용한다.

경로는 call marker definition → assignment/use → return/throw/외부 state의 정적 근거다. 실행된 runtime 경로를 주장하지 않는다. 부분 요약/미해석 target/non-return effect/깊이 제한은 boundary로 남는다. 서로 다른 call site를 하나의 반환값으로 합치지 않는다. JSON의 intraprocedural completeness와 summary completeness를 나누고 flow strict는 둘을 합친 analysisCompleteness를 사용한다.
