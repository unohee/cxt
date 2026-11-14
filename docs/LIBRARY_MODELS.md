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

현재 지원하는 정밀 호출은 named import, namespace/default import의 정적 property callable 및 추적 가능한 alias다. namespace/default property는 resolver가 외부 identity를 증명하고 `unmodified-external-bindings` 가정이 유지될 때만 모델 callee로 승격한다. Node `EventEmitter`의 external instance에 대한 `on`/`addListener`/`once`/`prependListener`/`prependOnceListener` registration도 callback target과 명시적 input mapping 범위에서 지원한다. 일반 receiver dispatch, keyword/spread argument, framework별 callback semantics 및 async envelope는 여전히 경계로 남는다. 모델 선택이 성공해도 callable proof가 없으면 `callee-not-proven`이다.

Variadic model은 `taint.propagatesVariadic`를 선언해 고정 arity 뒤의 positional argument taint를 반환값에 보존할 수 있다. 이 플래그는 `variadic: true` model에서만 허용되며, spread/dynamic argument의 실제 shape나 alias는 추론하지 않는다. Node `path.join`/`path.resolve`와 path 변환 함수는 이 계약으로 환경·파일 입력의 taint를 유지한다.

EventEmitter model은 registration API의 event parameter와 `emit`의 payload parameter를 별도 contract로 선언할 수 있다. 현재 이 contract는 receiver와 event name이 정적으로 증명되는 같은 dataflow state에서만 사용할 수 있도록 제한되어 있으며, listener removal, scheduler ordering, cross-function dispatch, payload type narrowing 및 callback exception envelope는 추론하지 않는다.

`unmodified-external-bindings` 가정으로 선택된 모델은 effectful call 뒤에도 proven external callable identity를 유지한다. 따라서 같은 imported API의 반복 호출이 앞선 unknown effect 때문에 `callee-not-proven`으로 연쇄 하락하지 않는다. 외부 데이터와 heap effect의 보수적 havoc는 유지한다.

### Callback registration 계약

모델은 `callbacks: [{"parameter": 1, "arguments": [0]}]`로 callback으로 등록되는 positional argument와 callback에 전달할 caller argument positions를 명시할 수 있다. numeric `parameter`/`arguments`는 model arity 안에서 유효하고 argument index는 중복될 수 없으며, 위반한 pack은 로드 단계에서 거부된다. `taintArguments`를 선언하면 외부 API가 callback에 공급하는 opaque 데이터 인자를 taint source로 표시할 수 있다. 분석기는 해당 argument가 정적으로 증명된 function target이면 `FlowCall.callbacks`에 target을 남기고, 모델 callback summary가 sink formal을 선언한 경우 registration 지점에서 taint를 callback sink까지 연결한다. wrapper는 `FunctionSummary.callbackParameters`로 formal parameter provenance를 전달하고, 저장소 snapshot에는 등록 주체에서 callback target으로 `registers` relation도 기록한다. 이 fact는 명시된 callback input mapping을 증명하지만 scheduler의 실제 재호출 순서나 async envelope를 의미하지 않는다.

기본 Node model pack에는 `node:timers`의 `setTimeout`/`setInterval`/`setImmediate`와 `node:process.nextTick`을 explicit callback registration API로 포함한다. 이 모델은 선언된 callback prefix 뒤의 추가 positional arguments를 `variadic` 계약으로 허용하고, `variadicArgumentsFrom`이 있으면 해당 extra arguments를 callback dataflow 입력으로 연결한다. 이 mapping은 wrapper summary에도 formal parameter 목록으로 보존되어 wrapper 뒤 sink까지 연결된다. 실제 timer ordering·cancellation·async exception envelope는 여전히 모델링하지 않는다.

Python standard pack은 `builtins.open`을 `path` positional prefix와 variadic mode/options로 모델링하고, 반환값을 `enter: same` resource로 선언한다. `suppress: never`도 명시해 모델 적용과 argument/callee proof가 성공한 `with`/`async with`에서 `__exit__`/`__aexit__`의 예외 억제 경로를 제거한다. `contextlib.suppress`는 `enter: unknown`, `suppress: possible`로 모델링한다. Python의 정적으로 식별 가능한 exact exception constructor(`raise ValueError`, `raise ValueError()`)와 handler/suppress argument를 비교하고, 닫힌 built-in hierarchy(`ValueError <: Exception <: BaseException`)와 파일 내부에서 명시된 단일·다중 class base(`class MyError(ValueError, OSError)`)를 적용해 일치하는 예외 경로만 억제한다. 동적 예외·외부/unresolved 사용자 hierarchy·unknown cleanup exception은 양쪽 경로를 유지한다. 파일 close의 예외·flush protocol과 descriptor alias의 전체 semantics는 별도 모델 없이는 추론하지 않는다.

