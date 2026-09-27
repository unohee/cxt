# 함수 간 요약 구현 계약

추적: AGT-4568. 상태: 핵심 구현 검증, 제한과 측정은 STATIC_ANALYSIS_ROADMAP.md 참조.

- resolved call-site의 파일·시작/끝 위치와 caller를 사용해 CFG call effect를 연결한다. 이름 문자열이나 프로젝트 전체 동명 검색으로 대상을 추정하지 않는다.
- formal argument index/receiver 및 미지원 binding을 AST에서 기록한다. keyword/spread/default/destructuring 등 정확한 대응을 증명하지 못하는 호출은 unknown으로 유지한다.
- 요약은 정상 반환의 abstract atom/parameter dependence, 가능한 throw, heap/captured binding effects, 불완전 이유를 담는다. value dependence와 control dependence를 구분한다. 초기 단계에서 argument의 실제 atom을 identity처럼 대입하지 않는다. 입력이 반환값에 영향을 준다는 사실만으로 identity 함수임을 증명할 수 없기 때문이다.
- resolved call graph의 SCC를 callee부터 처리한다. recursive component는 유한 bottom에서 시작해 monotone join 고정점으로 전파하고, round/work 예산 초과는 component 전체를 partial로 만든다. partial 요약을 정밀한 effect-free 요약으로 소비하지 않는다.
- 각 call site에서 실제 argument의 정의/parameter 관계를 별도로 대입한다. 서로 다른 호출의 arguments를 한 함수 전역 상태에 합치지 않는다. unknown call/receiver/parameter mapping은 conservative effects를 유지한다.
- 함수 본문의 return과 async/generator 호출이 반환하는 Promise/coroutine/Future/iterator는 구분한다. 이 호출 envelope를 모델링하기 전에는 partial 요약으로 유지한다. 정적 callee 해석 후 unknown 효과가 binding을 바꾼 경우에도 callable 추상값을 재확인한다.
- `impact/preflight --param --explain`은 지원하는 value-dependence 경로와 불완전 경계를 함께 반환한다. 일반 call-graph 영향과 의미가 다른 만큼 parameter 영향으로 제외된 후보를 모든 종류의 변경에서 안전하다고 주장하지 않는다.
- 검증: 다중 파일 wrapper·무시한 argument·서로 다른 call sites·recursion·throw/effect·미지원 mapping, old snapshot 보존, 수기 변경 영향 oracle와 기존 graph baseline 비교. 실제 프로젝트 및 독립 정확도는 별도 보고한다.

## 구현된 질의 의미

`impact/preflight --param`은 선택한 formal parameter의 명시적 value dependence가 callee 반환 정의를 거쳐 caller의 출력에 닿는지를 역방향으로 추적한다. 호출 결과를 버리거나 덮어쓴 caller는 제외할 수 있다. 초기 입력만으로 모든 제어 의존성·signature 변경·새로 작성될 코드의 영향을 예측하지 않는다. 기본 impact의 일반 역방향 relation 질의는 그대로 사용한다.

경로는 call marker definition → assignment/use → return/throw/외부 state의 정적 근거다. 실행된 runtime 경로를 주장하지 않는다. 부분 요약/미해석 target/non-return effect/깊이 제한은 boundary로 남는다. 서로 다른 call site를 하나의 반환값으로 합치지 않는다. JSON의 intraprocedural completeness와 summary completeness를 나누고 flow strict는 둘을 합친 analysisCompleteness를 사용한다.
