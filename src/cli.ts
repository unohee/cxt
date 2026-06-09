#!/usr/bin/env node
// ============================================
// ctx - CLI entry point
// Created: 2026-04-11
// Purpose: Code context toolkit CLI
// ============================================

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getRegistryStore, closeRegistryStore } from './registry/sqliteStore.js';
import { resolveProjectId } from './cli/checkHandler.js';
import { t, setLocale, detectLocale } from './i18n.js';
import type { Locale } from './i18n.js';

// dist/cli.js → ../package.json (npm packs dist/ + package.json side by side)
const PKG_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const program = new Command();

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

program
  .name('cxt')
  .version(PKG_VERSION)
  .description('Code context toolkit — entity registry, BS detector, and AI context injection')
  .option('--lang <locale>', 'Language: en, ko (default: auto-detect from LANG)')
  .hook('preAction', (thisCommand) => {
    const lang = thisCommand.opts().lang as string | undefined;
    if (lang && (lang === 'en' || lang === 'ko')) {
      setLocale(lang as Locale);
    } else {
      setLocale(detectLocale());
    }
  })
  .addHelpText('after', () => {
    // lazy eval so --lang can take effect
    setLocale(program.opts().lang as Locale ?? detectLocale());
    const m = t();
    return `
${c.bold}Examples:${c.reset}
  ${c.cyan}cxt scan${c.reset}                          ${m.helpScan}
  ${c.cyan}cxt scan -v${c.reset}                       ${m.helpScanVerbose}
  ${c.cyan}cxt check --stats${c.reset}                 ${m.helpCheckStats}
  ${c.cyan}cxt check src/index.ts${c.reset}            ${m.helpCheckFile}
  ${c.cyan}cxt check --search handleCheck${c.reset}    ${m.helpCheckSearch}
  ${c.cyan}cxt check --untested${c.reset}              ${m.helpCheckUntested}
  ${c.cyan}cxt check --high-risk${c.reset}             ${m.helpCheckHighRisk}
  ${c.cyan}cxt check --tree${c.reset}                  ${m.helpCheckTree}
  ${c.cyan}cxt check --ci${c.reset}                    ${m.helpCheckCi}
  ${c.cyan}cxt bs${c.reset}                            ${m.helpBs}
  ${c.cyan}cxt bs -v${c.reset}                         ${m.helpBsVerbose}
  ${c.cyan}cxt audit${c.reset}                         BS scan + registry integrity audit
  ${c.cyan}cxt audit --json${c.reset}                  Audit in CI mode (exit 1 on critical)
  ${c.cyan}cxt annotate file::fn --deprecate "reason"${c.reset}
  ${c.cyan}cxt annotate file::fn --tag team=backend${c.reset}
  ${c.cyan}cxt inject${c.reset}                        ${m.helpInject}
  ${c.cyan}cxt export -o .cxt/structure.gql${c.reset}  Export SDL snapshot for LLMs
  ${c.cyan}cxt loc${c.reset}                           File LOC report (sorted by size)
  ${c.cyan}cxt loc --dir src --no-blank${c.reset}      LOC excluding blank lines

${c.bold}${m.helpSupportedLangs}:${c.reset}
  TypeScript/JS  Python  Go  Rust  Java  C/C++  C#

${c.bold}${m.helpStorage}:${c.reset}
  ${c.dim}~/.cxt/registry.db${c.reset} ${m.helpStorageDesc}
`;
  });

// ---- check ----
program
  .command('check')
  .description('Check code registry for a file or show registry stats')
  .argument('[filePath]', 'File path to inspect (relative to project root)')
  .option('--stats', 'Show overall registry statistics')
  .option('--deprecated', 'List all deprecated entities')
  .option('--untested', 'List all untested entities')
  .option('--high-risk', 'List all high-risk entities')
  .option('--tag <tag>', 'List entities with a specific tag')
  .option('--search <query>', 'Full-text search entities')
  .option('--scan', 'Scan entire repository and sync to registry')
  .option('--bs', 'Scan for BS patterns (bad code smells)')
  .option('--tree', 'Display codebase tree with entity counts and risk')
  .option('--dir <path>', 'Filter by directory prefix (combine with --tree or alone)')
  .option('--kind <kind>', 'Filter by entity kind (function|class|module|type|constant)')
  .option('--ci', 'CI/CD mode: JSON output, exit 1 on critical issues')
  .option('-v, --verbose', 'Verbose output (with --scan)')
  .option('--project <id>', 'Filter by project ID')
  .option('--global', 'With --stats: aggregate across all projects (default: current project only)')
  .action(async (filePath, opts) => {
    const { handleCheck } = await import('./cli/checkHandler.js');
    await handleCheck(filePath, opts);
  });