### Taint source/sink 계약

모델은 `taint: {"source": true}`, `{"sinkParameters": [0]}`, `{"propagatesParameters": [0]}`, `{"sanitizesParameters": [0]}`를 명시할 수 있다. source의 반환값에는 `tainted` atom이 붙고 wrapper 반환을 통해 전달된다. `propagatesParameters`는 해당 인자의 taint를 반환값에 보존하고, `sanitizesParameters`는 해당 인자의 taint를 반환값에서 제거한다. 기본 dataflow는 `+`, `-`, `*`, `/`, `%`, nullish fallback(`??`), TypeScript non-null assertion(`!`)과 opaque expression의 결과에도 입력 taint를 보존하므로 `source() + suffix`, `source() ?? fallback`, `source()!` 같은 단순 변환은 별도 모델 없이 sink까지 추적한다. Node global `JSON.parse`/`JSON.stringify`도 external global binding일 때 명시적 propagator로 taint를 입력에서 반환값으로 보존한다. `undefined`/boolean predicate는 데이터가 아니므로 taint를 전달하지 않는다. 사용자 함수가 모델 sink를 감싸면 formal parameter provenance를 summary의 `taintSinkParameters`로 승격해 caller의 taint도 sink finding으로 연결한다. finding은 source definition ID를 보존하며 `cxt flow --sarif`가 이를 source-to-sink `codeFlows`로 출력한다. sink argument에 taint가 도달하면 `DataflowResult.taintFindings`와 `FlowCall.taintFindings`에 기록되고 `cxt flow --sarif`의 `cxt/taint-sink` result로 출력된다. 기본 계약은 positional이고, `parameterNames`가 선언된 Python 모델은 keyword argument를 해당 parameter index에 매핑한다. 이름 기반 source/sink 추론과 자동 sanitizer·복합 변환 추론은 하지 않는다.

### Resource 계약 (schema v1)

모델은 선택적으로 `resource`를 선언할 수 있다. 계약은 generic `__enter__`/`__exit__` 추론을 켜지 않으며, 정확히 식별된 외부 API 호출의 lifecycle 사실만 표현한다.

```json
"resource": { "action": "acquire", "identity": "return", "enter": "same", "suppress": "never" }
```

`action`은 `acquire|release`, `identity`는 `return|receiver|argument`다. `identity=argument`일 때만 `parameter`가 필요하며, arity 밖 index는 거부된다. acquire 계약은 선택적으로 `enter=same|unknown`을 선언할 수 있다. `same`일 때만 `with ... as alias`에 manager resource identity를 전달하고, `unknown` 또는 생략 시 alias는 보수적 unknown으로 남긴다. `suppress`는 `never|possible|always`이며 실제 인자·callee proof를 통과한 모델에만 suppression branch를 적용한다. dataflow는 적용된 계약의 acquire/release event와 resource identity를 결과에 보존하고, 추적 가능한 resource의 use-after-release와 종료 시 leak 후보를 `resourceFindings`로 보고한다. 예외 가능성이나 unknown effect가 있으면 `possible`로 낮추며, generic context manager는 계속 partial이다. Python `with`의 manager call이 이 계약을 적용받는 경우 cleanup node가 동일한 manager temporary를 release 경계로 사용한다.

### Ownership 계약 (schema v1)

모델은 선택적으로 `ownership`을 선언해 Rust API가 formal argument를 consume하는지 명시할 수 있다.

```json
"ownership": { "moves": [0], "borrows": [] }
```

`moves`와 `borrows`는 formal parameter index 배열이며 중복·범위 밖 index와 두 배열의 중복 index는 거부된다. 적용된 `moves` 계약은 actual argument가 증명된 heap/resource identity일 때 caller state를 moved로 전환하고 이후 `use-after-move`를 보고한다. primitive Copy 값, 명시적 `&value` borrow, 계약이 없는 호출은 자동으로 move로 추론하지 않는다.
Rust flow는 추가로 literal-only fixed array/tuple을 Copy로 처리하고, trait 증명이 없는 struct expression은 non-Copy로 보수적으로 처리한다. 이는 `Copy` trait 전체를 해석하는 모델이 아니다.
모델 summary에는 두 배열이 각각 `movesParameters`와 `borrowsParameters`로 남는다. wrapper가 모델 호출을 전달할 때도 formal index를 caller parameter로 remap하며, borrow는 state를 변경하지 않는 계약으로만 기록된다.

## 기본 pack과 근거

`cxt.stdlib@1.0.0`의 47개 계약:

| 대상 | 계약 | 인자 조건 | 문서에 맞춘 적용 구간 |
|---|---|---|---|
| Node `node:path` / `path` | basename, dirname, extname, normalize, isAbsolute | string 1개 | 22.0.0 이상, 27.0.0 미만 |
| Python `math` | isfinite, isinf, isnan, sqrt, fabs, floor, ceil | number 1개 | 3.12.x |
| Python `html` | escape (taint sanitizer) | string 1개 | 3.12.x |
| Python `shlex` | quote (command taint sanitizer) | string 1개 | 3.12.x |
| Python `builtins` | open (resource acquire, `enter=same`, `suppress=never`) | string 1개 + variadic | 3.12.x |
| Python `contextlib` | suppress (resource acquire, `enter=unknown`, `suppress=possible`) | any 1개 + variadic | 3.12.x |
| Python `builtins` | input (taint source) | string 1개 + variadic | 3.12.x |
| Python `builtins` | eval, exec, compile (dynamic-code sink/propagator) | any 1개 + variadic | 3.12.x |
| Python `os` | getenv (environment taint source) | string 1개 + variadic | 3.12.x |
| Python `subprocess` | run, Popen (command taint sink, unknown effect) | any 1개 + variadic | 3.12.x |
| Python `os` | system, popen (command taint sink, unknown effect) | any 1개 + variadic | 3.12.x |
| Python `os.path` | join (variadic taint propagator), basename, dirname, normpath, abspath | string 1개 + variadic for join | 3.12.x |
| Node `node:path`/`path` | join, resolve (variadic taint propagator), basename, dirname, extname, normalize, isAbsolute | string 1개 + variadic for join/resolve | 22.0.0 이상, 27.0.0 미만 |
| Node `node:child_process` | exec, execFile, execSync, spawn, spawnSync (command taint sink, unknown effect) | string 1개 + variadic | 22.0.0 이상, 27.0.0 미만 |
| Node `node:fs` | readFileSync (opaque file-content taint source, unknown effect) | string 1개 + variadic | 22.0.0 이상, 27.0.0 미만 |
| Node `node:fs` | readFile (callback data taint, unknown effect; path+callback overload) | string, any + variadic | 22.0.0 이상, 27.0.0 미만 |
| Node `node:fs/promises` | readFile (opaque file-content taint source, unknown effect) | string 1개 + variadic | 22.0.0 이상, 27.0.0 미만 |
| Node global | eval, Function (taint sink, unknown effect) | any 1개 + variadic | 22.0.0 이상, 27.0.0 미만 |
| Node `node:vm` | runInThisContext, runInNewContext, runInContext, compileFunction (dynamic-code taint sink, unknown effect) | any 1개 + variadic | 22.0.0 이상, 27.0.0 미만 |
| Rust `std::cmp` | min, max | number 2개 | 1.85.0 이상, 1.98.0 미만 |
| Rust `std::mem` | drop | any 1개, moves `[0]` | 1.85.0 이상, 1.98.0 미만 |

