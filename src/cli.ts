#!/usr/bin/env node
// ============================================
// ctx - CLI entry point
// Created: 2026-04-11
// Purpose: Code context toolkit CLI
// ============================================

import { Command } from 'commander';
import { getRegistryStore, closeRegistryStore } from './registry/sqliteStore.js';
import { resolveProjectId } from './cli/checkHandler.js';
import { t, setLocale, detectLocale } from './i18n.js';
import type { Locale } from './i18n.js';

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
  .name('ctx')
  .version('0.1.0')
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
  ${c.cyan}ctx scan${c.reset}                          ${m.helpScan}
  ${c.cyan}ctx scan -v${c.reset}                       ${m.helpScanVerbose}
  ${c.cyan}ctx check --stats${c.reset}                 ${m.helpCheckStats}
  ${c.cyan}ctx check src/index.ts${c.reset}            ${m.helpCheckFile}
  ${c.cyan}ctx check --search handleCheck${c.reset}    ${m.helpCheckSearch}
  ${c.cyan}ctx check --untested${c.reset}              ${m.helpCheckUntested}
  ${c.cyan}ctx check --high-risk${c.reset}             ${m.helpCheckHighRisk}
  ${c.cyan}ctx check --tree${c.reset}                  ${m.helpCheckTree}
  ${c.cyan}ctx check --ci${c.reset}                    ${m.helpCheckCi}
  ${c.cyan}ctx bs${c.reset}                            ${m.helpBs}
  ${c.cyan}ctx bs -v${c.reset}                         ${m.helpBsVerbose}
  ${c.cyan}ctx annotate file::fn --deprecate "reason"${c.reset}
  ${c.cyan}ctx annotate file::fn --tag team=backend${c.reset}
  ${c.cyan}ctx inject${c.reset}                        ${m.helpInject}

${c.bold}${m.helpSupportedLangs}:${c.reset}
  TypeScript/JS  Python  Go  Rust  Java  C/C++  C#

${c.bold}${m.helpStorage}:${c.reset}
  ${c.dim}~/.ctx/registry.db${c.reset} ${m.helpStorageDesc}
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
  .option('--ci', 'CI/CD mode: JSON output, exit 1 on critical issues')
  .option('-v, --verbose', 'Verbose output (with --scan)')
  .option('--project <id>', 'Filter by project ID')
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

program.parse();
