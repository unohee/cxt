import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { resolveProjectId } from './checkHandler.js';
import { lookupEntity } from './relationHandler.js';
import { escapeTerminal } from './outputSafety.js';
import { reachableNodes } from '../analysis/cfg.js';

export async function handleCfg(name: string, opts: { project?: string; json?: boolean; strict?: boolean }): Promise<void> {
  const projectId = opts.project?.trim() || resolveProjectId(process.cwd());
  const store = getRegistryStore();
  try {
    const entity = lookupEntity(name, projectId, !!opts.json);
    if (!entity) { process.exitCode = 1; return; }
    const graph = store.getControlFlow(projectId, entity.id)[0];
    if (!graph) {
      if (opts.json) console.log(JSON.stringify({ error: 'cfg_unavailable', owner: entity.qualifiedName }));
      else console.error(`CFG unavailable for ${escapeTerminal(entity.qualifiedName)}. Run an AST scan of a function body.`);
      process.exitCode = 1; return;
    }
    const reachable = reachableNodes(graph);
    if (opts.json) console.log(JSON.stringify({ ...graph, reachableNodes: [...reachable] }, null, 2));
    else {
      console.log(`${escapeTerminal(graph.owner)} — ${graph.completeness}; complexity ${graph.structuralComplexity}; ${graph.nodes.length} nodes / ${graph.edges.length} edges`);
      for (const node of graph.nodes) console.log(`  ${node.id} [${node.kind}${reachable.has(node.id) ? '' : ', unreachable'}] ${node.span.line}:${node.span.column} ${escapeTerminal(node.text).replaceAll('\n', ' ')}`);
      for (const edge of graph.edges) console.log(`  ${edge.from} -> ${edge.to} [${edge.kind}]`);
      for (const d of graph.diagnostics) console.log(`  [${d.code}] ${d.span.line}:${d.span.column} ${escapeTerminal(d.message)}`);
    }
    if (opts.strict && graph.completeness === 'partial') process.exitCode = 2;
  } finally { closeRegistryStore(); }
}
