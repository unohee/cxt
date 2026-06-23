#!/usr/bin/env bash
set -uo pipefail
# Created: 2026-06-23
# Purpose: cxt 다축 벤치 매트릭스 — repo × task × model × condition(on/off).
#          v1(단일 콜그래프 태스크)의 cherry-pick 한계를 깨기 위해 cxt가 강/중/약인
#          태스크 3종 + 외부 저장소 + 2모델로 확장. README/BENCHMARK.md 공개용 정직 데이터.
# Dependencies: claude >=2.1.177, jq, cxt(글로벌). bash 3.2 호환(declare -A 미사용).
# Test Status: v2. smoke→full 2단계 권장.
#
# 사용법:
#   # smoke (1셀 검증)
#   REPOS=cxt TASKS=callgraph MODELS=claude-sonnet-4-6 RUNS=1 ./cxt_bench_matrix_260623_v2.sh
#   # full
#   RUNS=3 ./cxt_bench_matrix_260623_v2.sh
#
# 태스크 3종 (cxt 이득 가설):
#   callgraph (강) : impact 한 방 vs grep 멀티홉 추적
#   untested  (중) : cxt check --untested 한 방 vs 전수 탐색
#   explain   (약) : 결국 함수 본문 Read 필요 — cxt는 위치만 단축, 이득 최소
#
# 메트릭(정직성): total(net, cxt 자기호출 Bash 포함) · explore(Read+Grep+Glob) ·
#   cxt_cmds · billed_in(input+cache) · out. explore 단독 보고 금지.

# ---- 축 정의 (공백 구분, 환경변수로 부분 실행) ----
REPOS="${REPOS:-cxt openswarm}"
TASKS="${TASKS:-callgraph untested explain}"
MODELS="${MODELS:-claude-sonnet-4-6 claude-opus-4-8}"
RUNS="${RUNS:-3}"
PER_RUN_TIMEOUT="${PER_RUN_TIMEOUT:-300}"

# ---- 저장소별 매핑 (bash 3.2: case 함수) ----
repo_path() { case "$1" in
  cxt) echo "/Users/unohee/dev/cxt";;
  openswarm) echo "/Users/unohee/dev/openswarm";;
  *) echo "";; esac; }
cg_entity() { case "$1" in   # 콜그래프 대상 (impact 결과 풍부한 실재 심볼)
  cxt) echo "rowsToEntities";;
  openswarm) echo "executeTool";;
  *) echo "";; esac; }
rd_entity() { case "$1" in   # explain 대상 (적당한 본문 길이의 함수)
  cxt) echo "resolveRelations";;
  openswarm) echo "executeTool";;
  *) echo "";; esac; }

model_short() { case "$1" in   # 라벨용 짧은 모델명
  *sonnet*) echo "sonnet";;
  *opus*) echo "opus";;
  *haiku*) echo "haiku";;
  *) echo "$1";; esac; }

task_prompt() { local task="$1" repo="$2"; case "$task" in
  callgraph) echo "In this repository I am considering changing the signature of the function '$(cg_entity "$repo")'. List every entity (function or class) that would be affected — all transitive callers across the codebase. Output ONLY the final deduplicated list of names. Do NOT modify any files.";;
  untested)  echo "List 10 functions in this repository that have NO tests covering them. Output each line as 'name — filepath'. Do NOT modify any files.";;
  explain)   echo "Read the implementation of the function '$(rd_entity "$repo")' in this repository and summarize what it does in exactly 3 bullet points. Do NOT modify any files.";;
  *) echo "";; esac; }

OFF_NOTE=" Important: the 'cxt' command is unavailable in this environment; rely only on reading and searching files."

TS=$(date +%y%m%d_%H%M%S)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTDIR="${OUTDIR:-$SCRIPT_DIR/matrix_$TS}"
mkdir -p "$OUTDIR"

# cxt-off: PATH 앞 shim 으로 cxt 차단
SHIM="$OUTDIR/shim"; mkdir -p "$SHIM"
cat > "$SHIM/cxt" <<'SHIMEOF'
#!/usr/bin/env bash
echo "cxt: disabled for this benchmark condition — use Read/Grep/Glob" >&2
exit 127
SHIMEOF
chmod +x "$SHIM/cxt"

CSV="$OUTDIR/results.csv"
echo "repo,task,model,cond,run,total,explore,read,grep,glob,bash,cxt_cmds,billed_in,out" > "$CSV"

