# cxt

**C**ode e**X**ploration **T**oolkit — scan codebases for entities (functions, classes, types, constants), detect bad code smells, and inject context into Claude Code sessions.

## Install

```bash
npm install @intrect/cxt
# or
npm install && npm run build && npm link
```

## Usage

```bash
# Scan codebase → register entities to local SQLite registry
cxt scan
cxt scan -v              # verbose output
cxt scan --full          # recompute facts and replace caches

# Query registry
cxt check --stats        # current project statistics
cxt check --stats --global  # aggregate across ALL projects in registry
cxt check <file>         # per-file entity listing
cxt check --search <q>   # full-text search (FTS5)
cxt check --untested     # entities without tests
cxt check --high-risk    # high-risk entities
cxt check --deprecated   # deprecated entities
cxt check --tag <tag>    # filter by tag
cxt check --tree         # directory tree view
cxt check --ci           # CI/CD mode (JSON output, exit 1 on critical)
cxt query calls --where '[{"column":"resolution","op":"eq","value":"unresolved"}]' --json

# Call-graph queries (after cxt scan)
cxt who-calls <name>     # entities that call/extend/implement <name>
cxt calls <name>         # entities that <name> calls/extends/implements
cxt impact <name>        # transitive callers — everything affected if <name> changes
cxt cfg <name> --json    # stored function control-flow graph and diagnostics
cxt flow <name> --json --strict # stored def-use/value/alias facts; partial analysis exits 2
cxt impact <name> --depth 3   # limit BFS depth (default: 5)
cxt impact <name> --param input --explain --json # current value dependence into caller outputs
cxt who-calls <name> --json   # machine-readable output (also: calls/impact)
cxt preflight <name> --json   # candidate files + risk/test/warning review checklist

# Registry hygiene
cxt projects             # list registered projects with entity counts
cxt project rm <id|path> # remove a project and all its entities (asks unless --yes)
cxt prune                # delete broken (zombie) entities (asks unless --yes)
cxt prune --events --days 7   # delete events older than 7 days
cxt vacuum               # compact registry DB (SQLite VACUUM)

# Structure snapshot / LOC
cxt export               # GraphQL-like SDL snapshot (stdout)
cxt export -o .cxt/structure.gql  # write snapshot to file (LLM-friendly)
cxt loc                  # per-file LOC report sorted by size
cxt loc --dir src --no-blank --no-comments  # code-only LOC for a directory

# Bad Smell detection
cxt bs                   # scan for BS patterns
cxt bs -v                # verbose per-file output
cxt bs --json            # JSON: 0 pass, 1 findings, 2 partial, 3 tool failure
cxt bs --sarif           # SARIF 2.1.0 with rule metadata and flow evidence
cxt bs --dir src/api     # limit scan to a directory prefix

# Code audit (BS scan + registry integrity)
cxt audit                # BS patterns + untested/high-risk/deprecated, exit 1 on critical
cxt audit --json         # CI mode (JSON output)
cxt audit --quick        # BS patterns only (skip registry stats)
cxt audit --sarif        # SARIF findings and execution/completeness metadata
cxt scan --json          # fact extraction counts, diagnostics and outcome
cxt audit --dir src      # limit to a directory prefix

# Entity annotation
cxt annotate <name> --deprecate "reason"
cxt annotate <name> --tag "team=backend"
cxt annotate <name> --status experimental
cxt annotate <name> --risk high
cxt annotate <name> --warn "error/security: SQL injection risk"
cxt annotate <name> --note "refactor planned"

# Claude Code context injection (for SessionStart hook)
cxt inject

# Language override (default: auto-detect from LANG env)
cxt --lang en scan
cxt --lang ko bs
```

## Parser selection

`scan` uses native tree-sitter for TypeScript/TSX, JavaScript/JSX, Python and
Rust. It extracts declarations from syntax nodes, preserves exact line ranges,
and distinguishes nested declarations and same-name methods by scope
(`src/file.ts::Store.read`). Overloads/repeated bindings also include a source
position suffix. Go, Java, C/C++, and C# currently use lexical extraction.

