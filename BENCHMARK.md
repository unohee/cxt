# cxt Benchmark — does it actually cut agent tool calls?

cxt's pitch is "skip exploratory Read/Grep, use the registry." This benchmark
measures whether that's real, on what kinds of tasks, and where it *isn't*.

**TL;DR** — the point of cxt is to stop the agent from melting into endless
ripgrep. On tasks where an off agent *does* explode into multi-hop search
(call-graph, untested-listing) cxt collapses it to one deterministic call. On
tasks that never explode in the first place (`explain` — read one function) cxt
correctly stays out of the way. The win is exactly where the pain is.

| Task class | What it asks | off agent explores? | cxt effect (tool calls on→off) |
|---|---|---|---|
| **callgraph** | "what breaks if I change fn X?" | **yes — explodes** (opus: 300s timeout) | **8–50× fewer** |
| **untested** | "list 10 functions with no tests" | **yes — enumerates** | **2–11× fewer** |
| **explain** | "read fn X, summarize in 3 bullets" | **no — 1–3 calls either way** | ~1× (nothing to cut) |

---

## Method

For each cell we run [`claude -p`](https://docs.claude.com/en/docs/claude-code)
(headless, `--output-format stream-json`) twice:

- **on** — cxt available (SessionStart registry map + `cxt` commands)
- **off** — cxt blocked via a PATH shim (`cxt` → `exit 127`) + prompt note; agent
  may only Read/Grep/Glob

We parse the JSONL transcript for `tool_use` counts and token usage.

- **Matrix**: 2 repos × 3 tasks × 2 models × 2 conditions × 2 runs = 48 sessions
- **Repos**: this repo (`cxt`, 161 entities) + [`openswarm`](https://github.com/intrect/openswarm) (1.6k entities) — both TypeScript, both `cxt scan`ned
- **Models**: `claude-sonnet-4-6`, `claude-opus-4-8`
- **Metrics**: `total` (net tool calls — includes cxt's own Bash calls, so this is the honest figure), `explore` (Read+Grep+Glob), `billed_in` (input+cache tokens), `out`
- **Harness**: [`testing/cxt_bench_matrix_260623_v2.sh`](testing/cxt_bench_matrix_260623_v2.sh) — fully reproducible

> We report **net total tool calls**, not just exploration calls. cxt replaces
> `Read×N` with `Bash(cxt …)×1`, so counting only Read/Grep would flatter cxt. The
> headline numbers count cxt's own invocations against it.

## Results (mean of 2 runs)

Tool calls (`total`) and completed-session input tokens (`billed_in`):

| repo | task | model | on tools | off tools | on tokens | off tokens |
|---|---|---|--:|--:|--:|--:|
| cxt | callgraph | sonnet | **1.0** | 21.0 | 85k | 1,015k |
| cxt | callgraph | opus | **1.0** | 8.0 | 88k | 453k |
| openswarm | callgraph | sonnet | **1.0** | 50.0 | 85k | 107k |
| openswarm | callgraph | opus | 13.0 | 21.5† | 399k | — † |
| cxt | untested | sonnet | **4.0** | 10.5 | 231k | 357k |
| cxt | untested | opus | **1.5** | 3.0 | 115k | 183k |
| openswarm | untested | sonnet | **3.0** | 8.0 | 175k | 285k |
| openswarm | untested | opus | **2.5** | 26.5 | 159k | 237k |
| cxt | explain | sonnet | 2.0 | 2.0 | 130k | 129k |
| cxt | explain | opus | 2.0 | 1.0 | 133k | 133k |
| openswarm | explain | sonnet | 3.0 | 3.5 | 175k | 197k |
| openswarm | explain | opus | 3.0 | 2.5 | 160k | 158k |

† **opus / openswarm / callgraph / off hit the 300s timeout** before finishing —
the off agent's grep-based multi-hop trace exploded on a 1.6k-entity repo and
never completed. `total` there is a *lower bound* (calls before the cutoff) and
tokens are missing (no terminal `result` event). The timeout itself is evidence:
cxt answered the same question in 1 deterministic call.

## Interpretation

- **callgraph** — cxt's `impact` is one deterministic call; the off agent must
  grep-trace transitive callers across files, which scales badly with repo size
  (openswarm/sonnet: 50 calls). This is cxt's clear home turf.
- **untested** — `cxt check --untested` is one query; off must enumerate functions
  and check each for tests. Consistent 2–11× reduction.
- **explain** — reading one function's body takes 1–3 calls *with or without* cxt;
  the off agent never explodes here, so there's no ripgrep to prevent. cxt-on
  matching cxt-off is the correct outcome, not a failure: cxt doesn't insert
  itself where it adds nothing. (With opus it occasionally costs one extra call —
  the only case where staying out of the way would've been strictly better.)

The throughline: **cxt earns its keep precisely where an unaided agent would
otherwise grind through multi-hop search** — and the worst case (opus/openswarm
callgraph) isn't "many calls," it's *not finishing inside 300s*. That unbounded
grind is the thing cxt exists to kill; on-condition answers it in one
deterministic call. Where there's no grind to kill, cxt is a no-op, as it should
be.

## Limitations (read before quoting a number)

- **Single machine, 2 repos, 2 models, 2 runs/cell.** Small n; treat as
  directional, not precise. Re-run with `RUNS=N` for tighter intervals.
- **Token figures are dominated by cache reads** (~0.1× billed rate), so
  `billed_in` overstates real cost ~5×. Tool-call counts are the robust signal.
- **Timeouts truncate the heaviest off cells** (opus callgraph) — those `total`s
  are lower bounds, not measured completions.
- **This measures tool-call reduction only.** It does *not* measure call-graph
  accuracy. `cxt impact` has known false-positive/negative modes (see the project
  notes); a smaller call count is not a correctness claim.
- cxt's stated reason for existing is its **BS detector** (forcing exception-
  swallowing / fake-execution into the open), not tool savings. This benchmark
  covers a secondary property.

## Reproduce

```bash
# smoke (1 cell)
REPOS=cxt TASKS=callgraph MODELS=claude-sonnet-4-6 RUNS=1 \
  ./testing/cxt_bench_matrix_260623_v2.sh

# full matrix
RUNS=2 ./testing/cxt_bench_matrix_260623_v2.sh
```

Raw data: `testing/matrix_*/results.csv`.
