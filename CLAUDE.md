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