```bash
CXT_PARSER=auto cxt scan     # default; reports parser counts and fallback reasons
CXT_PARSER=ast cxt scan      # require AST; unsupported/missing parser is an error
CXT_PARSER=lexical cxt scan  # explicitly use the previous extractor
```

Native parser packages are optional. In `auto`, an unavailable native parser
produces a visible diagnostic and uses lexical extraction. A syntax error in
an available AST parser fails the scan and preserves the previous registry.
Missing extraction queries and invalid queries also fail the scan.

The public `extractFile` API returns the selected engine, declarations,
references, symbol facts and diagnostics. `extractEntities` retains its legacy lexical API.
AST call resolution follows project-local bindings, imports, aliases and simple receiver types.
BS now uses AST predicates and a definite uninitialized-read dataflow rule on these languages.
Rule metadata, path roles and current completeness limits are documented in
[Structural rules](docs/STRUCTURAL_RULES.md). SARIF and exit status contracts are in
[Analysis reports](docs/ANALYSIS_REPORTS.md). Further work is tracked in the
[ten-part implementation roadmap](docs/STATIC_ANALYSIS_ROADMAP.md).

Run `npm run bench:accuracy` and `npm run bench:calls` for the handwritten declaration and call corpora, and
`npm run test:package` for a fresh package install, missing-native simulation and CLI
checks. These tests do not establish CodeQL equivalence.

## Intraprocedural dataflow

An AST scan also runs a finite worklist solver over each function CFG. The v7
registry stores results in `code_dataflow` in the same transaction as entities,
calls, CFGs and relations. `flow <name> --json` includes source locations,
reaching definitions, uses, possible uninitialized reads, abstract return values,
parameter dependencies and unknown effect locations. `--strict` exits 2 for
partial analysis; missing results exit 1 and require a rescan.

Assignments kill previous definitions; merges retain alternatives. Allocation
sites identify aliases and known field writes. Branch guards refine null and
primitive alternatives, and pending returns follow finally overrides. Unknown
calls, accessors, dynamic operators and await invalidate affected abstract state.
Direct JavaScript eval also invalidates local bindings. These are conservative
intraprocedural facts, not runtime execution or proof that a function is safe.

Default limits: `max(1024, CFG nodes * 64)` transfers, 100,000 stored cells and
250,000 abstract value work units. Exceeding a limit or encountering unsupported
control/effects produces explicit partial diagnostics. The work limit counts
state values and their alternatives, so large joins cannot hide behind a small
node count. A repository scan deadline failure rolls back the entire snapshot.
The API accepts explicit budgets for targeted analysis.

Resource lifecycles, Rust move/borrow ownership and dynamic pattern binding
remain pending. `npm run bench:flow` runs the handwritten
development oracle; it does not measure independent real-world accuracy.

## Function summaries and parameter value impact

`scan` links resolved call sites by their exact source span, computes function
summaries in callee-first SCC order and stores them in `code_function_summaries`.
Recursive components use monotone joins and a 16-round budget. A component that
exceeds the budget becomes partial, including the summaries consumed by callers.
Unchanged callee contexts reuse a flow result within the same scan.

Summaries retain abstract return values, formal parameter dependence, possible
throws and conservative heap/binding effects. Each call substitutes its own
argument dependencies. Parameter dependence alone does not justify substituting
the argument's concrete value as if the callee were an identity function.
Unknown effects, closure/global value dependence, returned heap allocations,
async/generator call envelopes, unsupported formal patterns and receiver/keyword/spread argument mapping remain
explicit boundaries. Conditional library contracts are described below; resource models remain pending.

```bash
cxt flow transform --json --strict
cxt impact transform --param input --explain --json --strict
cxt preflight transform --param input --explain --json --strict
```

With `--param`, impact traces the current parameter's **explicit value dependence**
through return definitions into caller outputs. It can exclude discarded or
overwritten call results and unused formal parameters. This is narrower than
general change impact: it does not cover implicit control dependence, signature
changes or newly introduced behavior. The default impact command retains the
ordinary reverse relation graph.

