# 외부 API 모델 계약

추적: AGT-4569. 모델은 소스가 없는 API의 조건부 추상 계약이다. 호출 이름만으로 pure를 가정하지 않는다.

## 프로젝트 설정

프로젝트 루트의 `.cxt-models.json`:

```json
{
  "schemaVersion": 1,
  "versions": { "node": "22.19.0", "python": "3.12.0", "rust": "1.85.0" },
  "assumptions": ["unmodified-external-bindings"],
  "packs": []
}
```

버전은 대상 프로젝트의 정확한 선언이다. 분석기 runtime이나 `engines >=22` 같은 범위를 설치 버전으로 변환하지 않는다. 설정이 없으면 외부 모델로 unknown 효과를 제거하지 않는다. `unmodified-external-bindings`는 함수 진입 시 import가 모델의 원래 API를 가리킨다는 가정이다. 동적 module 교체/monkeypatch와 실행 전 초기화 순서는 입증하지 못하며, 결과에도 이 가정을 남긴다. 함수 내부에서 unknown 효과가 binding을 변경하면 적용을 중단한다. 변경 전에 복사한 callable의 identity가 남아 있다면 그 복사본은 계속 사용할 수 있다.

## 적용 단계

1. lexical binding/import/reexport에서 language/module/symbol identity를 만든다. 로컬 동명 함수, 매개변수 shadowing, 프로젝트의 `math.py`를 표준 라이브러리로 취급하지 않는다. identity는 설치 존재나 버전 검증을 뜻하지 않는다.
2. 패키지 버전이 모델의 `[min,before)` 구간에 있고 후보가 정확히 하나여야 한다. 겹치는 후보는 priority로 덮어쓰지 않고 `ambiguous`로 남긴다.
3. CFG의 정확한 호출 위치를 연결하고 현재 callee의 abstract identity, positional arity, argument domain을 확인한다.
4. 반환/throw 의존성을 그 call site의 인자에 대입한다. heap 효과는 보수적 havoc, unknown 효과는 기존 unknown 상태를 유지한다.
5. 호출의 적용/거절 상태, pack/model ID, pack version/content SHA-256, 대상 버전, 가정을 DB에 남긴다. wrapper summary와 parameter impact에도 사용한 계약을 전파한다.

현재 지원하는 정밀 호출은 named import 및 추적 가능한 alias다. namespace/default import의 property callable, receiver dispatch, keyword/spread argument, resource acquisition/close/drop, framework callback 및 async envelope는 정밀 모델 적용을 확대하기 전까지 경계로 남는다. 모델 선택이 성공해도 callable proof가 없으면 `callee-not-proven`이다.

## 기본 pack과 근거

`cxt.stdlib@1.0.0`의 19개 계약:

| 대상 | 계약 | 인자 조건 | 문서에 맞춘 적용 구간 |
|---|---|---|---|
| Node `node:path` / `path` | basename, dirname, extname, normalize, isAbsolute | string 1개 | 22.0.0 이상, 27.0.0 미만 |
| Python `math` | isfinite, isinf, isnan, sqrt, fabs, floor, ceil | number 1개 | 3.12.x |
| Rust `std::cmp` | min, max | number 2개 | 1.85.0 이상, 1.98.0 미만 |

[Node path](https://nodejs.org/api/path.html)는 platform에 따라 결과 문자열이 달라지므로 실제 문자열을 계산하지 않고 string/boolean으로 요약한다. [Python math](https://docs.python.org/3.12/library/math.html)는 객체의 변환 protocol이 실행될 수 있어 숫자 조건을 요구한다. [Rust min](https://doc.rust-lang.org/std/cmp/fn.min.html)과 [max](https://doc.rust-lang.org/std/cmp/fn.max.html)는 `Ord`를 호출하므로 사용자 정의 타입을 pure numeric 계약으로 적용하지 않는다. 기본 모델은 예외 가능성을 보수적으로 유지한다. 이 버전 구간은 실제로 모든 버전을 실행해 검증했다는 뜻이 아니다.

## 사용자 pack

`packs`는 프로젝트 경로 기준 JSON 파일을 가리킨다. 실행 코드나 regular expression을 로드하지 않는다. 전체 schema는 공개 `modelPackSchema`와 `modelConfigSchema`이며 unknown field, 중복 ID, 잘못된 버전 구간, 범위를 벗어나거나 중복된 dependency index는 오류다. 참조 파일이 없거나 검증에 실패하면 scan을 시작하지 않는다. 각 JSON은 최대 1 MiB다.

```json
{
  "schemaVersion": 1, "id": "project.api", "version": "1.0.0",
  "models": [{
    "id": "score", "language": "typescript", "module": "scoring", "symbol": "score",
    "package": "npm:scoring", "versions": { "min": "1.0.0", "before": "2.0.0" },
    "parameters": ["number"],
    "returns": { "type": "number", "dependsOn": [0] },
    "effects": "none", "throws": { "possible": true, "dependsOn": [0] },
    "source": "https://example.com/scoring-contract"
  }]
}
```

사용자 pack의 의미 정확도는 선언자의 책임이며 schema 검증으로 그 사실을 증명하지 않는다. `any` domain은 모든 값에서 계약이 유효하다는 선언이다. `effects`는 `none|heap|unknown`, 반환형은 primitive 또는 `unknown`이다. 특정 인자가 반환값에 영향을 준다는 관계가 identity 함수임을 뜻하지 않는다. 예제는 스키마 설명용이며 기본 pack에 포함되지 않는다.

DB v8의 `code_call_sites.external_json`은 import identity, `code_model_manifests`는 프로젝트 계약 manifest를 저장한다. 이전 snapshot은 rescan 전까지 identity나 모델이 생기지 않는다. facts/manifest는 한 transaction으로 교체한다. `flow --json --strict`는 적용 근거와 거절 이유를 노출하고 partial summary는 exit 2다. 조건을 충족한 complete 결과도 위 가정에 조건부다.
