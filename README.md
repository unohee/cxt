# ctx

Code context toolkit — scan codebases for entities (functions, classes, types, constants), detect bad code smells, and inject context into Claude Code sessions.

## Install

```bash
npm install
npm run build
npm link  # register global `ctx` command (optional)
```

## Usage

```bash
# Scan codebase → register entities to local SQLite registry
ctx scan
ctx scan -v              # verbose output

# Query registry
ctx check --stats        # overall statistics
ctx check <file>         # per-file entity listing
ctx check --search <q>   # full-text search (FTS5)
ctx check --untested     # entities without tests
ctx check --high-risk    # high-risk entities
ctx check --deprecated   # deprecated entities
ctx check --tag <tag>    # filter by tag
ctx check --tree         # directory tree view
ctx check --ci           # CI/CD mode (JSON output, exit 1 on critical)

# Bad Smell detection
ctx bs                   # scan for BS patterns
ctx bs -v                # verbose per-file output

# Entity annotation
ctx annotate <name> --deprecate "reason"
ctx annotate <name> --tag "team=backend"
ctx annotate <name> --status experimental
ctx annotate <name> --risk high
ctx annotate <name> --warn "error/security: SQL injection risk"
ctx annotate <name> --note "refactor planned"

# Claude Code context injection (for SessionStart hook)
ctx inject

# Language override (default: auto-detect from LANG env)
ctx --lang en scan
ctx --lang ko bs
```

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

By default, ctx skips common non-project directories (`node_modules`, `.git`, `dist`, `build`, `target`, `vendor`, `docker`, etc.) and all hidden directories.

### .ctxignore

Create a `.ctxignore` file in your project root to exclude additional paths from both `scan` and `bs`:

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

ctx also reads your `.gitignore` for directory patterns, and auto-detects vendored subprojects (directories with their own `package.json`/`Cargo.toml`/etc. plus `node_modules`/`.venv`).

## BS Detector Rules

| Severity | Pattern | Description |
|----------|---------|-------------|
| CRITICAL | Empty catch/except | Exception silencing |
| CRITICAL | Hardcoded secrets | password/api_key/secret/token |
| CRITICAL | debugger | Leftover debugger statement |
| CRITICAL | Fake success return | `return true // always` |
| WARNING | eval() | Code injection risk |
| WARNING | TODO/FIXME | Leftover TODOs |
| WARNING | console.log | Debug output in production |
| WARNING | `any` type | TypeScript type safety bypass |
| WARNING | example.com | Fake URL hardcoded |
| MINOR | Magic numbers | Unclear hardcoded values |
| MINOR | 200+ char lines | Poor readability |

## i18n

Supports English (`en`) and Korean (`ko`). Language is auto-detected from the `LANG` environment variable, or set explicitly with `--lang`.

## Claude Code Integration

Add `ctx inject` to your `settings.json` SessionStart hook for automatic codebase context injection:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "ctx inject"
      }
    ]
  }
}
```

## Storage

Registry is stored at `~/.ctx/registry.db` (SQLite). Each project is isolated by project ID, so multiple codebases can be tracked simultaneously.

## Programmatic API

```typescript
import { getRegistryStore, scanRepository, scanBs } from 'ctx';

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