`--explain` adds static definition paths and call source spans. They describe
abstract dependencies, not observed runtime traces. Partial summaries, unresolved
call targets, non-return effects and depth truncation are reported as boundaries.
Strict parameter analysis exits 2 for incomplete evidence; invalid/missing facts
exit 1. Strict preflight additionally exits 1 for its usual review findings.
`flow` JSON retains the intraprocedural `completeness`, includes `summary`, and
exposes their combined `analysisCompleteness` for its strict exit decision.

`npm run bench:impact` compares the existing store's reverse caller candidates
against the same handwritten parameter-value labels. The development corpus
does not establish general change-impact accuracy or independent generalization.

## External library models

DB v8 preserves import module/symbol identities and a versioned model manifest.
Optional `.cxt-models.json` declares exact target package/runtime versions and
the `unmodified-external-bindings` assumption. Without those declarations,
unknown library effects remain unknown. The built-in pack covers 19 Node path,
Python math and Rust std::cmp contracts with primitive argument guards.

`flow --json` records applied/rejected contracts, pack version/hash, declared target
version and assumptions; summaries and parameter impact propagate model provenance.
Direct named imports and proven aliases are supported. Namespace callable proof,
framework callbacks and resource lifecycles remain incomplete. User JSON packs
are schema checked before scan; invalid packs preserve the previous snapshot.
See [configuration, schema and limits](docs/LIBRARY_MODELS.md).

## Incremental facts and bounded queries

`scan` reuses file frontend and function-component caches by content, engine,
parser, linked call dependencies and model manifest. All facts and caches commit
as one snapshot; failed scans preserve the previous snapshot. `scan --full`
recomputes every stage. Cache hits retain the original completeness diagnostics.

`query entities|calls|cfg|flows|summaries` reads persisted facts using allowlisted
columns, bound `eq`/`prefix` filters and a maximum of 500 rows. It accepts no raw
SQL. JSON reports `freshness: current`, `stale`, or `not-verified`; refresh with `scan` before
using the results for the current checkout. See [contracts and performance
measurements](docs/INCREMENTAL_FACTS.md).

## Change Preflight (impact / risk / test gap)

`preflight` turns the relation graph into a deterministic change-review
checklist. It lists candidate files and flags impacted high-risk, untested, or
warned entities. `--strict` exits 1 when such follow-up exists, so it can gate
a change plan or CI review.

```bash
cxt preflight handlePayment
cxt preflight src/payments.ts::handlePayment --json --strict
```

The call graph is deliberately a **seed**, not proof that no other caller
exists: verify dynamic dispatch, imports, and framework callbacks in source.

## Call Graph (who-calls / calls / impact)

`cxt scan` builds a same-project relation graph. For AST languages, calls are resolved through lexical scopes, local imports/re-exports, aliases, constructors and simple annotated receiver types. Recursive calls and each call's source location are retained. Unresolved and external calls carry reasons; they do not create target edges. Lexical languages still use the earlier name/file-proximity heuristic. After a scan, query the current relation graph with:

```bash
cxt who-calls rowsToEntities       # who depends on this function?
cxt calls handleCheck              # what does this call?
cxt impact SqliteRegistryStore     # if I change this class, what breaks?
```

Ambiguous names are rejected with candidate suggestions — disambiguate with the qualified name (`src/file.ts::name`). Use `--type calls|extends|implements` to filter, `--json` for scripts.

`calls --json` includes `callSites` with 1-based start/end positions (end exclusive),
caller/target qualified names, `resolution`, `reason`, and `confidence`.
Confidence is a policy score (1 for direct bindings/imports, 0.9 for receiver inference,
0 for unresolved/external), **not a calibrated probability**. The human output also lists unresolved calls.
The v4 registry persists these facts in `code_call_sites` and replaces them atomically with entities and relations.