// ---- scan (shortcut) ----
program
  .command('scan')
  .description('Scan codebase and sync entities to registry')
  .option('-v, --verbose', 'Verbose output')
  .option('--project <id>', 'Project ID override')
  .action(async (opts) => {
    const { handleCheck } = await import('./cli/checkHandler.js');
    await handleCheck(undefined, { scan: true, verbose: opts.verbose, project: opts.project });
  });

// ---- bs (shortcut) ----
program
  .command('bs')
  .description('Scan for BS patterns (bad code smells)')
  .option('-v, --verbose', 'Verbose output')
  .action(async (opts) => {
    const { handleCheck } = await import('./cli/checkHandler.js');
    await handleCheck(undefined, { bs: true, verbose: opts.verbose });
  });

// ---- annotate ----
program
  .command('annotate')
  .description('Annotate entity metadata')
  .argument('<qualifiedName>', 'Entity qualified name (file::name)')
  .option('--deprecate [reason]', 'Mark as deprecated')
  .option('--status <status>', 'Change status (active|deprecated|experimental|planned|broken)')
  .option('--tag <tag>', 'Add tag (key or key=value)')
  .option('--untag <tag>', 'Remove tag')
  .option('--note <text>', 'Add a note')
  .option('--risk <level>', 'Set risk level (low|medium|high)')
  .option('--warn <spec>', 'Add warning (severity/category: message)')
  .action(async (qualifiedName, opts) => {
    const { handleAnnotate } = await import('./cli/checkHandler.js');
    await handleAnnotate(qualifiedName, opts);
  });

// ---- inject ----
program
  .command('inject')
  .description('Output concise registry summary for Claude Code SessionStart hook')
  .option('--project <id>', 'Project ID override')
  .action(async (opts) => {
    try {
      const m = t();
      const store = getRegistryStore();
      const projectPath = process.cwd();
      const projectId = opts.project ?? resolveProjectId(projectPath);
      const projectName = projectPath.split('/').pop() ?? 'unknown';
      const stats = store.getStats(projectId);

      console.log(m.injectHeader(projectName));
      console.log(`  Total entities:  ${stats.total}`);
      console.log(`  Deprecated:      ${stats.deprecated}`);
      console.log(`  Untested:        ${stats.untested}`);
      console.log(`  High risk:       ${stats.highRisk}`);

      // 관계 그래프 가용성 — LLM에게 who-calls/impact 사용 가능 여부를 알린다.
      const relCount = store.countRelations(projectId);
      if (relCount > 0) {
        console.log(`  Call graph:      ${relCount} edges — use \`cxt who-calls <name>\` / \`cxt impact <name>\` instead of grep`);
      } else if (stats.total > 0) {
        console.log(`  Call graph:      none — run \`cxt scan\` to enable who-calls/impact relation queries`);
      }

      if (stats.byKind.length > 0) {
        console.log(`  By kind:`);
        for (const { kind, count } of stats.byKind) {
          console.log(`    ${kind.padEnd(12)} ${count}`);
        }
      }

      const highRisk = store.highRiskEntities(projectId);
      if (highRisk.length > 0) {
        console.log(`\n${m.highRiskHeader}`);
        for (const e of highRisk.slice(0, 10)) {
          const loc = e.lineStart ? `${e.lineStart}${e.lineEnd ? `-${e.lineEnd}` : ''}` : '';
          const testIcon = e.hasTests ? 'test:✓' : 'test:✗';
          console.log(`  ${e.kind} ${e.name}:${loc}  ● ${e.status}  ${testIcon}  risk:HIGH`);
        }
        if (highRisk.length > 10) {
          console.log(`  ...and ${highRisk.length - 10} more`);
        }
      }
    } finally {
      closeRegistryStore();
    }
  });

