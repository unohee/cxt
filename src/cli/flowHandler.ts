import { getRegistryStore, closeRegistryStore } from '../registry/sqliteStore.js';
import { resolveProjectId } from './checkHandler.js';
import { lookupEntity } from './relationHandler.js';
import { escapeTerminal } from './outputSafety.js';

export async function handleFlow(name: string, opts: { project?: string; json?: boolean; strict?: boolean }): Promise<void> {
  const projectId = opts.project?.trim() || resolveProjectId(process.cwd());
  const store = getRegistryStore();
  try {
    const entity = lookupEntity(name, projectId, !!opts.json);
    if (!entity) { process.exitCode = 1; return; }
    const flow = store.getDataflow(projectId, entity.id)[0];
    const graph = store.getControlFlow(projectId, entity.id)[0];
    const summary = store.getSummaries(projectId, entity.id)[0];
    if (!flow || !graph) {
      if (opts.json) console.log(JSON.stringify({ error: 'dataflow_unavailable', owner: entity.qualifiedName }));
      else console.error(`Dataflow unavailable for ${escapeTerminal(entity.qualifiedName)}. Run an AST scan of a function body.`);
      process.exitCode = 1; return;
    }
    const locations = Object.fromEntries(graph.nodes.map(node => [node.id, node.span]));
    const analysisCompleteness = !summary || flow.completeness === 'partial' || summary.completeness === 'partial' ? 'partial' : 'complete';
    if (opts.json) console.log(JSON.stringify({ ...flow, filePath: graph.filePath, locations, summary: summary ?? null, analysisCompleteness, modelManifest: store.getModelManifest(projectId) }, null, 2));
    else {
      console.log(`${escapeTerminal(flow.owner)} — ${flow.completeness}; ${flow.iterations} transfers; ${flow.definitions.length} definitions / ${flow.uses.length} uses`);
      console.log('  Intraprocedural abstract facts; completeness does not establish program safety.');
      console.log(`  Unknown external/accessor effects: ${flow.unknownEffects.length}`);
      if (summary) console.log(`  Summary: ${summary.completeness}; ${summary.iterations} SCC rounds; ${escapeTerminal(summary.reasons.join(', '))}`);
      else console.log('  Summary: unavailable; rescan source.');
      for (const model of summary?.models ?? []) console.log(`  Model: ${escapeTerminal(model.pack)}@${escapeTerminal(model.packVersion)} / ${escapeTerminal(model.model)}; ${escapeTerminal(model.package)} ${escapeTerminal(model.targetVersion)}; assumption=${model.assumption}`);
      for (const call of flow.calls) if (call.model) console.log(`  External call @${locations[call.node].line}: ${call.model.status}`);
      for (const use of flow.uses) {
        const span = locations[use.node];
        console.log(`  ${span.line}:${span.column} ${escapeTerminal(use.variable)} <- ${escapeTerminal(use.definitions.join(', '))}${use.mayBeUninitialized ? ' [may be uninitialized]' : ''}`);
      }
      for (const returned of flow.returns) console.log(`  return @${locations[returned.node].line}: ${escapeTerminal(returned.value.atoms.join(' | '))}`);
      for (const diagnostic of flow.diagnostics) console.log(`  [${diagnostic.code}] ${escapeTerminal(diagnostic.message)}`);
    }
    if (opts.strict && analysisCompleteness === 'partial') process.exitCode = 2;
  } finally { closeRegistryStore(); }
}