This is a partial semantic resolver: tsconfig path mapping, package/workspace resolution,
full type inference, subtype dispatch, member mutation, decorators, macros and framework callbacks
are not modeled. Multiple writes remain unresolved until dataflow analysis is available.
Calls through these constructs may remain unknown or require source review; an empty caller list
does not establish that a function is unused.

## Control flow

`cxt scan` stores function CFGs for AST languages in DB v5 `code_control_flow`.
`cxt cfg <qualified-name> --json` returns source-located operation nodes, edges,
basic blocks, reachability, structural complexity and completeness diagnostics.
`--strict` exits 2 for `partial`, 0 for a complete graph; an absent graph/entity is exit 1.

Supported control includes if/elif, short-circuit/ternary/optional chaining/logical assignment,
loops and labeled jumps, switch fallthrough, match guards, return/throw,
try/catch/else/finally, Python with/loop-else, Rust `?` and explicit await suspension/resumption.
Cleanup paths are copied per pending completion to preserve finally overrides.
Unknown call/member effects may throw; exception-type and value feasibility are approximated.
Python `except (A, B)` handlers match each statically named exception independently; dynamic tuples and exception groups remain partial.
`structuralComplexity` counts explicit decision sites plus one, without counting implicit
exception edges or copied finally bodies again.

`complete` means the builder lowered the function's control constructs within this model;
it does not establish path feasibility, termination, type correctness or full runtime semantics.
Await uses a separate suspension terminal, `suspend`/`resume` edges and an exceptional
resumption path through handlers/cleanup. This describes possible continuations and does
not guarantee that the scheduler resumes a suspended task.
Yield/deferred async blocks, async iteration, comprehensions, macros, exception groups and unproved Rust match exhaustiveness
produce `partial` diagnostics. A per-function node budget also produces `partial`.
Lexical files and function signatures without bodies have no CFG.
Run `npm run bench:cfg` for the handwritten development reachability/complexity corpus.

## Benchmark — does it cut agent tool calls?

cxt can provide deterministic registry answers where an agent would otherwise
trace code manually. Historical `claude -p` measurements are directional only;
the current Codex harness requires a fresh condition-isolated run before making
a tool-call reduction claim.

Run `npm run bench:codex -- --dry-run` to validate the isolated setup, then use
paired runs for evidence. Full method, retained historical aggregates,
limitations, and the reproducible harness: **[BENCHMARK.md](BENCHMARK.md)**.

## Registry Hygiene

The registry at `~/.cxt/registry.db` accumulates projects and event history over time:

```bash
cxt projects                   # see all registered projects + entity/broken counts
cxt project rm old-project     # remove a stale project (also accepts a directory path)
cxt prune                      # delete broken (zombie) entities — files that disappeared
cxt prune --events --days 7    # trim event history older than 7 days
cxt vacuum                     # reclaim disk space (VACUUM)
cxt vacuum --keep-days 7       # prune old events, then VACUUM
```

Entities marked `broken` (source file deleted) are auto-restored to `active` if a later scan rediscovers them — only scanner-managed entities are touched, manual annotations stay.

## Supported Languages

| Language | Extensions |
|----------|-----------|
| TypeScript / JavaScript | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` |
| Python | `.py` `.pyw` |
| Go | `.go` |
| Rust | `.rs` |
| Java | `.java` |
| C | `.c` `.h` |
| C++ | `.cpp` `.cxx` `.cc` `.hpp` |
| C# | `.cs` |

## Ignore Rules

By default, cxt skips common non-project directories (`node_modules`, `.git`, `dist`, `build`, `target`, `vendor`, `docker`, etc.) and all hidden directories.

### .cxtignore

Create a `.cxtignore` file in your project root to exclude additional paths from both `scan` and `bs`:

```gitignore
# directories
docker/
legacy/
subprojects/pykis/

# prefix patterns
build-*

