import type { SqliteRegistryStore } from '../registry/sqliteStore.js';
import { parameterImpact, type ParameterImpact } from '../analysis/parameterImpact.js';
import { escapeTerminal } from './outputSafety.js';

export function loadParameterImpact(store: SqliteRegistryStore, project: string, owner: string, parameter: string, depth: number): ParameterImpact {
  return parameterImpact(store.getControlFlow(project), store.getDataflow(project), store.getSummaries(project), owner, parameter, depth);
}
export function presentParameterImpact(result: ParameterImpact, explain: boolean) {
  return { ...result, impacted: result.impacted.map(({ path, ...item }) => ({ ...item, ...(explain ? { path } : {}) })) };
}
export function printParameterPaths(result: ParameterImpact): void {
  for (const model of result.models ?? []) console.log(`  [model] ${escapeTerminal(model.pack)}@${escapeTerminal(model.packVersion)}; ${escapeTerminal(model.package)} ${escapeTerminal(model.targetVersion)}; assumption=${model.assumption}`);
  for (const item of result.impacted) for (const step of item.path) {
    console.log(`  ${escapeTerminal(step.callee)} -> ${escapeTerminal(step.caller)} [${step.evidence}] ${escapeTerminal(step.filePath)}:${step.span.line}:${step.span.column}`);
  }
  for (const boundary of result.boundaries) console.log(`  [partial] ${escapeTerminal(boundary.owner)}: ${escapeTerminal(boundary.reason)}`);
}
