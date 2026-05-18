# Show HN 초안 (단축판)

## 제목
`Show HN: cxt – give LLMs a one-file map of your codebase (no glob/grep)`

---

## 본문

Hey HN — I built **cxt** (Code eXploration Toolkit), a small CLI that scans a codebase, registers every top-level entity (functions, classes, types, constants) into a local SQLite registry, and exports the whole structure as a single GraphQL-like tree file that LLMs can read instead of running dozens of glob/grep calls.

**The problem**: every time I started a Claude Code / Codex / Gemini session on a non-trivial repo, the agent would burn 5–15 tool calls just figuring out the project layout — `find`, `ls`, `grep -r`, reading the same `package.json` for the third time. The model has plenty of capability; it just lacks a *map*. So I gave it one.

**What `cxt export` produces**:

```
directory "src/" [entities:76, untested:76] {
  directory "registry/" [entities:53, untested:53] {
    file "entityScanner.ts" [entities:15, untested:15] {
      function extractEntities [risk:medium, tested:no, lines:222-287, complexity:4]
      function buildTestMap    [risk:low, tested:no, lines:440-491, complexity:3]
      ...
    }
  }
}
```

Each entity carries `[status, risk, tested, lines, complexity]`. One `Read` of this file gives an agent a complete structural picture — file paths, line ranges, what's untested, what's high-risk, what's deprecated. No more glob spelunking.

**What's in the box**: regex parser for 8 languages (TS/JS, Python, Go, Rust, Java, C/C++, C#) → SQLite + FTS5 registry at `~/.cxt/registry.db`. Commands: `cxt scan`, `cxt check` (with `--tree`, `--search`, `--untested`, `--high-risk`, `--dir`, `--kind` filters), `cxt bs` (static "bad smell" detector — empty catches, hardcoded secrets, `as any`, `eval`, etc.), `cxt export`, `cxt annotate` (mark deprecated, tag, attach warnings), `cxt init --target claude,codex,gemini` (installs a usage guide into each agent's instruction file so they know the commands exist).

**Design choices**: no AST, deliberately — regex with brace counting / indent tracking is fast and "good enough" when 95% accuracy beats 100% at 10× the complexity. No daemon — just a single SQLite file with WAL mode. 3-tier ignore rules (built-in + `.cxtignore`/`.gitignore` + auto-detection of vendored subprojects) so the scanner doesn't drown in `node_modules` of a vendored dep.

**Install**:

```bash
npm install -g @intrect/cxt
cd your-project && cxt scan && cxt export -o .cxt/structure.gql
```

Apache-2.0, ~2k LOC of TypeScript, 4 runtime deps. Repo: https://github.com/unohee/cxt

Honest caveats: v0.1.0, regex parser misses nested classes and some edge cases, zero tests yet (the irony of a code-quality tool reporting `untested:76` on itself is not lost on me — that's next), and I've only validated the Codex/Gemini init paths against documentation. Feedback very welcome.