[Node path](https://nodejs.org/api/path.html)는 platform에 따라 결과 문자열이 달라지므로 실제 문자열을 계산하지 않고 string/boolean으로 요약한다. [Python math](https://docs.python.org/3.12/library/math.html)는 객체의 변환 protocol이 실행될 수 있어 숫자 조건을 요구한다. [Rust min](https://doc.rust-lang.org/std/cmp/fn.min.html)과 [max](https://doc.rust-lang.org/std/cmp/fn.max.html)는 `Ord`를 호출하므로 사용자 정의 타입을 pure numeric 계약으로 적용하지 않는다. 기본 모델은 예외 가능성을 보수적으로 유지한다. 이 버전 구간은 실제로 모든 버전을 실행해 검증했다는 뜻이 아니다.

Python `html.escape`는 명시적 taint sanitizer contract로 제공한다. 입력의 실제 module/symbol과 선언된 Python 3.12 버전이 일치할 때만 taint를 제거하며, 함수 이름이나 문자열 패턴만으로 sanitizer를 추론하지 않는다. taint label은 runtime type이 아니므로 모델 argument-domain 검증에서 별도 metadata로 제외한다.

Python `shlex.quote`도 동일한 명시적 contract로 command taint를 제거한다. shell이 실제로 어떤 방식으로 호출되는지, quoting 결과가 모든 downstream shell API에서 안전한지, command parsing이 어떻게 수행되는지는 자동으로 증명하지 않는다.

Python `builtins.input`은 taint source, `builtins.eval`은 taint sink로 모델링한다. 두 계약 모두 정확한 external identity와 Python 3.12 버전이 필요하다. `eval`의 unknown effect는 보수적으로 유지되므로 finding과 함께 분석 결과가 partial일 수 있다.

Python `os.getenv`는 environment taint source, `subprocess.run`은 command taint sink로 모델링한다. `subprocess.run`의 unknown effect는 유지하며, shell 사용 여부나 argument list의 실제 실행 semantics를 자동으로 추론하지 않는다.

Python `os.path.join`과 Node `path.join`/`path.resolve`는 고정된 첫 인자뿐 아니라 선언된 arity 뒤의 정적 positional argument taint도 반환값에 보존한다. 경로 정규화 결과, platform separator, filesystem 존재 여부는 계산하지 않는다.

Python `subprocess.Popen`, `os.system`, `os.popen`도 command taint sink으로 모델링한다. 첫 command 인자의 taint만 기록하고 process lifecycle, shell/list semantics, stream/return object 동작은 추론하지 않는다.

Python `builtins.exec`도 `eval`과 동일한 dynamic-code taint sink contract를 사용한다. unknown effect는 유지하고 local `exec` shadowing은 승격하지 않는다.

Python `builtins.compile`은 첫 source 인자의 taint를 반환값으로 명시적으로 전달하는 propagator다. `input → compile → exec` chain은 compile call 자체를 pure effect model로 기록하지만, 실행 namespace와 generated-code semantics는 추론하지 않는다.

Python external `os.environ` member read도 intrinsic environment taint source로 처리한다. `os.environ['KEY']`와 후속 member read는 source provenance를 유지하지만, 실제 key 존재 여부와 environment mutation은 추론하지 않는다. local/parameter `os` shadowing에는 적용하지 않는다.

Node `node:child_process.exec`는 command taint sink로 모델링한다. Node runtime version과 external identity가 맞을 때만 적용하며, shell options, callback scheduling, command parsing은 추론하지 않고 unknown effect로 남긴다.

Node `node:child_process`의 `execFile`, `execSync`, `spawn`, `spawnSync`도 동일한 command taint sink 계약을 사용한다. 첫 번째 command/path 인자만 sink로 표시하고, argument 배열·shell 옵션·child-process lifecycle은 해석하지 않으며 unknown effect를 유지한다.

`node:timers.setTimeout`과 `setInterval`은 callback registration과 함께 첫 인자가 tainted string일 때 dynamic-code sink으로도 기록한다. 함수 callback 자체는 sink finding을 만들지 않으며, timer ordering·cancellation·async exception envelope는 여전히 모델링하지 않는다.

Node `node:fs.readFileSync`는 opaque file-content taint source로 모델링한다. 반환값은 Buffer/string encoding 선택을 구분하지 않는 unknown abstract value이며, 실제 파일 존재·권한·I/O 결과는 분석하지 않는다.

Node global `eval`은 무수입 external binding일 때만 taint sink로 모델링한다. local `eval` 선언은 lexical target으로 유지하며 자동 sink로 승격하지 않는다.

Node global `Function` 호출과 `new Function(...)` constructor를 동일한 동적 code sink으로 모델링한다. 정확히 global `Function` constructor일 때만 일반 call model로 낮추며, 다른 constructor의 allocation semantics는 변경하지 않는다.

Node `node:vm`의 `runInThisContext`, `runInNewContext`, `runInContext`, `compileFunction`은 첫 code 인자를 dynamic-code taint sink으로 모델링한다. VM context, timeout, generated function semantics와 실행 순서는 unknown effect로 유지한다.

Node `node:fs.readFile(path, callback)`은 callback의 두 번째 인자(data)를 opaque external taint로 전달한다. callback 위치는 `last` 계약으로 표현해 `options`를 포함한 overload도 callback target을 잃지 않게 한다. Buffer/string encoding, 파일 존재·권한·I/O 및 callback scheduler semantics는 추론하지 않는다.

Node `node:fs/promises.readFile`도 opaque file-content taint source로 모델링한다. 반환값의 Promise/Buffer/string 구체 타입과 실제 파일 I/O 결과는 추론하지 않는다.

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

사용자 pack의 의미 정확도는 선언자의 책임이며 schema 검증으로 그 사실을 증명하지 않는다. `any` domain은 모든 값에서 계약이 유효하다는 선언이다. `effects`는 `none|heap|unknown`, 반환형은 primitive 또는 `unknown`이다. `ownership.moves`는 Rust의 명시적 consuming API에만 사용하며, `ownership.borrows`와 같은 index를 중복 선언할 수 없다. 특정 인자가 반환값에 영향을 준다는 관계가 identity 함수임을 뜻하지 않는다. 예제는 스키마 설명용이며 기본 pack에 포함되지 않는다.

DB v8의 `code_call_sites.external_json`은 import identity, `code_model_manifests`는 프로젝트 계약 manifest를 저장한다. 이전 snapshot은 rescan 전까지 identity나 모델이 생기지 않는다. facts/manifest는 한 transaction으로 교체한다. `flow --json --strict`는 적용 근거와 거절 이유를 노출하고 partial summary는 exit 2다. 조건을 충족한 complete 결과도 위 가정에 조건부다.
