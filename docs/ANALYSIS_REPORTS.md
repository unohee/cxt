# 분석 결과와 SARIF — AGT-4571

```bash
cxt bs --json
cxt bs --sarif > findings.sarif
cxt audit --sarif > audit.sarif
cxt scan --json
cxt scan --sarif > scan.sarif
cxt flow path/to/function --sarif > flow.sarif
```

`--json`과 `--sarif`는 함께 사용할 수 없다. `-v`를 추가해도 machine output의
stdout에는 JSON 문서 하나만 나온다. `check --scan`, `check --bs`, `check --ci`도
각각 scan, bs, audit JSON과 같은 handler를 사용한다.

## 종료 코드

| 코드 | outcome.status | 의미 |
|---:|---|---|
| 0 | complete | 이 분석 범위가 완료됐고 finding 정책을 통과함 |
| 1 | complete | 분석은 완료됐으나 finding 정책을 통과하지 못함 |
| 2 | partial | lexical fallback, 미지원 구문/effect, solver 예산 또는 미해석 의미가 남음 |
| 3 | failed | 구문·설정·파일 읽기·전체 timeout·실행 오류 |

실패 > 부분 분석 > finding 정책 순으로 종료 코드를 고른다. 부분 분석에서 critical을
찾았어도 코드 2이며, `findingsFail: true`와 finding 원문/개수는 남는다. `pass`는 코드
0일 때만 true다. bs는 critical 또는 warning을 정책 실패로 보고, audit는 critical을
정책 실패로 본다. minor는 종료 코드를 올리지 않는다. Commander의 잘못된 명령/옵션
사용 오류는 기존 코드 1이며 분석 실행의 outcome과 별개다.

이전 버전은 partial만 있으면 0, scan error가 있으면 1을 반환했다. 자동화는 새로운
0/1/2/3을 구분해야 한다. registry 조회 명령 `cfg/flow/impact --strict`의 기존
0/2 및 대상 부재 1 계약은 이 변경 대상이 아니다.

BS의 complete는 선택된 규칙의 AST/local-flow 처리 범위에 대한 값이다. 규칙이 모든
결함을 찾았다는 의미가 아니다. fact scan은 parser/CFG/flow/summary partial과
unresolved/external calls를 보수적으로 partial로 표시한다. 모델이 일부 외부 호출에
적용됐어도 전체 외부 호출 의미의 완전성을 입증한 것으로 보지 않는다. 부분 fact
snapshot은 진단과 함께 저장될 수 있으며, 실패한 scan은 이전 snapshot을 보존한다.
audit의 registry 통계는 저장된 메타데이터이고 실제 테스트 coverage나 최신성 증명이 아니다.

## SARIF 2.1.0

정본 형식은 [OASIS SARIF approved errata](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html)다.
전체 draft-04 schema를 `tests/schemas/`에 출처/해시와 함께 보관하고 Ajv와 URI formats로
검증한다. GitHub가 소비하는 필드는 [GitHub SARIF 지원 문서](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support)를 따른다.

- 결과: ruleId/index, severity level, message, source range, rule version/rationale/precision.
- 경로: 프로젝트 상대 URI를 segment별 percent encoding하며 `%SRCROOT%`로 기준을
  명시한다. 저장소 밖 위치는 거부한다. columnKind는 UTF-16 code units이고 끝 위치는
  exclusive다. lexical finding에는 얻지 못한 열 번호를 만들지 않는다.
- fingerprint: rule ID + 상대 파일 + 정규화된 matched text의 SHA-256와 같은 항목의
  source-order ordinal을 `primaryLocationLineHash`로 제공한다. 줄 삽입, checkout 루트,
  메시지 번역, 결과 배열 순서가 바뀌어도 유지한다. 같은 내용의 finding을 앞에 새로
  삽입하면 ordinal이 달라질 수 있고, 파일 rename이나 검사된 텍스트 변경은 별개 결과다.
  matched text가 짧은 요약이므로 전체 소스 내용의 identity hash로 쓰지 않는다.
- dataflow: reaching-definition/read 위치를 relatedLocations와 codeFlows에 싣는다.
  `evidenceKind=definition-read-endpoints`이며 중간 실행 경로 전체를 복원했다고
  주장하지 않는다. 관련 source span은 solver definition에서 가져온다. `flow --sarif`는
  resource acquire/release와 ownership moved-state source CFG node를 각각
  `cxt/resource-*` 및 `cxt/ownership-use-after-move` result로 내보낸다. 이 경로도
  정적 provenance만 제공하며 runtime execution trace를 주장하지 않는다.
- semantic flow 결과의 `primaryLocationLineHash`도 rule/file/normalized source text/provenance의
  SHA-256으로 생성해 line shift와 결과 순서 변화에 안정적인 fingerprint를 유지한다.
- 실행 상태: invocation의 executionSuccessful은 failed에서만 false다. partial 분석은
  실행 자체는 성공했고 결과 coverage가 제한된 상태다. exitCode와 analysisStatus,
  toolExecutionNotifications에 이 차이를 남긴다. 알지 못하는 진단 줄 번호는 만들지 않는다.
- fact scan SARIF는 현재 commit된 flow snapshot의 resource/ownership semantic result를
  포함하며, 불완전 scan에서 보존된 이전 snapshot은 현재 결과로 재사용하지 않는다. 분석
  diagnostics와 fact counts도 포함한다. bs/audit는 같은 finding 목록을 내보내며 audit는
  registry 통계도 포함한다. 개별 함수의 semantic finding은 `flow --sarif`에서
  source/provenance codeFlow와 함께 조회한다.

실제 GitHub 업로드·alert 수용은 실행하지 않았다. schema validation과 CLI 통합 검사는
외부 서비스에서 alert가 승인됐다는 증거가 아니다.