# path patterns
tools/external/**
```

### Auto-detection

cxt also reads your `.gitignore` for directory patterns, and auto-detects vendored subprojects (directories with their own `package.json`/`Cargo.toml`/etc. plus `node_modules`/`.venv`).

## BS Detector Rules

| Severity | Pattern | Lang | Description |
|----------|---------|------|-------------|
| CRITICAL | Empty catch/except | all | Exception silencing |
| CRITICAL | Hardcoded secrets | all | password/api_key/secret/token |
| CRITICAL | debugger | TS/JS | Leftover debugger statement |
| CRITICAL | Fake success return | all | `return true // always` |
| CRITICAL | Success log candidate | TS/JS/Py | Review success claims; a log alone does not establish fake execution |
| CRITICAL | unwrap()/expect() | Rust | Production panic risk (excludes `unwrap_or`, `// SAFETY:`) |
| CRITICAL | todo!()/unimplemented!() | Rust | Incomplete, must not ship |
| CRITICAL | np.random/faker | Python | Fabricated data in production (excludes `seed`, tests) |
| WARNING | eval() | all | Code injection risk |
| WARNING | TODO/FIXME | all | Leftover TODOs |
| WARNING | console.log | TS/JS | Debug output in production |
| WARNING | `any` type | TS | TypeScript type safety bypass |
| WARNING | example.com | all | Fake URL hardcoded |
| WARNING | `let _ = ` / `.ok();` | Rust | Silent error swallow (excludes `// reason:`) |
| WARNING | Uninitialized read | TS/JS/Py/Rust | Definite uninitialized value in a completed local flow model |
| MINOR | Magic numbers | all | Unclear hardcoded values |
| MINOR | 200+ char lines | all | Poor readability |

Production vs test/example separation: Rust patterns exclude `tests/`, `examples/`, `benches/`, `/bin/`, and `build.rs`; fake-data/fake-success patterns exclude test paths.

The AST rules have stable IDs, versions, source spans and policy precision metadata.
Use `.cxt-rules.json` for explicit path roles; see [contracts and migration notes](docs/STRUCTURAL_RULES.md).
`analysis.completeness` and diagnostics distinguish partial flow/lexical fallback from completed analysis.

### Suppressing false positives

When a pattern fires on code you know is fine, suppress it inline with a comment (works in any language's comment syntax — `//`, `#`, `/* */`, etc.). Suppressed issues are removed from the report entirely (like `eslint-disable`).

```ts
const x = legacy as any;        // cxt-ignore
const y = legacy as any;        // cxt-ignore: type_safety   (only this category)
foo.unwrap();                   // cxt-ignore -- with a trailing note

// cxt-ignore-next-line
const z = legacy as any;        // suppresses the line below

// cxt-ignore-next-line: fake_execution
print("완료")                    # category-scoped, next line only
```

- `cxt-ignore` — suppress every pattern on the same line.
- `cxt-ignore: cat1,cat2` — suppress only those categories on the same line (others still report).
- `cxt-ignore-next-line[: cats]` — same, but applies to the next line.

The marker must be in a comment; `"cxt-ignore"` inside a string literal does nothing. Categories are the BS category names (e.g. `type_safety`, `fake_execution`, `panic_risk`, `error_swallow`, `exception_hiding`, `incomplete`, `debug_leftover`).

## i18n

Supports English (`en`) and Korean (`ko`). Language is auto-detected from the `LANG` environment variable, or set explicitly with `--lang`.

## Claude Code Integration

Add `cxt inject` to your `settings.json` SessionStart hook for automatic codebase context injection:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "cxt inject"
      }
    ]
  }
}
```

## Storage

Registry is stored at `~/.cxt/registry.db` (SQLite). Each project is isolated by project ID, so multiple codebases can be tracked simultaneously.

## Programmatic API

```typescript
import { getRegistryStore, scanRepository, scanBs } from '@intrect/cxt';

// Scan
const result = await scanRepository('/path/to/project', 'my-project');

// Query registry
const store = getRegistryStore();
const stats = store.getStats('my-project');
const entities = store.searchEntities('handleCheck');

// BS detection
const bsResult = await scanBs('/path/to/project');
```

## License

Apache License 2.0
