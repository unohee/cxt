// ============================================
// cxt - CLI Project Handler
// Created: 2026-06-11
// Purpose: 프로젝트 위생 명령 — list / rm / prune / vacuum (INT-1479)
// Dependencies: registry/sqliteStore
// ============================================

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m',
};

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`${message} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

export async function handleProjectList(): Promise<void> {
  const store = getRegistryStore();
  try {
    const projects = store.listProjects();
    if (projects.length === 0) {
      console.log(`${c.dim}(레지스트리가 비어 있습니다)${c.reset}`);
      return;
    }
    console.log(`\n${c.bold}등록 프로젝트 (${projects.length}개)${c.reset}\n`);
    for (const p of projects) {
      const brokenStr = p.brokenCount > 0
        ? ` ${c.yellow}broken:${p.brokenCount}${c.reset}`
        : '';
      console.log(
        `  ${c.cyan}${p.projectId.padEnd(40)}${c.reset}` +
        `${c.bold}${String(p.entityCount).padStart(6)}${c.reset} entities${brokenStr}`
      );
    }
    console.log();
  } finally {
    closeRegistryStore();
  }
}

export async function handleProjectRm(
  projectId: string,
  opts: { yes?: boolean },
): Promise<void> {
  const store = getRegistryStore();
  try {
    const projects = store.listProjects();
    const target = projects.find(p => p.projectId === projectId);
    if (!target) {
      console.log(`${c.red}✗${c.reset} 프로젝트 '${projectId}'를 찾을 수 없습니다.`);
      process.exitCode = 1;
      return;
    }

    if (!opts.yes) {
      const ok = await confirm(
        `${c.yellow}⚠${c.reset} '${projectId}' 프로젝트의 엔티티 ${target.entityCount}개를 삭제합니다. 계속?`
      );
      if (!ok) { console.log('취소됨.'); return; }
    }

    const removed = store.deleteProject(projectId);
    console.log(`${c.green}✓${c.reset} '${projectId}' 제거 완료 (${removed}개 삭제됨)`);
  } finally {
    closeRegistryStore();
  }
}

export async function handleProjectPrune(
  opts: { project?: string; yes?: boolean },
): Promise<void> {
  const store = getRegistryStore();
  try {
    const projects = store.listProjects();
    const totalBroken = opts.project
      ? (projects.find(p => p.projectId === opts.project)?.brokenCount ?? 0)
      : projects.reduce((s, p) => s + p.brokenCount, 0);

    if (totalBroken === 0) {
      console.log(`${c.green}✓${c.reset} broken 엔티티 없음 — 정리 불필요`);
      return;
    }

    if (!opts.yes) {
      const scope = opts.project ? `'${opts.project}'` : '전체 프로젝트';
      const ok = await confirm(
        `${c.yellow}⚠${c.reset} ${scope}의 broken 엔티티 ${totalBroken}개를 삭제합니다. 계속?`
      );
      if (!ok) { console.log('취소됨.'); return; }
    }

    const removed = store.pruneBroken(opts.project);
    console.log(`${c.green}✓${c.reset} broken 엔티티 ${removed}개 정리 완료`); // cxt-ignore: fake_execution
  } finally {
    closeRegistryStore();
  }
}

export async function handleProjectVacuum(opts: { keepDays?: string }): Promise<void> {
  const store = getRegistryStore();
  try {
    const days = parseInt(opts.keepDays ?? '30', 10);
    console.log(`${c.dim}이벤트 정리 (${days}일 이전) + DB VACUUM 중...${c.reset}`);
    store.vacuum(days);
    console.log(`${c.green}✓${c.reset} vacuum 완료`); // cxt-ignore: fake_execution
  } finally {
    closeRegistryStore();
  }
}