// ---- export ----
program
  .command('export')
  .description('Export codebase structure as GraphQL-like SDL snapshot (LLM-friendly)')
  .option('-o, --output <path>', 'Write to file (default: stdout)')
  .option('--project <id>', 'Project ID override')
  .option('--dir <path>', 'Limit to entities under this directory prefix')
  .action(async (opts) => {
    const { handleExport } = await import('./cli/exportHandler.js');
    await handleExport(opts);
  });

// ---- loc ----
program
  .command('loc')
  .description('Show LOC (lines of code) per file, sorted by size')
  .option('--dir <path>', 'Limit to files under this directory prefix')
  .option('--ext <exts>', 'Comma-separated extensions to include (e.g. ts,py)')
  .option('--no-blank', 'Exclude blank lines from count')
  .option('--no-comments', 'Exclude comment lines from count')
  .option('--entities', 'Show registered entity count per file (requires prior scan)')
  .option('--project <id>', 'Project ID override (used with --entities)')
  .action(async (opts) => {
    const { handleLoc } = await import('./cli/locHandler.js');
    await handleLoc({
      dir: opts.dir,
      ext: opts.ext,
      noBlank: opts.blank === false,
      noComments: opts.comments === false,
      entities: opts.entities,
      project: opts.project,
    });
  });

// ---- init ----
program
  .command('init')
  .description('Inject cxt usage guide into AI agent instruction files (claude/codex/gemini)')
  .option('--target <list>', 'Targets: claude,codex,gemini,local-claude,local-agent,local-agents,all (default: claude)')
  .option('--path <file>', 'Custom file path (overrides --target)')
  .option('--remove', 'Remove cxt section from target files')
  .option('--dry', 'Preview changes without writing')
  .action(async (opts) => {
    const { handleInit } = await import('./cli/initHandler.js');
    await handleInit(opts);
  });

// ---- who-calls (역방향 관계) ----
program
  .command('who-calls <name>')
  .alias('callers')
  .description('Show entities that reference (call/extend) the given entity')
  .option('--project <id>', 'Project ID override')
  .option('--type <type>', 'Filter by relation type: calls | extends | implements')
  .option('--json', 'JSON output')
  .action(async (name, opts) => {
    const { handleWhoCalls } = await import('./cli/relationHandler.js');
    await handleWhoCalls(name, opts);
  });

// ---- calls (정방향 관계) ----
program
  .command('calls <name>')
  .alias('callees')
  .description('Show entities referenced (called/extended) by the given entity')
  .option('--project <id>', 'Project ID override')
  .option('--type <type>', 'Filter by relation type: calls | extends | implements')
  .option('--json', 'JSON output')
  .action(async (name, opts) => {
    const { handleCalls } = await import('./cli/relationHandler.js');
    await handleCalls(name, opts);
  });

// ---- impact (transitive 역방향) ----
program
  .command('impact <name>')
  .description('Transitive impact analysis: all entities affected if <name> changes')
  .option('--project <id>', 'Project ID override')
  .option('--depth <n>', 'Max BFS depth (default: 5)')
  .option('--json', 'JSON output')
  .action(async (name, opts) => {
    const { handleImpact } = await import('./cli/relationHandler.js');
    await handleImpact(name, opts);
  });

// ---- audit (BS + registry 종합 감사) ----
program
  .command('audit')
  .description('Code audit: BS pattern scan + registry integrity (untested/high-risk/deprecated)')
  .option('--json', 'JSON output, exit 1 on critical (CI mode)')
  .option('--quick', 'BS patterns only — skip registry stats')
  .option('--dir <path>', 'Limit to a directory prefix')
  .option('--project <id>', 'Project ID override')
  .option('-v, --verbose', 'Per-file issue detail')
  .action(async (opts) => {
    const { handleAudit } = await import('./cli/auditHandler.js');
    await handleAudit(opts);
  });

program.parse();
