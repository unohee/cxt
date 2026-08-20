// ============================================
// ctx - CLI Export Handler
// Created: 2026-04-12
// Purpose: cxt export — GraphQL-like SDL 덤프
//   LLM/사람이 한 파일로 코드베이스 구조 + 상태를 조망할 수 있는 스냅샷.
// ============================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { resolveProjectId } from './checkHandler.js';
import type { CodeEntity } from '../registry/schema.js';
import { escapeTerminal, pathMatchesDir, resolveProjectDirFilter } from './outputSafety.js';

interface ExportOptions {
  output?: string;
  project?: string;
  dir?: string;
}

interface FileNode {
  fileName: string;
  filePath: string;
  entities: CodeEntity[];
}

interface DirNode {
  name: string;
  path: string;
  files: Map<string, FileNode>;
  children: Map<string, DirNode>;
}

function makeDir(name: string, path: string): DirNode {
  return { name, path, files: new Map(), children: new Map() };
}

function insertEntity(root: DirNode, e: CodeEntity): void {
  const parts = e.filePath.split('/');
  const fileName = parts.pop()!;
  let node = root;
  let acc = '';
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    let child = node.children.get(p);
    if (!child) {
      child = makeDir(p, acc);
      node.children.set(p, child);
    }
    node = child;
  }
  let file = node.files.get(fileName);
  if (!file) {
    file = { fileName, filePath: e.filePath, entities: [] };
    node.files.set(fileName, file);
  }
  file.entities.push(e);
}

function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\u2028\u2029]/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
}

