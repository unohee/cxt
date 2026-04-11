// ============================================
// cxt - CLI Init Handler
// Created: 2026-04-11
// Purpose: `cxt init` — inject cxt usage into ~/.claude/CLAUDE.md
// ============================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { t } from '../i18n.js';

const CXT_SECTION_START = '<!-- cxt:start -->';
const CXT_SECTION_END = '<!-- cxt:end -->';

function getCxtSection(): string {
  return `${CXT_SECTION_START}
## cxt — Code eXploration Toolkit

Codebase entity registry, BS detector, and AI context injection CLI.
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
| \`cxt check --ci\` | CI mode (JSON output, exit 1 on critical) |
| \`cxt bs\` | Scan for bad code smells (BS patterns) |
| \`cxt annotate <name> --deprecate "reason"\` | Mark entity deprecated |
| \`cxt annotate <name> --tag key=value\` | Tag entity |
| \`cxt inject\` | Output registry summary (SessionStart hook) |

### Ignore Rules

- Built-in: skips node_modules, .git, dist, build, target, docker, etc.
- \`.cxtignore\`: project-specific exclusions (same syntax as .gitignore)
- Auto-detects vendored subprojects with own package.json + node_modules

### When to use cxt

- **Before modifying code**: run \`cxt check <file>\` to see entity status, risk, test coverage
- **After major changes**: run \`cxt scan\` to update the registry
- **Code review**: run \`cxt bs\` to catch bad patterns before commit
- **CI pipeline**: use \`cxt check --ci\` for automated quality gates
${CXT_SECTION_END}`;
}

export async function handleInit(opts: {
  remove?: boolean;
  dry?: boolean;
}): Promise<void> {
  const m = t();
  const claudeDir = join(homedir(), '.claude');
  const claudeMdPath = join(claudeDir, 'CLAUDE.md');

  // ANSI colors
  const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
  };

  // --remove: strip cxt section
  if (opts.remove) {
    if (!existsSync(claudeMdPath)) {
      console.log(`  ${c.dim}${claudeMdPath} not found — nothing to remove${c.reset}`);
      return;
    }

    const content = readFileSync(claudeMdPath, 'utf-8');
    const startIdx = content.indexOf(CXT_SECTION_START);
    const endIdx = content.indexOf(CXT_SECTION_END);

    if (startIdx === -1) {
      console.log(`  ${c.dim}No cxt section found in CLAUDE.md${c.reset}`);
      return;
    }

    const before = content.slice(0, startIdx).trimEnd();
    const after = content.slice(endIdx + CXT_SECTION_END.length).trimStart();
    const newContent = before + (after ? '\n\n' + after : '') + '\n';

    if (opts.dry) {
      console.log(`\n${c.bold}[dry-run]${c.reset} Would remove cxt section from ${c.cyan}${claudeMdPath}${c.reset}`);
      return;
    }

    writeFileSync(claudeMdPath, newContent, 'utf-8');
    console.log(`\n${c.green}Removed${c.reset} cxt section from ${c.cyan}${claudeMdPath}${c.reset}`);
    return;
  }

  // Ensure ~/.claude/ exists
  if (!existsSync(claudeDir)) {
    if (opts.dry) {
      console.log(`\n${c.bold}[dry-run]${c.reset} Would create ${c.cyan}${claudeDir}${c.reset}`);
    } else {
      mkdirSync(claudeDir, { recursive: true });
    }
  }

  const cxtSection = getCxtSection();
  let existing = '';

  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, 'utf-8');

    // Already has cxt section → update it
    const startIdx = existing.indexOf(CXT_SECTION_START);
    const endIdx = existing.indexOf(CXT_SECTION_END);

    if (startIdx !== -1 && endIdx !== -1) {
      const oldSection = existing.slice(startIdx, endIdx + CXT_SECTION_END.length);
      if (oldSection === cxtSection) {
        console.log(`\n${c.dim}cxt section already up to date in ${claudeMdPath}${c.reset}`);
        return;
      }

      if (opts.dry) {
        console.log(`\n${c.bold}[dry-run]${c.reset} Would update cxt section in ${c.cyan}${claudeMdPath}${c.reset}`);
        return;
      }

      const newContent = existing.slice(0, startIdx) + cxtSection + existing.slice(endIdx + CXT_SECTION_END.length);
      writeFileSync(claudeMdPath, newContent, 'utf-8');
      console.log(`\n${c.yellow}Updated${c.reset} cxt section in ${c.cyan}${claudeMdPath}${c.reset}`);
      return;
    }
  }

  // Append cxt section
  if (opts.dry) {
    console.log(`\n${c.bold}[dry-run]${c.reset} Would append cxt section to ${c.cyan}${claudeMdPath}${c.reset}`);
    console.log(`\n${c.dim}--- preview ---${c.reset}`);
    console.log(cxtSection);
    return;
  }

  const separator = existing.length > 0 ? '\n\n' : '';
  writeFileSync(claudeMdPath, existing + separator + cxtSection + '\n', 'utf-8');
  console.log(`\n${c.green}Added${c.reset} cxt section to ${c.cyan}${claudeMdPath}${c.reset}`);
  console.log(`  ${c.dim}Claude Code will now see cxt commands in every session.${c.reset}`);
  console.log(`  ${c.dim}Run \`cxt init --remove\` to undo.${c.reset}\n`);
}
