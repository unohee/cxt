// ============================================
// cxt - CLI Init Handler
// Created: 2026-04-11
// Updated: 2026-04-12 — multi-target support (claude, codex, gemini, custom)
// Purpose: `cxt init` — inject cxt usage into agent instruction files
// ============================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const CXT_SECTION_START = '<!-- cxt:start -->';
const CXT_SECTION_END = '<!-- cxt:end -->';

interface TargetSpec {
  name: string;
  path: string;
  label: string;
}

// 전역 타겟: 모듈 로드 시 고정
const GLOBAL_TARGETS: Record<string, TargetSpec> = {
  claude: {
    name: 'claude',
    path: join(homedir(), '.claude', 'CLAUDE.md'),
    label: 'Claude Code (global)',
  },
  codex: {
    name: 'codex',
    path: join(homedir(), '.codex', 'AGENTS.md'),
    label: 'OpenAI Codex CLI (global)',
  },
  gemini: {
    name: 'gemini',
    path: join(homedir(), '.gemini', 'GEMINI.md'),
    label: 'Gemini CLI (global)',
  },
};

// 로컬 타겟: cwd 기준 (handleInit 호출 시점의 cwd 사용)
function buildLocalTargets(cwd: string): Record<string, TargetSpec> {
  return {
    'local-claude': {
      name: 'local-claude',
      path: join(cwd, 'CLAUDE.md'),
      label: 'Claude Code (local)',
    },
    'local-agent': {
      name: 'local-agent',
      path: join(cwd, 'AGENT.md'),
      label: 'Agent (local)',
    },
    'local-agents': {
      name: 'local-agents',
      path: join(cwd, 'AGENTS.md'),
      label: 'Agents (local)',
    },
  };
}

const VALID_TARGET_NAMES = [...Object.keys(GLOBAL_TARGETS), 'local-claude', 'local-agent', 'local-agents'];

function getCxtSection(): string {
  return `${CXT_SECTION_START}
## cxt — Code eXploration Toolkit

Codebase entity registry, BS detector, LOC reporter, and AI context injection CLI.
Installed globally as \`cxt\`. Registry stored at \`~/.cxt/registry.db\`.

### SessionStart Hook

\`cxt inject\` is configured as a SessionStart hook. It outputs a concise
registry map at session start so you can skip exploratory Read/Grep for
known entities.

### Commands

| Command | Purpose |
|---------|---------|
| \`cxt scan\` | Scan codebase → register entities to SQLite registry |
| \`cxt scan -v\` | Verbose scan with per-file output |
| \`cxt check --stats\` | Registry statistics |
| \`cxt check <file>\` | File entity brief |
| \`cxt check --search <q>\` | Full-text search (FTS5) |
| \`cxt check --untested\` | Entities without tests |
| \`cxt check --high-risk\` | High complexity + untested entities |
| \`cxt check --tree\` | Directory tree with entity counts |
| \`cxt check --dir <path>\` | Filter tree/listings by directory prefix |
| \`cxt check --kind <kind>\` | Filter by entity kind (function/class/...) |
| \`cxt check --ci\` | CI mode (JSON output, exit 1 on critical) |
| \`cxt bs\` | Scan for bad code smells (BS patterns) |
| \`cxt loc\` | File LOC report sorted by size |
| \`cxt loc --dir <path>\` | LOC for a specific directory |
| \`cxt loc --no-blank --no-comments\` | Code-only LOC (exclude blank/comment lines) |
| \`cxt loc --entities\` | LOC with registered entity count per file |
| \`cxt export\` | GraphQL-like SDL snapshot of codebase structure |
| \`cxt export -o .cxt/structure.gql\` | Save snapshot to file (LLM-friendly) |
| \`cxt annotate <name> --deprecate "reason"\` | Mark entity deprecated |
| \`cxt annotate <name> --tag key=value\` | Tag entity |
| \`cxt inject\` | Output registry summary (SessionStart hook) |
| \`cxt init --target local-claude\` | Inject cxt guide into project CLAUDE.md |

### Ignore Rules

- Built-in: skips node_modules, .git, dist, build, target, docker, etc.
- \`.cxtignore\`: project-specific exclusions (same syntax as .gitignore)
- Auto-detects vendored subprojects with own package.json + node_modules

### When to use cxt

- **Before modifying code**: \`cxt check <file>\` — entity status, risk, test coverage
- **Before exploring an unfamiliar repo**: \`cxt export\` once — replaces dozens of glob/grep calls
- **Understanding file sizes**: \`cxt loc\` — spot oversized files before reviewing
- **After major changes**: \`cxt scan\` — update the registry
- **Code review**: \`cxt bs\` — catch bad patterns before commit
- **CI pipeline**: \`cxt check --ci\` — JSON output, exit 1 on critical issues
${CXT_SECTION_END}`;
}

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

type Action = 'added' | 'updated' | 'unchanged' | 'removed' | 'noop' | 'dry';

