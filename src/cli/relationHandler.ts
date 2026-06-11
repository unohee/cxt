// ============================================
// cxt - CLI Relation Handler
// Created: 2026-05-30
// Purpose: 관계 그래프 질의 — who-calls / calls / impact
//          LLM이 grep 없이 caller/callee/영향범위를 조회하게 한다.
// Dependencies: registry/sqliteStore
// ============================================

import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { resolveProjectId } from './checkHandler.js';
import { t } from '../i18n.js';
import type { CodeEntity } from '../registry/schema.js';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m',
};

export interface RelationOptions {
  project?: string;
  type?: string;       // calls | extends | implements (필터)
  depth?: string;      // impact 전용
  json?: boolean;
}

/**
 * 이름으로 엔티티를 찾되, 동명이인이면 후보를 안내하고 중단.
 * 단일이면 그 엔티티 반환.
 */
function resolveTarget(name: string, projectId: string, json: boolean): CodeEntity | null {
  const m = t();
  const store = getRegistryStore();
  const matches = store.findEntitiesByName(name, projectId);
  if (matches.length === 0) {
    if (json) console.log(JSON.stringify({ error: 'not_found', name }));
    else console.log(`${c.red}${m.relNotFound(name)}${c.reset}`);
    return null;
  }
  if (matches.length > 1) {
    if (json) {
      console.log(JSON.stringify({ error: 'ambiguous', name, candidates: matches.map(m => m.qualifiedName) }));
    } else {
      console.log(`${c.yellow}${m.relAmbiguous(name, matches.length)}${c.reset}`);
      for (const match of matches) console.log(`    ${c.cyan}${match.qualifiedName}${c.reset} ${c.dim}[${match.kind}] ${match.filePath}:${match.lineStart}${c.reset}`);
      console.log(`  ${c.dim}${m.relUseQualified}${c.reset}`);
    }
    return null;
  }
  return matches[0];
}

/** qualifiedName(`file::name`) 또는 단순 name 모두 허용. */
function lookup(nameOrQualified: string, projectId: string, json: boolean): CodeEntity | null {
  const m = t();
  const store = getRegistryStore();
  if (nameOrQualified.includes('::')) {
    const { entities } = store.listEntities({ projectId, limit: 200_000, offset: 0 });
    const hit = entities.find(e => e.qualifiedName === nameOrQualified && e.status !== 'broken');
    if (!hit) {
      if (json) console.log(JSON.stringify({ error: 'not_found', name: nameOrQualified }));
      else console.log(`${c.red}${m.relNotFoundQualified(nameOrQualified)}${c.reset}`);
      return null;
    }
    return hit;
  }
  return resolveTarget(nameOrQualified, projectId, json);
}

/** cxt who-calls <name> — 역방향 (이 엔티티를 호출하는 주체들). */
export async function handleWhoCalls(name: string, opts: RelationOptions): Promise<void> {
  const m = t();
  const projectId = opts.project ?? resolveProjectId(process.cwd());
  const store = getRegistryStore();
  try {
    const target = lookup(name, projectId, !!opts.json);
    if (!target) { process.exitCode = 1; return; }

    const relType = opts.type as ('calls' | 'extends' | 'implements' | undefined);
    const callers = store.getIncomingRelations(target.id, relType);

    if (opts.json) {
      console.log(JSON.stringify({
        target: target.qualifiedName,
        callers: callers.map(r => ({ name: r.sourceName, file: r.sourceFile, type: r.relationType })),
      }, null, 2));
      return;
    }

    console.log(`${c.bold}${m.relWhoCalls(target.name, target.filePath, target.lineStart)}${c.reset}`);
    if (callers.length === 0) {
      console.log(`  ${c.dim}${m.relNone}${c.reset}\n`);
      return;
    }
    for (const r of callers) {
      console.log(`  ${c.gray}←${c.reset} ${c.cyan}${r.sourceName}${c.reset} ${c.dim}[${r.relationType}] ${r.sourceFile}${c.reset}`);
    }
    console.log(`  ${c.dim}${m.relTotal(callers.length)}${c.reset}\n`);
  } finally {
    closeRegistryStore();
  }
}

/** cxt calls <name> — 정방향 (이 엔티티가 호출하는 대상들). */
export async function handleCalls(name: string, opts: RelationOptions): Promise<void> {
  const m = t();
  const projectId = opts.project ?? resolveProjectId(process.cwd());
  const store = getRegistryStore();
  try {
    const target = lookup(name, projectId, !!opts.json);
    if (!target) { process.exitCode = 1; return; }

    const relType = opts.type as ('calls' | 'extends' | 'implements' | undefined);
    const callees = store.getOutgoingRelations(target.id, relType);

    if (opts.json) {
      console.log(JSON.stringify({
        source: target.qualifiedName,
        callees: callees.map(r => ({ name: r.targetName, file: r.targetFile, type: r.relationType })),
      }, null, 2));
      return;
    }

    console.log(`${c.bold}${m.relCalls(target.name, target.filePath, target.lineStart)}${c.reset}`);
    if (callees.length === 0) {
      console.log(`  ${c.dim}${m.relCallsNone}${c.reset}\n`);
      return;
    }
    for (const r of callees) {
      console.log(`  ${c.gray}→${c.reset} ${c.cyan}${r.targetName}${c.reset} ${c.dim}[${r.relationType}] ${r.targetFile}${c.reset}`);
    }
    console.log(`  ${c.dim}${m.relTotal(callees.length)}${c.reset}\n`);
  } finally {
    closeRegistryStore();
  }
}

/** cxt impact <name> — transitive 역방향 (고치면 영향받는 전체). */
export async function handleImpact(name: string, opts: RelationOptions): Promise<void> {
  const m = t();
  const projectId = opts.project ?? resolveProjectId(process.cwd());
  const store = getRegistryStore();
  try {
    const target = lookup(name, projectId, !!opts.json);
    if (!target) { process.exitCode = 1; return; }

    const maxDepth = opts.depth ? Math.max(1, parseInt(opts.depth, 10) || 5) : 5;
    const impacted = store.getImpactSet(target.id, maxDepth);

    if (opts.json) {
      console.log(JSON.stringify({
        target: target.qualifiedName,
        maxDepth,
        impactCount: impacted.length,
        impacted: impacted.map(i => ({ name: i.name, file: i.filePath, depth: i.depth })),
      }, null, 2));
      return;
    }

    console.log(`${c.bold}${m.relImpact(target.name, target.filePath, target.lineStart)}${c.reset}`);
    if (impacted.length === 0) {
      console.log(`  ${c.green}${m.relImpactNone}${c.reset}\n`);
      return;
    }
    const byDepth = new Map<number, typeof impacted>();
    for (const i of impacted) {
      const arr = byDepth.get(i.depth) ?? [];
      arr.push(i);
      byDepth.set(i.depth, arr);
    }
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      const items = byDepth.get(depth)!;
      const indent = '  '.repeat(depth);
      const tag = depth === 1
        ? `${c.red}${m.relImpactDirect}${c.reset}`
        : `${c.yellow}${m.relImpactIndirect(depth)}${c.reset}`;
      console.log(`  ${c.dim}─ ${tag}${c.reset}`);
      for (const i of items) {
        console.log(`  ${indent}${c.gray}↑${c.reset} ${i.name} ${c.dim}${i.filePath}${c.reset}`);
      }
    }
    console.log(`\n  ${c.bold}${m.relImpactTotal(impacted.length)}${c.reset}\n`);
  } finally {
    closeRegistryStore();
  }
}