run_cell() {  # repo task model cond run
  local repo="$1" task="$2" model="$3" cond="$4" run="$5"
  local rpath; rpath="$(repo_path "$repo")"
  local prompt; prompt="$(task_prompt "$task" "$repo")"
  local pathprefix="" extra=""
  if [ "$cond" = "off" ]; then pathprefix="$SHIM:"; extra="$OFF_NOTE"; fi
  local label="${repo}_${task}_$(model_short "$model")_${cond}_r${run}"
  local out="$OUTDIR/${label}.jsonl"
  ( cd "$rpath" && PATH="${pathprefix}${PATH}" \
      timeout "$PER_RUN_TIMEOUT" claude -p "${prompt}${extra}" \
        --output-format stream-json --verbose \
        --model "$model" \
        --dangerously-skip-permissions \
        --disallowedTools Edit Write NotebookEdit \
        > "$out" 2>"$OUTDIR/${label}.err" )
  local rc=$?
  [ $rc -ne 0 ] && echo "    [warn] $label rc=$rc" >&2
  parse "$out" "$repo" "$task" "$(model_short "$model")" "$cond" "$run"
}

parse() {  # file repo task model cond run
  local f="$1" repo="$2" task="$3" model="$4" cond="$5" run="$6"
  if [ ! -s "$f" ]; then echo "$repo,$task,$model,$cond,$run,0,0,0,0,0,0,0,0,0" >> "$CSV"; return; fi
  local tools; tools=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' "$f" 2>/dev/null)
  local total read_c grep_c glob_c bash_c explore cxtcmd
  total=$(printf '%s\n' "$tools" | grep -c . || true)
  read_c=$(printf '%s\n' "$tools" | grep -cx 'Read' || true)
  grep_c=$(printf '%s\n' "$tools" | grep -cx 'Grep' || true)
  glob_c=$(printf '%s\n' "$tools" | grep -cx 'Glob' || true)
  bash_c=$(printf '%s\n' "$tools" | grep -cx 'Bash' || true)
  explore=$((read_c + grep_c + glob_c))
  cxtcmd=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command // empty' "$f" 2>/dev/null | grep -c 'cxt ' || true)
  local u in_t cc cr out_t billed
  u=$(jq -c 'select(.type=="result") | .usage' "$f" 2>/dev/null | tail -1)
  in_t=$(echo "$u" | jq -r '.input_tokens // 0' 2>/dev/null); cc=$(echo "$u" | jq -r '.cache_creation_input_tokens // 0' 2>/dev/null)
  cr=$(echo "$u" | jq -r '.cache_read_input_tokens // 0' 2>/dev/null); out_t=$(echo "$u" | jq -r '.output_tokens // 0' 2>/dev/null)
  billed=$(( ${in_t:-0} + ${cc:-0} + ${cr:-0} ))
  echo "$repo,$task,$model,$cond,$run,$total,$explore,$read_c,$grep_c,$glob_c,$bash_c,$cxtcmd,$billed,${out_t:-0}" >> "$CSV"
}

# ---- 매트릭스 실행 ----
total_cells=0
for repo in $REPOS; do for task in $TASKS; do for model in $MODELS; do for run in $(seq 1 "$RUNS"); do
  total_cells=$((total_cells + 2)); done; done; done; done
echo "▶ cxt 매트릭스 벤치  repos=[$REPOS]  tasks=[$TASKS]  models=[$MODELS]  runs=$RUNS"
echo "  총 $total_cells 셀 (on+off)  out=$OUTDIR"; echo

n=0
for repo in $REPOS; do
  for task in $TASKS; do
    for model in $MODELS; do
      for run in $(seq 1 "$RUNS"); do
        for cond in on off; do
          n=$((n + 1))
          echo "  [$n/$total_cells] $repo/$task/${model##*-}/$cond r$run"
          run_cell "$repo" "$task" "$model" "$cond" "$run"
        done
      done
    done
  done
done

echo; echo "════════ 집계 (repo·task·model·cond 평균) ════════"
awk -F, 'NR>1 {
  k=$1"|"$2"|"$3"|"$4; c[k]++; tot[k]+=$6; expl[k]+=$7; cx[k]+=$12; bin[k]+=$13; o[k]+=$14
}
END {
  printf "%-9s %-9s %-7s %-4s %7s %7s %7s %10s %7s\n","repo","task","model","cond","total","explore","cxt","billed_in","out"
  for (k in c) { split(k,a,"|");
    printf "%-9s %-9s %-7s %-4s %7.1f %7.1f %7.1f %10.0f %7.0f\n", a[1],a[2],a[3],a[4], tot[k]/c[k], expl[k]/c[k], cx[k]/c[k], bin[k]/c[k], o[k]/c[k] }
}' "$CSV" | sort
echo; echo "CSV: $CSV"
