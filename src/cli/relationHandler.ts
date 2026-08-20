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
import type { CodeEntity, RelationType } from '../registry/schema.js';
import { escapeTerminal } from './outputSafety.js';

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

const RELATION_TYPES = new Set<RelationType>(['calls', 'extends', 'implements', 'uses', 'overrides']);
const safe = escapeTerminal;

function parseRelationType(value: string | undefined, json: boolean): RelationType | undefined | null {
  if (value === undefined) return undefined;
  if (RELATION_TYPES.has(value as RelationType)) return value as RelationType;
  const expected = [...RELATION_TYPES];
  if (json) console.log(JSON.stringify({ error: 'invalid_relation_type', value, expected }));
  else console.error(`${c.red}Invalid relation type: ${safe(value)}. Expected one of: ${expected.join(', ')}${c.reset}`);
  process.exitCode = 1;
  return null;
}

const MAX_IMPACT_DEPTH = 100;
function parseImpactDepth(value: string | undefined, json: boolean): number | null {
  const invalid = (): null => {
    if (json) console.log(JSON.stringify({ error: 'invalid_depth', value, min: 1, max: MAX_IMPACT_DEPTH }));
    else console.error(`${c.red}Invalid depth: ${safe(value)}. Expected an integer from 1 to ${MAX_IMPACT_DEPTH}.${c.reset}`);
    process.exitCode = 1;
    return null;
  };
  if (value === undefined) return 5;
  if (!/^\d+$/.test(value)) return invalid();
  const depth = Number(value);
  return Number.isSafeInteger(depth) && depth >= 1 && depth <= MAX_IMPACT_DEPTH ? depth : invalid();
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
    else console.log(`${c.red}${safe(m.relNotFound(name))}${c.reset}`);
    return null;
  }
  if (matches.length > 1) {
    if (json) {
      console.log(JSON.stringify({ error: 'ambiguous', name, candidates: matches.map(m => m.qualifiedName) }));
    } else {
      console.log(`${c.yellow}${safe(m.relAmbiguous(name, matches.length))}${c.reset}`);
      for (const match of matches) console.log(`    ${c.cyan}${safe(match.qualifiedName)}${c.reset} ${c.dim}[${safe(match.kind)}] ${safe(match.filePath)}:${match.lineStart}${c.reset}`);
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
    const hit = store.findEntityByQualifiedName(nameOrQualified, projectId);
    if (!hit) {
      if (json) console.log(JSON.stringify({ error: 'not_found', name: nameOrQualified }));
      else console.log(`${c.red}${safe(m.relNotFoundQualified(nameOrQualified))}${c.reset}`);
      return null;
    }
    return hit;
  }
  return resolveTarget(nameOrQualified, projectId, json);
}

/** cxt who-calls <name> — 역방향 (이 엔티티를 호출하는 주체들). */
export async function handleWhoCalls(name: string, opts: RelationOptions): Promise<void> {
  const m = t();
  const projectId = opts.project?.trim() || resolveProjectId(process.cwd());
  const store = getRegistryStore();
  try {
    const relType = parseRelationType(opts.type, !!opts.json);
    if (relType === null) return;
    const target = lookup(name, projectId, !!opts.json);
    if (!target) { process.exitCode = 1; return; }

    const callers = store.getIncomingRelations(target.id, relType);

    if (opts.json) {
      console.log(JSON.stringify({
        target: target.qualifiedName,
        callers: callers.map(r => ({ name: r.sourceName, file: r.sourceFile, type: r.relationType })),
      }, null, 2));
      return;
    }

    console.log(`${c.bold}${safe(m.relWhoCalls(target.name, target.filePath, target.lineStart))}${c.reset}`);
    if (callers.length === 0) {
      console.log(`  ${c.dim}${m.relNone}${c.reset}\n`);
      return;
    }
    for (const r of callers) {
      console.log(`  ${c.gray}←${c.reset} ${c.cyan}${safe(r.sourceName)}${c.reset} ${c.dim}[${safe(r.relationType)}] ${safe(r.sourceFile)}${c.reset}`);
    }
    console.log(`  ${c.dim}${m.relTotal(callers.length)}${c.reset}\n`);
  } finally {
    closeRegistryStore();
  }
}

/** cxt calls <name> — 정방향 (이 엔티티가 호출하는 대상들). */
export async function handleCalls(name: string, opts: RelationOptions): Promise<void> {
  const m = t();
  const projectId = opts.project?.trim() || resolveProjectId(process.cwd());
  const store = getRegistryStore();
  try {
    const relType = parseRelationType(opts.type, !!opts.json);
    if (relType === null) return;
    const target = lookup(name, projectId, !!opts.json);
    if (!target) { process.exitCode = 1; return; }

    const callees = store.getOutgoingRelations(target.id, relType);

    if (opts.json) {
      console.log(JSON.stringify({
        source: target.qualifiedName,
        callees: callees.map(r => ({ name: r.targetName, file: r.targetFile, type: r.relationType })),
      }, null, 2));
      return;
    }

    console.log(`${c.bold}${safe(m.relCalls(target.name, target.filePath, target.lineStart))}${c.reset}`);
    if (callees.length === 0) {
      console.log(`  ${c.dim}${m.relCallsNone}${c.reset}\n`);
      return;
    }
    for (const r of callees) {
      console.log(`  ${c.gray}→${c.reset} ${c.cyan}${safe(r.targetName)}${c.reset} ${c.dim}[${safe(r.relationType)}] ${safe(r.targetFile)}${c.reset}`);
    }
    console.log(`  ${c.dim}${m.relTotal(callees.length)}${c.reset}\n`);
  } finally {
    closeRegistryStore();
  }
}

/** cxt impact <name> — transitive 역방향 (고치면 영향받는 전체). */
export async function handleImpact(name: string, opts: RelationOptions): Promise<void> {
  const m = t();
  const projectId = opts.project?.trim() || resolveProjectId(process.cwd());
  const store = getRegistryStore();
  try {
    const maxDepth = parseImpactDepth(opts.depth, !!opts.json);
    if (maxDepth === null) return;
    const target = lookup(name, projectId, !!opts.json);
    if (!target) { process.exitCode = 1; return; }

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

    console.log(`${c.bold}${safe(m.relImpact(target.name, target.filePath, target.lineStart))}${c.reset}`);
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
        console.log(`  ${indent}${c.gray}↑${c.reset} ${safe(i.name)} ${c.dim}${safe(i.filePath)}${c.reset}`);
      }
    }
    console.log(`\n  ${c.bold}${m.relImpactTotal(impacted.length)}${c.reset}\n`);
  } finally {
    closeRegistryStore();
  }
}