const quoted = (s: string): string => `"${escapeString(s)}"`;
const token = (s: string): string => escapeString(s).replace(/[^A-Za-z0-9_.:/-]/g, (ch) =>
  `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
);

function entityAttrs(e: CodeEntity): string {
  const attrs: string[] = [];
  attrs.push(`status:${token(e.status)}`);
  attrs.push(`risk:${token(e.riskLevel)}`);
  attrs.push(`tested:${e.hasTests ? 'yes' : 'no'}`);
  if (e.lineStart) {
    attrs.push(`lines:${e.lineStart}${e.lineEnd ? `-${e.lineEnd}` : ''}`);
  }
  if (e.complexityScore !== undefined && e.complexityScore > 0) {
    attrs.push(`complexity:${e.complexityScore}`);
  }
  return attrs.join(', ');
}

/** entityId → 정방향 관계 요약 (export edge 렌더링용). */
type EdgeMap = Map<string, Array<{ name: string; type: string }>>;

function renderEntity(e: CodeEntity, indent: string, edges?: EdgeMap): string[] {
  const lines: string[] = [];
  const sig = e.signature ? ` signature:${quoted(e.signature)}` : '';
  const head = `${indent}${token(e.kind)} ${token(e.name)}${sig} [${entityAttrs(e)}]`;

  const inner: string[] = [];
  if (e.deprecatedReason) {
    inner.push(`${indent}  deprecated_reason: "${escapeString(e.deprecatedReason)}"`);
  }
  if (e.notes) {
    inner.push(`${indent}  note: "${escapeString(e.notes)}"`);
  }
  const unresolvedWarnings = (e.warnings ?? []).filter((w) => !w.resolved);
  for (const w of unresolvedWarnings) {
    inner.push(`${indent}  warning [${quoted(w.severity)}/${quoted(w.category)}]: ${quoted(w.message)}`);
  }
  const outEdges = edges?.get(e.id);
  if (outEdges && outEdges.length > 0) {
    const calls = outEdges.filter((r) => r.type === 'calls').map((r) => r.name);
    const inherits = outEdges.filter((r) => r.type !== 'calls').map((r) => `${r.type}:${r.name}`);
    if (calls.length > 0) inner.push(`${indent}  calls: ${calls.map(quoted).join(', ')}`);
    if (inherits.length > 0) inner.push(`${indent}  relations: ${inherits.map(quoted).join(', ')}`);
  }

  if (inner.length === 0) {
    lines.push(head);
  } else {
    lines.push(`${head} {`);
    lines.push(...inner);
    lines.push(`${indent}}`);
  }
  return lines;
}

interface DirAgg {
  total: number;
  untested: number;
  highRisk: number;
  deprecated: number;
}

function aggregate(node: DirNode): DirAgg {
  const agg: DirAgg = { total: 0, untested: 0, highRisk: 0, deprecated: 0 };
  for (const file of node.files.values()) {
    for (const e of file.entities) {
      agg.total++;
      if (!e.hasTests) agg.untested++;
      if (e.riskLevel === 'high') agg.highRisk++;
      if (e.status === 'deprecated') agg.deprecated++;
    }
  }
  for (const child of node.children.values()) {
    const childAgg = aggregate(child);
    agg.total += childAgg.total;
    agg.untested += childAgg.untested;
    agg.highRisk += childAgg.highRisk;
    agg.deprecated += childAgg.deprecated;
  }
  return agg;
}

function renderDir(node: DirNode, indent: string, edges?: EdgeMap): string[] {
  const lines: string[] = [];
  const agg = aggregate(node);
  const flags: string[] = [
    `entities:${agg.total}`,
    `untested:${agg.untested}`,
  ];
  if (agg.highRisk > 0) flags.push(`high_risk:${agg.highRisk}`);
  if (agg.deprecated > 0) flags.push(`deprecated:${agg.deprecated}`);

  const dirLabel = node.path === '' ? '.' : `${node.name}/`;
  lines.push(`${indent}directory ${quoted(dirLabel)} [${flags.join(', ')}] {`);

  const childIndent = indent + '  ';

  const sortedChildren = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const child of sortedChildren) {
    lines.push(...renderDir(child, childIndent, edges));
  }

  const sortedFiles = [...node.files.values()].sort((a, b) => a.fileName.localeCompare(b.fileName));
  for (const file of sortedFiles) {
    const ents = [...file.entities].sort((a, b) => (a.lineStart ?? 0) - (b.lineStart ?? 0));
    let untested = 0;
    let highRisk = 0;
    for (const e of ents) {
      if (!e.hasTests) untested++;
      if (e.riskLevel === 'high') highRisk++;
    }
    const fileFlags = [`entities:${ents.length}`];
    if (untested > 0) fileFlags.push(`untested:${untested}`);
    if (highRisk > 0) fileFlags.push(`high_risk:${highRisk}`);

    lines.push(`${childIndent}file ${quoted(file.fileName)} [${fileFlags.join(', ')}] {`);
    for (const e of ents) {
      lines.push(...renderEntity(e, childIndent + '  ', edges));
    }
    lines.push(`${childIndent}}`);
  }

  lines.push(`${indent}}`);
  return lines;
}

export async function handleExport(opts: ExportOptions): Promise<void> {
  try {
    const store = getRegistryStore();
    const projectPath = process.cwd();
    const projectId = opts.project ?? resolveProjectId(projectPath);
    const projectName = basename(projectPath) || 'unknown';

    const entities: CodeEntity[] = [];
    const pageSize = 5_000;
    for (let offset = 0; ; offset += pageSize) {
      const page = store.listEntities({ projectId, limit: pageSize, offset }).entities;
      entities.push(...page);
      if (page.length < pageSize) break;
    }

    // INT-1476: broken(좀비) 엔티티는 스냅샷에서 제외 — 사라진 코드가 구조도를 오염하지 않도록.
    const alive = entities.filter((e) => e.status !== 'broken');

    const dirFilter = resolveProjectDirFilter(projectPath, opts.dir);
    const filtered = dirFilter
      ? alive.filter((e) => pathMatchesDir(e.filePath, dirFilter))
      : alive;

    if (filtered.length === 0) {
      console.error(`# cxt export — no entities found${opts.dir ? ` under "${escapeTerminal(opts.dir)}"` : ''}`);
      console.error(`# Run \`cxt scan\` first.`);
      process.exitCode = 1;
      return;
    }

    const root = makeDir('', '');
    for (const e of filtered) insertEntity(root, e);

    const stats = store.getStats(projectId, dirFilter);
    const generatedAt = new Date().toISOString();

    const header: string[] = [
      `# cxt snapshot`,
      `# project: ${escapeString(projectName)} (${escapeString(projectId)})`,
      `# generated: ${generatedAt}`,
      `# entities: ${filtered.length}/${stats.total}` +
        (opts.dir ? ` (filtered by dir: ${JSON.stringify(opts.dir)})` : ''),
      `# stats: deprecated=${stats.deprecated}, untested=${stats.untested}, high_risk=${stats.highRisk}, with_warnings=${stats.withWarnings}`,
      `#`,
      `# Format: GraphQL-inspired tree. Each entity carries [status, risk, tested, lines].`,
      `# Edges: 'calls:' lists callees; 'extends/implements:' list base types (same-project only).`,
      `# Read this file instead of running glob/grep — it is the authoritative structure + call graph.`,
      ``,
    ];

    const edges = store.getAllOutgoingRelations(projectId);
    const body = renderDir(root, '', edges);
    const out = header.concat(body).join('\n') + '\n';

    if (opts.output) {
      const outPath = resolve(opts.output);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, out, 'utf-8');
      console.error(`# wrote ${filtered.length} entities → ${escapeTerminal(outPath)}`);
    } else {
      process.stdout.write(out);
    }
  } finally {
    closeRegistryStore();
  }
}
