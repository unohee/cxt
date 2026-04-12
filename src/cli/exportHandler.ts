// ============================================
// ctx - CLI Export Handler
// Created: 2026-04-12
// Purpose: cxt export — GraphQL-like SDL 덤프
//   LLM/사람이 한 파일로 코드베이스 구조 + 상태를 조망할 수 있는 스냅샷.
// ============================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { resolveProjectId } from './checkHandler.js';
import type { CodeEntity } from '../registry/schema.js';

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
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').trim();
}

function entityAttrs(e: CodeEntity): string {
  const attrs: string[] = [];
  attrs.push(`status:${e.status}`);
  attrs.push(`risk:${e.riskLevel}`);
  attrs.push(`tested:${e.hasTests ? 'yes' : 'no'}`);
  if (e.lineStart) {
    attrs.push(`lines:${e.lineStart}${e.lineEnd ? `-${e.lineEnd}` : ''}`);
  }
  if (e.complexityScore !== undefined && e.complexityScore > 0) {
    attrs.push(`complexity:${e.complexityScore}`);
  }
  return attrs.join(', ');
}

function renderEntity(e: CodeEntity, indent: string): string[] {
  const lines: string[] = [];
  const sig = e.signature ? ` ${escapeString(e.signature)}` : '';
  const head = `${indent}${e.kind} ${e.name}${sig} [${entityAttrs(e)}]`;

  const inner: string[] = [];
  if (e.deprecatedReason) {
    inner.push(`${indent}  deprecated_reason: "${escapeString(e.deprecatedReason)}"`);
  }
  if (e.notes) {
    inner.push(`${indent}  note: "${escapeString(e.notes)}"`);
  }
  const unresolvedWarnings = (e.warnings ?? []).filter((w) => !w.resolved);
  for (const w of unresolvedWarnings) {
    inner.push(`${indent}  warning [${w.severity}/${w.category}]: "${escapeString(w.message)}"`);
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

function renderDir(node: DirNode, indent: string): string[] {
  const lines: string[] = [];
  const agg = aggregate(node);
  const flags: string[] = [
    `entities:${agg.total}`,
    `untested:${agg.untested}`,
  ];
  if (agg.highRisk > 0) flags.push(`high_risk:${agg.highRisk}`);
  if (agg.deprecated > 0) flags.push(`deprecated:${agg.deprecated}`);

  const dirLabel = node.path === '' ? '.' : `${node.name}/`;
  lines.push(`${indent}directory "${dirLabel}" [${flags.join(', ')}] {`);

  const childIndent = indent + '  ';

  const sortedChildren = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const child of sortedChildren) {
    lines.push(...renderDir(child, childIndent));
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

    lines.push(`${childIndent}file "${file.fileName}" [${fileFlags.join(', ')}] {`);
    for (const e of ents) {
      lines.push(...renderEntity(e, childIndent + '  '));
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
    const projectName = projectPath.split('/').pop() ?? 'unknown';

    const { entities } = store.listEntities({ projectId, limit: 100000, offset: 0 });

    const filtered = opts.dir
      ? entities.filter((e) => e.filePath.startsWith(opts.dir!))
      : entities;

    if (filtered.length === 0) {
      console.error(`# cxt export — no entities found${opts.dir ? ` under "${opts.dir}"` : ''}`);
      console.error(`# Run \`cxt scan\` first.`);
      process.exitCode = 1;
      return;
    }

    const root = makeDir('', '');
    for (const e of filtered) insertEntity(root, e);

    const stats = store.getStats(projectId);
    const generatedAt = new Date().toISOString();

    const header: string[] = [
      `# cxt snapshot`,
      `# project: ${projectName} (${projectId})`,
      `# generated: ${generatedAt}`,
      `# entities: ${filtered.length}/${stats.total}` +
        (opts.dir ? ` (filtered by dir: ${opts.dir})` : ''),
      `# stats: deprecated=${stats.deprecated}, untested=${stats.untested}, high_risk=${stats.highRisk}, with_warnings=${stats.withWarnings}`,
      `#`,
      `# Format: GraphQL-inspired tree. Each entity carries [status, risk, tested, lines].`,
      `# Read this file instead of running glob/grep — it is the authoritative structure map.`,
      ``,
    ];

    const body = renderDir(root, '');
    const out = header.concat(body).join('\n') + '\n';

    if (opts.output) {
      const outPath = resolve(opts.output);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, out, 'utf-8');
      console.error(`# wrote ${filtered.length} entities → ${outPath}`);
    } else {
      process.stdout.write(out);
    }
  } finally {
    closeRegistryStore();
  }
}
