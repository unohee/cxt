# CLAUDE.md — ctx

## Project

Code context toolkit. TypeScript/Node.js CLI for code entity registry management, BS (Bad Smell) pattern detection, and Claude Code session context injection. Extracted from OpenSwarm's `openswarm check` as a standalone package.

## Quick Start

```bash
npm install
npm run build
node dist/cli.js scan       # scan codebase
node dist/cli.js check --stats  # view stats
node dist/cli.js bs          # BS detection
node dist/cli.js inject      # Claude Code context injection
```

## Static Analysis Usage

Run `scan` before registry-backed analysis so entity metadata and call relations reflect the current checkout:

```bash
cxt scan
cxt audit
```

Use the commands according to the question being answered:

| Goal | Command |
|------|---------|
| Detect bad-code patterns such as swallowed errors, fake execution, and hardcoded secrets | `cxt bs` |
| Run the default combined audit: BS detection plus registry integrity checks | `cxt audit` |
| Run the audit in CI and fail on critical findings | `cxt audit --json` |
| Inspect entities registered for one file before editing it | `cxt check <file>` |
| Find direct callers or callees | `cxt who-calls <name>` / `cxt calls <name>` |
| Find transitive callers affected by a change | `cxt impact <name> --depth 5` |
| Review impact, risk, tests, and warnings before changing an entity | `cxt preflight <name>` |
| Enforce preflight findings in automation | `cxt preflight <name> --strict --json` |
| Run registry integrity checks in CI | `cxt check --ci` |

Recommended agent workflow:

```bash
# 1. Refresh facts after checkout changes or before repository-wide analysis.
cxt scan

# 2. Inspect the target before modifying production code.
cxt check src/path/to/file.ts
cxt preflight targetEntity

# 3. Run focused analysis while implementing.
cxt bs --dir src/path
cxt impact targetEntity --depth 5

# 4. Run the full gate before declaring the work complete.
cxt audit
```

For CI:

```bash
cxt scan
cxt audit --json
```

`audit` does not replace `scan`: BS detection reads source files directly, while integrity, call-graph, impact, and preflight results use the persisted registry at `~/.cxt/registry.db`. Refresh the registry whenever the checkout has changed. The current analyzer uses the lexical/regex frontend; AST, symbol-resolution, CFG, and dataflow phases are roadmap work and must not be claimed as active capabilities.

## Architecture

```
src/
├── cli.ts                    # CLI entry point (commander)
├── index.ts                  # Public API export
├── i18n.ts                   # i18n (en/ko) with LANG auto-detection
├── cli/
│   ├── checkHandler.ts       # check/scan/bs/annotate handlers
│   ├── auditHandler.ts       # audit handler (BS scan + registry integrity)
│   ├── relationHandler.ts    # who-calls/calls/impact (call-graph queries)
│   ├── exportHandler.ts      # GraphQL-like SDL snapshot
│   ├── locHandler.ts         # LOC report
│   └── initHandler.ts        # AI agent instruction injection
└── registry/
    ├── schema.ts             # Zod schemas + type definitions
    ├── sqliteStore.ts        # SQLite + FTS5 registry (better-sqlite3)
    ├── entityScanner.ts      # 8-language entity extraction + registry sync
    ├── bsDetector.ts         # BS pattern static analysis
    └── ignoreRules.ts        # Scan exclusion rules (.gitignore, .cxtignore, auto-detect)
```

## Key Design Decisions

### Regex-based parser (no AST)
- 8 languages: TypeScript, JavaScript, Python, Go, Rust, Java, C/C++, C#
- Regex extraction of top-level functions/classes/constants/types
- Block end estimation: brace counting (C-family) or indent tracking (Python)
- Complexity score: LOC + nesting depth + parameter count (0-10)

### SQLite + FTS5
- `~/.cxt/registry.db` with per-project entity storage
- Content-synced FTS5 + triggers for auto-indexing
- WAL mode, N+1 prevention with batch queries
- Auto-migration from old (Rust-era) schemas

### BS Detector
- Regex line matching + excludeIf filters to reduce false positives
- i18n files auto-excluded to prevent self-detection
- Severity: critical (fix now), warning (recommended), minor (info)
- BS Score = (critical*10 + warning*3 + minor*1) / filesScanned

### Ignore Rules (3-tier)
1. **Built-in**: node_modules, .git, dist, build, target, docker, htmlcov, hidden dirs, etc.
2. **File-based**: `.gitignore` + `.cxtignore` directory/prefix/path patterns
3. **Auto-detect**: Vendored subprojects (own manifest + node_modules/.venv)

### Project ID auto-resolution
- package.json name → Cargo.toml name → go.mod module → folder name

## Conventions

- qualified_name: `{relative_file_path}::{entity_name}`
- Entity kind: function, class, module, type, constant
- Entity status: active, deprecated, experimental, planned, broken
- risk_level: complexity >=8 → high, >=6+untested → high, >=6 → medium, >=4+untested → medium, else low
- Skip dirs: defined in `src/registry/ignoreRules.ts`
- Max file size: 512KB

## Dependencies

better-sqlite3, commander, nanoid, zod

## Origin

Extracted from OpenSwarm (`@intrect/openswarm`) `src/registry/` + `src/cli/checkHandler.ts`. GraphQL API, memory bridge, issue bridge remain in OpenSwarm.
