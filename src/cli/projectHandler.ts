// ============================================
// cxt - CLI Project Handler
// Created: 2026-06-11
// Purpose: 레지스트리 위생 명령 — projects(list) / project rm / prune / vacuum (INT-1476/1479)
// Dependencies: registry/sqliteStore, i18n
// ============================================

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { resolveProjectId } from './checkHandler.js';
import { t } from '../i18n.js';
import { escapeTerminal } from './outputSafety.js';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m',
};

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

/**
 * `cxt project rm <id|path>` — 인자가 존재하는 디렉터리 경로면
 * 프로젝트 ID로 해석(package.json name 등), 아니면 ID 그대로 사용.
 */
function resolveProjectArg(idOrPath: string): string {
  const abs = resolve(idOrPath);
  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) return resolveProjectId(abs);
  } catch { /* 경로 해석 실패 시 ID로 취급 */ } // cxt-ignore: exception_hiding
  return idOrPath;
}

export async function handleProjectList(): Promise<void> {
  const m = t();
  const store = getRegistryStore();
  try {
    const projects = store.listProjects();
    if (projects.length === 0) {
      console.log(`${c.dim}${m.projNoProjects}${c.reset}`);
      return;
    }
    console.log(`\n${c.bold}${m.projHeader(projects.length)}${c.reset}\n`);
    for (const p of projects) {
      const brokenStr = p.brokenCount > 0
        ? ` ${c.yellow}broken:${p.brokenCount}${c.reset}`
        : '';
      console.log(
        `  ${c.cyan}${escapeTerminal(p.projectId).padEnd(40)}${c.reset}` +
        `${c.bold}${String(p.entityCount).padStart(6)}${c.reset} entities${brokenStr}`
      );
    }
    console.log();
  } finally {
    closeRegistryStore();
  }
}

export async function handleProjectRm(
  idOrPath: string,
  opts: { yes?: boolean },
): Promise<void> {
  const m = t();
  const store = getRegistryStore();
  try {
    const projectId = resolveProjectArg(idOrPath);
    const projects = store.listProjects();
    const target = projects.find(p => p.projectId === projectId);
    if (!target) {
      console.log(`${c.red}${escapeTerminal(m.projNotFound(projectId))}${c.reset}`);
      process.exitCode = 1;
      return;
    }

    if (!opts.yes) {
      const ok = await confirm(
        `${c.yellow}${escapeTerminal(m.projRmConfirm(projectId, target.entityCount))}${c.reset}`
      );
      if (!ok) { console.log(m.projCancelled); return; }
    }

    const removed = store.deleteProject(projectId);
    console.log(`${c.green}${escapeTerminal(m.projRmDone(projectId, removed))}${c.reset}`);
  } finally {
    closeRegistryStore();
  }
}

export async function handleProjectPrune(
  opts: { project?: string; events?: boolean; days?: string; yes?: boolean },
): Promise<void> {
  const m = t();
  const store = getRegistryStore();
  try {
    // ── 모드 1: 오래된 events 정리 (cxt prune --events [--days N]) ──
    if (opts.events) {
      const days = parseRetentionDays(opts.days ?? '30');
      if (!opts.yes) {
        const ok = await confirm(`${c.yellow}${escapeTerminal(m.projPruneEventsConfirm(days))}${c.reset}`);
        if (!ok) { console.log(m.projCancelled); return; }
      }
      const removed = store.pruneEvents(days);
      console.log(`${c.green}${escapeTerminal(m.projPruneEventsDone(removed, days))}${c.reset}`);
      return;
    }

    // ── 모드 2 (기본): broken(좀비) 엔티티 정리 ──
    const projects = store.listProjects();
    const totalBroken = opts.project
      ? (projects.find(p => p.projectId === opts.project)?.brokenCount ?? 0)
      : projects.reduce((s, p) => s + p.brokenCount, 0);

    if (totalBroken === 0) {
      console.log(`${c.green}${m.projPruneNone}${c.reset}`);
      return;
    }

    if (!opts.yes) {
      const scope = opts.project ? `'${opts.project}'` : m.projAllScope;
      const ok = await confirm(
        `${c.yellow}${escapeTerminal(m.projPruneConfirm(scope, totalBroken))}${c.reset}`
      );
      if (!ok) { console.log(m.projCancelled); return; }
    }

    const removed = store.pruneBroken(opts.project);
    console.log(`${c.green}${escapeTerminal(m.projPruneDone(removed))}${c.reset}`); // cxt-ignore: fake_execution
  } finally {
    closeRegistryStore();
  }
}

export async function handleProjectVacuum(
  opts: { keepDays?: string; yes?: boolean },
): Promise<void> {
  const m = t();
  const store = getRegistryStore();
  try {
    // keepDays가 주어지면 이벤트 정리 동반, 아니면 순수 VACUUM.
    if (opts.keepDays !== undefined) {
      const days = parseRetentionDays(opts.keepDays);
      if (!opts.yes) {
        const ok = await confirm(`${c.yellow}${escapeTerminal(m.projPruneEventsConfirm(days))}${c.reset}`);
        if (!ok) { console.log(m.projCancelled); return; }
      }
      console.log(`${c.dim}${escapeTerminal(m.projVacuumEventsRunning(days))}${c.reset}`);
      store.pruneEvents(days);
    } else {
      console.log(`${c.dim}${m.projVacuumRunning}${c.reset}`);
    }
    store.vacuum();
    console.log(`${c.green}${escapeTerminal(m.projVacuumDone)}${c.reset}`); // cxt-ignore: fake_execution
  } finally {
    closeRegistryStore();
  }
}

export function parseRetentionDays(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Retention days must be a non-negative integer: ${escapeTerminal(value)}`);
  const days = Number(value);
  if (!Number.isSafeInteger(days)) throw new Error(`Retention days are outside the supported range: ${escapeTerminal(value)}`);
  return days;
}
