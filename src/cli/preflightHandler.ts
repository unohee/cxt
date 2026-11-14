import { closeRegistryStore, getRegistryStore } from '../registry/sqliteStore.js';
import { resolveProjectId } from './checkHandler.js';
import { escapeTerminal } from './outputSafety.js';
import type { CodeEntity } from '../registry/schema.js';
import { loadParameterImpact, presentParameterImpact, printParameterPaths } from './parameterImpactHandler.js';
import type { ParameterImpact } from '../analysis/parameterImpact.js';

export interface PreflightOptions { project?: string; depth?: string; json?: boolean; strict?: boolean; param?: string; explain?: boolean; }
const MAX_DEPTH = 100;

function parseDepth(value: string | undefined): number | null {
  if (value === undefined) return 5;
  if (!/^\d+$/.test(value)) return null;
  const depth = Number(value);
  return Number.isSafeInteger(depth) && depth >= 1 && depth <= MAX_DEPTH ? depth : null;
}

function findTarget(name: string, projectId: string): { target?: CodeEntity; error?: object } {
  const store = getRegistryStore();
  if (name.includes('::')) {
    const target = store.findEntityByQualifiedName(name, projectId);
    return target ? { target } : { error: { error: 'not_found', name } };
  }
  const matches = store.findEntitiesByName(name, projectId);
  if (matches.length === 1) return { target: matches[0] };
  return matches.length === 0 ? { error: { error: 'not_found', name } } : { error: { error: 'ambiguous', name, candidates: matches.map(entity => entity.qualifiedName) } };
}

/** 영향 그래프 후보를 변경 검토와 테스트 계획으로 묶는다. */
export async function handlePreflight(name: string, opts: PreflightOptions): Promise<void> {
  const projectId = opts.project?.trim() || resolveProjectId(process.cwd());
  const store = getRegistryStore();
  try {
    if (opts.explain && opts.param === undefined) {
      if (opts.json) console.log(JSON.stringify({ error: 'explain_requires_param' })); else console.error('--explain requires --param');
      process.exitCode = 1; return;
    }
    const depth = parseDepth(opts.depth);
    if (depth === null) {
      const error = { error: 'invalid_depth', value: opts.depth, min: 1, max: MAX_DEPTH };
      if (opts.json) console.log(JSON.stringify(error)); else console.error(`Invalid depth: ${escapeTerminal(opts.depth)}`);
      process.exitCode = 1; return;
    }
    const found = findTarget(name, projectId);
    if (!found.target) {
      if (opts.json) console.log(JSON.stringify(found.error)); else console.error(`Target not uniquely found: ${escapeTerminal(name)}`);
      process.exitCode = 1; return;
    }
    let valueFlow: ParameterImpact | undefined;
    if (opts.param !== undefined) {
      try { valueFlow = loadParameterImpact(store, projectId, found.target.qualifiedName, opts.param, depth); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (opts.json) console.log(JSON.stringify({ error: 'parameter_analysis_unavailable', message })); else console.error(escapeTerminal(message));
        process.exitCode = 1; return;
      }
    }
    const impacted = valueFlow ? valueFlow.impacted.map(item => {
      const entity = store.findEntityByQualifiedName(item.owner, projectId);
      if (!entity) throw new Error(`Summary owner is absent from registry: ${item.owner}`);
      return { id: entity.id, name: entity.name, filePath: entity.filePath, depth: item.depth };
    }) : store.getImpactSet(found.target.id, depth);
    const candidates = [{
      name: found.target.name,
      qualifiedName: found.target.qualifiedName,
      file: found.target.filePath,
      depth: 0,
      risk: found.target.riskLevel ?? 'unknown',
      hasTests: found.target.hasTests ?? false,
      unresolvedWarnings: found.target.warnings.filter(w => !w.resolved).length,
    }, ...impacted.map(item => {
      const entity = store.getEntity(item.id);
      return { name: item.name, qualifiedName: entity?.qualifiedName ?? `${item.filePath}::${item.name}`, file: item.filePath, depth: item.depth, risk: entity?.riskLevel ?? 'unknown', hasTests: entity?.hasTests ?? false, unresolvedWarnings: entity?.warnings.filter(w => !w.resolved).length ?? 0 };
    })];
    const highRisk = candidates.filter(item => item.risk === 'high');
    const untested = candidates.filter(item => !item.hasTests);
    const warnings = candidates.filter(item => item.unresolvedWarnings > 0);
    const result = {
      target: found.target.qualifiedName, maxDepth: depth, candidates,
      ...(valueFlow ? { valueFlow: presentParameterImpact(valueFlow, !!opts.explain) } : {}),
      files: [...new Set([found.target.filePath, ...candidates.map(item => item.file)])].sort(),
      review: {
        highRisk: highRisk.map(item => item.qualifiedName), untested: untested.map(item => item.qualifiedName), unresolvedWarnings: warnings.map(item => item.qualifiedName),
        required: ['Verify candidates with source/test inspection; the relation graph is a seed, not a complete call graph.', ...(untested.length ? ['Add or manually exercise coverage for impacted untested entities.'] : []), ...(highRisk.length ? ['Review high-risk candidates before changing the target.'] : []), ...(warnings.length ? ['Resolve or explicitly accept unresolved candidate warnings before changing the target.'] : [])],
      },
      pass: highRisk.length === 0 && untested.length === 0 && warnings.length === 0 && valueFlow?.completeness !== 'partial',
    };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`\nChange preflight: ${escapeTerminal(found.target.qualifiedName)}\n  Candidates: ${candidates.length}  High risk: ${highRisk.length}  Untested: ${untested.length}  Warnings: ${warnings.length}\n  - ${result.review.required.join('\n  - ')}`);
    if (!opts.json && valueFlow) {
      console.log(`  Parameter value impact: ${escapeTerminal(valueFlow.parameter)} — ${valueFlow.completeness}`);
      if (valueFlow.models?.length) console.log(`  Conditional on ${valueFlow.models.length} model contracts and unmodified external bindings; --explain lists versions.`);
      if (opts.explain) printParameterPaths(valueFlow);
    }
    if (opts.strict && !result.pass) process.exitCode = valueFlow?.completeness === 'partial' ? 2 : 1;
  } finally { closeRegistryStore(); }
}
