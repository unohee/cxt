# AST 및 dataflow 규칙 — AGT-4570

## 실행 계약

`cxt bs`와 `cxt audit`는 TS/TSX/JS/JSX/Python/Rust 소스를 현재 파일에서
파싱한다. 구형 20개 패턴을 AST predicate로 옮겼고, `cxt/uninitialized-read`를
추가했다. `src/analysis/rulePack.ts`가 ID, version, severity, rationale,
지원 언어, path role, positive/negative fixture의 정본이다.
`precision: high|medium|low`는 `precisionBasis: policy-estimate`인 정책 판단이며
실측 확률이 아니다. JSON에 실제 source span과 규칙 정보를 포함한다.

구문 오류는 scan error다. native parser가 없을 때 auto 모드는 이전 lexical
규칙을 실행하고 partial 진단을 남긴다. `CXT_PARSER=ast`는 fallback을 허용하지
않는다. Go/Java/C/C++/C#과 명시적 lexical 모드도 partial이다.
공개 API `analyzeFileContent`는 엔진/완전성/진단을 반환한다.
`scanFileContent`는 호환성 때문에 finding 배열만 반환한다.

`uninitialized-read`는 완료된 함수 내부 dataflow에서 해당 read의 모든 abstract
value가 uninitialized일 때만 나온다. definition ID와 entry/read source span을
함께 반환한다. 글로벌 변수, runtime 전체 의미, 미지원 구문을 안전하다고 판정하지
않는다. CFG 또는 effect lowering이 partial인 함수는 solver 전에 진단하고,
solver 예산을 넘은 함수도 확정 finding을 내지 않는다. 구조적 규칙은 이와 별도로
실행한다. 따라서 파일의 partial 상태와 구조적 finding은 함께 존재할 수 있다.

`bs`는 critical/warning, `audit`는 critical을 finding 정책 실패로 본다.
AGT-4571에서 complete pass/finding/partial/tool failure를 exit 0/1/2/3으로
구분하고 SARIF를 추가했다. [출력 계약](ANALYSIS_REPORTS.md)을 참고한다.

## 경로와 suppression

기본 역할은 production/test/fixture/tooling/configuration이며 규칙마다 제외 역할이
다르다. 예를 들어 success log와 console log는 tooling에서 제외되고,
Python `except: pass`와 debugger는 test에서도 검사한다.
`.cxt-rules.json`으로 상대 경로의 역할을 명시할 수 있다.

```json
{
  "schemaVersion": 1,
  "roles": [{ "prefix": "custom/commands", "role": "tooling" }]
}
```

경로 경계를 검사하며 가장 긴 prefix가 우선한다. `../`, 절대 경로, 중복 prefix,
알 수 없는 필드는 거부한다. 이 파일은 역할 설정이며 임의 JavaScript 실행이나
동적 query pack 로딩을 지원하지 않는다. `rulePackSchema`는 metadata 계약이다.

`cxt-ignore[: category]` 및 `cxt-ignore-next-line[: category]`는 AST comment에서만
작동한다. 문자열과 regex 안의 가짜 마커는 무시한다. template/f-string 내부의
실행식은 검사하지만 설명용 문자열에 적힌 코드 예제는 실행 코드로 보지 않는다.
credential finding의 matched text는 literal을 가린다.

## 이식 시 의도적인 의미 변경

- success log는 성공을 확인한 증거가 없다는 **검토 후보**다. 로그 한 줄만으로
  가짜 실행을 입증했다고 쓰지 않는다. 기존 critical 정책과 rationale은 유지한다.
- catch의 모든 구조적 경로를 확인한다. nested callback의 throw는 바깥 handler의
  전파로 세지 않는다. 조기 return을 뒤의 throw로 덮어쓰지 않는다. 타입에 근거한
  함수 의미를 증명하는 규칙은 아니므로 shadowed reject 등의 한계가 있다.
- Rust `partial_cmp(...).unwrap()`를 자동 면제하던 동작을 제거했다.
  [`PartialOrd` 공식 계약](https://doc.rust-lang.org/std/cmp/trait.PartialOrd.html)에서
  NaN 비교는 None을 반환할 수 있다. `unwrap_or` 및 명시적 SAFETY 설명은 유지한다.
- 구형 regex 테스트의 괄호가 닫히지 않은 코드, JS backtick으로 작성한 Rust 코드,
  단독 `else` 같은 불완전 fixture를 실제 문법에 맞게 고쳤다. 회귀 의미를 유지하고
  syntax-error 실패를 별도로 검사한다.
- magic number는 named constant(비공개 `_CONST`와 container 포함), 명시적 숫자
  domain 변수, slice/default parameter, HTTP status 문맥, 좁은 IPv4 projection을
  제외한다. 숫자 범위만 보고 HTTP 코드를 면제하지 않는다. 일반 변수 `admin/items`를
  `min/ms` substring 때문에 제외하던 형태도 허용하지 않는다.

## 검증과 남은 경계

`npm run bench:rules`는 21개 규칙의 positive/negative 42개 수기 fixture를 검사한다.
규칙별 precision/recall, 누락/추가/중복 finding과 source span, partial fixture를
보고한다. 정답은 해당 fixture가 지정한 rule에 대한 라벨이며 다른 규칙의 finding이
전혀 없다는 정답이 아니다. 개발 합성 자료로 CodeQL 동등성이나 실세계 정밀도를
입증하지 않는다. 원자료는 `bench/rule-baseline.json`이다.

2026-09-27 최신 전체 BS 측정: 91 files, critical 0 / warning 120 / minor 53,
scan errors 0, 52.586초. 분석은 partial이며 unsupported-effect 280 / work-budget 23 /
partial-cfg 1 진단이 있다. 정상 소스의 definite-uninitialized finding은 0개다.
증거: `/tmp/cxt-rules-verified-de3LoW`. 같은 프로세스의 fact DB scan은 60.706초에
timeout으로 rollback했다. registry total 0은 성공적으로 빈 소스를 분석한 결과가
아니다. 프로세스 전체 max RSS는 899,868 KiB이며 BS 단독 메모리 수치가 아니다.

이전 BS 구현은 60초에 49개 파일만 처리했다(`.../cxt-semantic-rules-fv5ExZ`).
partial 함수에서 버릴 결과를 미리 계산하지 않도록 바꿔 36.484초를 측정했다
(`...-QFzUSM`). 여기서 발견된 uninitialized 36개는 object property를 lexical 변수로
취급하던 심볼 결함이었다. member-only scope를 분리하고 호출 target/caller 및
실제 TDZ 양성 검사를 추가한 후 최신 재측정에서 모두 사라졌다. 60초 제한은
늘리지 않았다. 전체 fact DB 성능은 AGT-4572의 후속 해결 대상이다.

vega-router는 과거 64파일에서 현재 tracked src/scripts Python 70파일로 달라졌다.
동일 현재 소스의 legacy 44개와 AST 16개 후보를 비교하고 원래 HTTP/IP/상수 false positive
및 `shortlist_models.py:230`의 400 positive를 확인했다. 새 평가 코드와 가격 단위 등
남은 후보는 추가 검토 대상이다. 전체 false positive 비율 ≤20%는 아직 입증하지
않았으며 AGT-3915는 열린 상태다. 테스트 매핑의 정확성도 이 규칙 이식의 결과가 아니다.