function applyToFile(
  filePath: string,
  label: string,
  cxtSection: string,
  opts: { remove?: boolean; dry?: boolean },
): Action {
  const dir = dirname(filePath);

  // --remove
  if (opts.remove) {
    if (!existsSync(filePath)) {
      console.log(`  ${c.dim}${label}: ${filePath} not found — skip${c.reset}`);
      return 'noop';
    }

    const content = readFileSync(filePath, 'utf-8');
    const startIdx = content.indexOf(CXT_SECTION_START);
    const endIdx = content.indexOf(CXT_SECTION_END);

    if (startIdx === -1 || endIdx === -1) {
      console.log(`  ${c.dim}${label}: no cxt section in ${filePath} — skip${c.reset}`);
      return 'noop';
    }

    const before = content.slice(0, startIdx).trimEnd();
    const after = content.slice(endIdx + CXT_SECTION_END.length).trimStart();
    const newContent = before + (after ? '\n\n' + after : '') + '\n';

    if (opts.dry) {
      console.log(`  ${c.bold}[dry]${c.reset} ${label}: would remove section from ${c.cyan}${filePath}${c.reset}`);
      return 'dry';
    }

    writeFileSync(filePath, newContent, 'utf-8');
    console.log(`  ${c.green}removed${c.reset} ${label}: ${c.cyan}${filePath}${c.reset}`);
    return 'removed';
  }

  // --add / --update
  if (!existsSync(dir)) {
    if (opts.dry) {
      console.log(`  ${c.bold}[dry]${c.reset} ${label}: would create ${c.cyan}${dir}${c.reset}`);
    } else {
      mkdirSync(dir, { recursive: true });
    }
  }

  let existing = '';
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, 'utf-8');
    const startIdx = existing.indexOf(CXT_SECTION_START);
    const endIdx = existing.indexOf(CXT_SECTION_END);

    if (startIdx !== -1 && endIdx !== -1) {
      const oldSection = existing.slice(startIdx, endIdx + CXT_SECTION_END.length);
      if (oldSection === cxtSection) {
        console.log(`  ${c.dim}${label}: already up to date (${filePath})${c.reset}`);
        return 'unchanged';
      }

      if (opts.dry) {
        console.log(`  ${c.bold}[dry]${c.reset} ${label}: would update section in ${c.cyan}${filePath}${c.reset}`);
        return 'dry';
      }

      const newContent = existing.slice(0, startIdx) + cxtSection + existing.slice(endIdx + CXT_SECTION_END.length);
      writeFileSync(filePath, newContent, 'utf-8');
      console.log(`  ${c.yellow}updated${c.reset} ${label}: ${c.cyan}${filePath}${c.reset}`);
      return 'updated';
    }
  }

  // Append
  if (opts.dry) {
    console.log(`  ${c.bold}[dry]${c.reset} ${label}: would append section to ${c.cyan}${filePath}${c.reset}`);
    return 'dry';
  }

  const separator = existing.length > 0 ? '\n\n' : '';
  writeFileSync(filePath, existing + separator + cxtSection + '\n', 'utf-8');
  console.log(`  ${c.green}added${c.reset} ${label}: ${c.cyan}${filePath}${c.reset}`);
  return 'added';
}

function resolveTargets(targetOpt: string | undefined, cwd: string): TargetSpec[] {
  const raw = (targetOpt ?? 'claude').split(',').map((s) => s.trim()).filter(Boolean);
  const localTargets = buildLocalTargets(cwd);
  const allTargets = { ...GLOBAL_TARGETS, ...localTargets };
  const out: TargetSpec[] = [];
  const invalid: string[] = [];

  for (const name of raw) {
    if (name === 'all') {
      for (const t of Object.values(allTargets)) {
        if (!out.find((x) => x.name === t.name)) out.push(t);
      }
      continue;
    }
    const spec = allTargets[name];
    if (!spec) {
      invalid.push(name);
      continue;
    }
    if (!out.find((x) => x.name === spec.name)) out.push(spec);
  }

  if (invalid.length > 0) {
    console.error(`${c.red}Unknown target(s): ${invalid.join(', ')}${c.reset}`);
    console.error(`${c.dim}Valid: ${VALID_TARGET_NAMES.join(', ')}, all${c.reset}`);
    process.exit(1);
  }

  return out;
}

export async function handleInit(opts: {
  remove?: boolean;
  dry?: boolean;
  target?: string;
  path?: string;
  cwd?: string;
}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const cxtSection = getCxtSection();

  const specs: TargetSpec[] = [];

  // --path overrides target list entirely
  if (opts.path) {
    const absPath = resolve(opts.path);
    specs.push({
      name: 'custom',
      path: absPath,
      label: 'Custom',
    });
  } else {
    specs.push(...resolveTargets(opts.target, cwd));
  }

  console.log(`\n${c.bold}cxt init${c.reset} ${opts.remove ? '(remove)' : ''}${opts.dry ? ' [dry-run]' : ''}`);
  console.log(`${'─'.repeat(50)}`);

  const summary: Record<Action, number> = { added: 0, updated: 0, unchanged: 0, removed: 0, noop: 0, dry: 0 };

  for (const spec of specs) {
    const action = applyToFile(spec.path, spec.label, cxtSection, {
      remove: opts.remove,
      dry: opts.dry,
    });
    summary[action]++;
  }

  // Summary line
  const parts: string[] = [];
  if (summary.added) parts.push(`${c.green}${summary.added} added${c.reset}`);
  if (summary.updated) parts.push(`${c.yellow}${summary.updated} updated${c.reset}`);
  if (summary.unchanged) parts.push(`${c.dim}${summary.unchanged} unchanged${c.reset}`);
  if (summary.removed) parts.push(`${c.green}${summary.removed} removed${c.reset}`);
  if (summary.noop) parts.push(`${c.dim}${summary.noop} skipped${c.reset}`);
  if (summary.dry) parts.push(`${c.bold}${summary.dry} dry${c.reset}`);

  console.log(`${'─'.repeat(50)}`);
  console.log(`${parts.join('  ')}\n`);

  if (!opts.remove && (summary.added > 0 || summary.updated > 0)) {
    console.log(`  ${c.dim}Agents will now see cxt commands in every session.${c.reset}`);
    console.log(`  ${c.dim}Run \`cxt init --remove --target ${opts.target ?? 'claude'}\` to undo.${c.reset}\n`);
  }
}
