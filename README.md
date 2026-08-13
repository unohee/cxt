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

# Call-graph queries (after cxt scan)
cxt who-calls <name>     # entities that call/extend/implement <name>
cxt calls <name>         # entities that <name> calls/extends/implements
cxt impact <name>        # transitive callers — everything affected if <name> changes
cxt impact <name> --depth 3   # limit BFS depth (default: 5)
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
cxt bs --json            # JSON output, exit 1 on critical (CI-friendly)
cxt bs --dir src/api     # limit scan to a directory prefix

# Code audit (BS scan + registry integrity)
cxt audit                # BS patterns + untested/high-risk/deprecated, exit 1 on critical
cxt audit --json         # CI mode (JSON output)
cxt audit --quick        # BS patterns only (skip registry stats)
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

`cxt scan` builds a same-project relation graph (`calls`, `uses`, `extends`, `implements`, `overrides`) from regex-extracted references. After a scan, relation queries replace grep for understanding code flow:

```bash
cxt who-calls rowsToEntities       # who depends on this function?
cxt calls handleCheck              # what does this call?
cxt impact SqliteRegistryStore     # if I change this class, what breaks?
```

Ambiguous names are rejected with candidate suggestions — disambiguate with the qualified name (`src/file.ts::name`). Use `--type calls|extends|implements` to filter, `--json` for scripts.

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
| CRITICAL | Fake success print | TS/JS/Py | `console.log("완료")` / `print("성공")` — claimed without verification |
| CRITICAL | unwrap()/expect() | Rust | Production panic risk (excludes `partial_cmp`, `unwrap_or`, `// SAFETY:`) |
| CRITICAL | todo!()/unimplemented!() | Rust | Incomplete, must not ship |
| CRITICAL | np.random/faker | Python | Fabricated data in production (excludes `seed`, tests) |
| WARNING | eval() | all | Code injection risk |
| WARNING | TODO/FIXME | all | Leftover TODOs |
| WARNING | console.log | TS/JS | Debug output in production |
| WARNING | `any` type | TS | TypeScript type safety bypass |
| WARNING | example.com | all | Fake URL hardcoded |
| WARNING | `let _ = ` / `.ok();` | Rust | Silent error swallow (excludes `// reason:`) |
| MINOR | Magic numbers | all | Unclear hardcoded values |
| MINOR | 200+ char lines | all | Poor readability |

Production vs test/example separation: Rust patterns exclude `tests/`, `examples/`, `benches/`, `/bin/`, and `build.rs`; fake-data/fake-success patterns exclude test paths.

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
