import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BsIssue, BsScanResult } from '../registry/bsDetector.js';
import type { SourceSpan } from './cfg.js';
import type { ControlFlowGraph } from './cfg.js';
import type { DataflowResult } from './dataflow.js';
import { builtInRules } from './rulePack.js';
import { bsOutcome, findingRuleId, fingerprintFindings, type AnalysisOutcome } from './report.js';

export const SARIF_SCHEMA = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;
const level = (severity: BsIssue['severity']) => severity === 'critical' ? 'error' : severity === 'warning' ? 'warning' : 'note';

/** 소스 위치는 repository 상대 URI로 출력한다. */
export function artifactUri(filePath: string, projectPath: string): string {
  const path = (isAbsolute(filePath) ? relative(projectPath, filePath) : filePath).split(sep).join('/');
  if (!path || path.startsWith('/') || path.split('/').some(part => ['..', '.', ''].includes(part))) throw new Error('SARIF artifact must be inside the project');
  return path.split('/').map(part => encodeURIComponent(part).replaceAll(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}
function location(file: string, project: string, span: Pick<SourceSpan, 'line'> & Partial<SourceSpan>) {
  const region = { startLine: span.line, ...(span.column ? { startColumn: span.column } : {}),
    ...(span.endLine ? { endLine: span.endLine } : {}), ...(span.endColumn ? { endColumn: span.endColumn } : {}) };
  return { physicalLocation: { artifactLocation: { uri: artifactUri(file, project), uriBaseId: '%SRCROOT%' }, region } };
}
export function toSarif(result: BsScanResult, projectPath: string, options: { outcome?: AnalysisOutcome; properties?: Record<string, unknown> } = {}) {
  const outcome = options.outcome ?? bsOutcome(result, true);
  const findings = fingerprintFindings(result.issues);
  const ids = [...new Set(findings.map(findingRuleId))].sort();
  const rules = ids.map(id => {
    const definition = builtInRules.find(rule => rule.id === id), issue = findings.find(issue => findingRuleId(issue) === id)!;
    return { id, shortDescription: { text: issue.message }, fullDescription: { text: definition?.rationale ?? issue.rationale ?? issue.message },
      defaultConfiguration: { level: level(issue.severity) },
      properties: { version: definition?.version ?? 'legacy', category: issue.category,
        precision: issue.precision ?? 'low', precisionBasis: issue.precisionBasis ?? 'policy-estimate', tags: [issue.category] } };
  });
  const results = findings.map(issue => {
    const relatedLocations = (issue.flow?.steps ?? []).map((step, id) => ({ id, ...location(issue.filePath, projectPath, step),
      message: { text: id === (issue.flow?.steps.length ?? 0) - 1 ? 'Read' : 'Reaching definition' } }));
    return { ruleId: findingRuleId(issue), ruleIndex: ids.indexOf(findingRuleId(issue)), level: level(issue.severity), message: { text: issue.message },
      locations: [location(issue.filePath, projectPath, issue)],
      partialFingerprints: { primaryLocationLineHash: issue.fingerprint },
      properties: { category: issue.category, ruleVersion: issue.ruleVersion ?? 'legacy', precision: issue.precision ?? 'low',
        precisionBasis: issue.precisionBasis ?? 'policy-estimate', rationale: issue.rationale ?? issue.ruleRationale ?? '',
        ...(issue.flow ? { owner: issue.flow.owner, definitions: issue.flow.definitions, evidenceKind: 'definition-read-endpoints' } : {}) },
      ...(relatedLocations.length ? { relatedLocations, codeFlows: [{ message: { text: 'Definition/read evidence; intermediate execution steps are not reconstructed.' },
        threadFlows: [{ locations: relatedLocations.map((entry, executionOrder) => ({ location: entry, executionOrder })) }] }] } : {}) };
  });
  const notifications = [
    ...result.errors.map(message => ({ level: 'error', message: { text: message }, descriptor: { id: 'scan-error' } })),
    ...(result.analysis?.diagnostics ?? []).map(diagnostic => ({ level: 'warning', message: { text: diagnostic.message }, descriptor: { id: diagnostic.code },
      ...(diagnostic.filePath ? { locations: [{ physicalLocation: { artifactLocation: { uri: artifactUri(diagnostic.filePath, projectPath), uriBaseId: '%SRCROOT%' } } }] } : {}) })),
  ];
  if (outcome.status === 'partial' && !notifications.length) notifications.push({ level: 'warning', message: { text: 'Analysis is partial; absence of findings does not establish full coverage.' }, descriptor: { id: 'partial-analysis' } });
  return { $schema: SARIF_SCHEMA, version: '2.1.0', runs: [{ tool: { driver: { name: 'cxt', version, rules } },
    columnKind: 'utf16CodeUnits', originalUriBaseIds: { '%SRCROOT%': { uri: pathToFileURL(resolve(projectPath) + sep).href } },
    invocations: [{ executionSuccessful: outcome.status !== 'failed', exitCode: outcome.exitCode, toolExecutionNotifications: notifications,
      properties: { analysisStatus: outcome.status, findingsFail: outcome.findingsFail } }], results,
    properties: { outcome, filesScanned: result.filesScanned, analysis: result.analysis, ...options.properties } }] };
}

/** Serialize stored semantic flow findings with static source/provenance locations. */
export function toDataflowSarif(flow: DataflowResult, graph: ControlFlowGraph, projectPath: string,
  options: { outcome?: AnalysisOutcome; summary?: unknown } = {}) {
  const definite = [...flow.resourceFindings, ...flow.ownershipFindings].filter(finding => finding.certainty === 'definite').length;
  const taintCount = flow.taintFindings?.length ?? 0;
  const complete = flow.completeness === 'complete';
  const outcome = options.outcome ?? { status: flow.completeness === 'complete' ? 'complete' : 'partial',
    pass: complete && definite === 0 && taintCount === 0,
    findingsFail: complete && (definite > 0 || taintCount > 0),
    exitCode: complete ? definite > 0 || taintCount > 0 ? 1 : 0 : 2 } as AnalysisOutcome;
  const rules = [
    { id: 'cxt/resource-use-after-release', text: 'Use after resource release', level: 'error' },
    { id: 'cxt/resource-leak', text: 'Resource may leak', level: 'warning' },
    { id: 'cxt/ownership-use-after-move', text: 'Use after move', level: 'warning' },
    { id: 'cxt/taint-sink', text: 'Tainted data reaches a modeled sink', level: 'error' },
  ].map(rule => ({ id: rule.id, shortDescription: { text: rule.text }, fullDescription: { text: `${rule.text}; provenance is static CFG evidence.` },
    defaultConfiguration: { level: rule.level }, properties: { version: '1.0.0', precision: 'policy-estimate' } }));
  const nodeSpan = (node: number): SourceSpan => graph.nodes[node]?.span ?? graph.nodes[graph.entry].span;
  const primary = (node: number) => location(graph.filePath, projectPath, nodeSpan(node));
  const definitionChain = (ids: string[]) => {
    const byId = new Map(flow.definitions.map(definition => [definition.id, definition]));
    const seen = new Set<string>(), ordered: typeof flow.definitions = [];
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const definition = byId.get(id);
      if (!definition) return;
      for (const dependency of definition.dependencies) visit(dependency);
      ordered.push(definition);
    };
    ids.forEach(visit);
    return ordered;
  };
  const fingerprint = (ruleId: string, node: number, key: string) => createHash('sha256').update(JSON.stringify([
    ruleId, graph.filePath.replaceAll('\\', '/'), graph.nodes[node]?.text.replaceAll(/\s+/g, ' ').trim() ?? '', key,
  ])).digest('hex');
  const results = [
    ...flow.resourceFindings.map(finding => {
      const ruleId = `cxt/resource-${finding.kind}`;
      const sourceNodes = finding.sourceNodes ?? [];
      const certainty = complete ? finding.certainty : 'possible';
      const relatedLocations = sourceNodes.map((node, id) => ({ id, ...primary(node), message: { text: 'Resource acquire/release source' } }));
      const allLocations = [...relatedLocations, { id: relatedLocations.length, ...primary(finding.node), message: { text: 'Finding' } }];
      return { ruleId, ruleIndex: rules.findIndex(rule => rule.id === ruleId), level: certainty === 'definite' ? 'error' : 'warning',
        message: { text: `${finding.kind}: ${finding.ids.join(', ')}` }, locations: [primary(finding.node)],
        partialFingerprints: { primaryLocationLineHash: fingerprint(ruleId, finding.node, finding.ids.join(',')) },
        relatedLocations, codeFlows: [{ message: { text: 'Static resource lifecycle provenance; runtime path is not reconstructed.' },
          threadFlows: [{ locations: allLocations.map((entry, executionOrder) => ({ location: entry, executionOrder })) }] }],
        properties: { certainty, resourceIds: finding.ids, sourceNodes, analysisStatus: flow.completeness } };
    }),
    ...flow.ownershipFindings.map(finding => {
      const definitions = finding.definitions.map(id => flow.definitions.find(definition => definition.id === id)).filter(Boolean);
      const certainty = complete ? finding.certainty : 'possible';
      const relatedLocations = definitions.map((definition, id) => ({ id, ...primary(definition!.node), message: { text: 'Moved-state definition' } }));
      const allLocations = [...relatedLocations, { id: relatedLocations.length, ...primary(finding.node), message: { text: 'Finding' } }];
      return { ruleId: 'cxt/ownership-use-after-move', ruleIndex: rules.findIndex(rule => rule.id === 'cxt/ownership-use-after-move'),
        level: certainty === 'definite' ? 'error' : 'warning', message: { text: `use-after-move: ${finding.variable}` },
        locations: [primary(finding.node)], partialFingerprints: { primaryLocationLineHash: fingerprint('cxt/ownership-use-after-move', finding.node, finding.variable) },
        relatedLocations, codeFlows: [{ message: { text: 'Static ownership provenance; runtime path is not reconstructed.' },
          threadFlows: [{ locations: allLocations.map((entry, executionOrder) => ({ location: entry, executionOrder })) }] }],
        properties: { certainty, variable: finding.variable, definitions: finding.definitions, analysisStatus: flow.completeness } };
    }),
    ...(flow.taintFindings ?? []).map(finding => {
      const ruleId = 'cxt/taint-sink';
      const key = `${finding.target ?? 'unknown'}:${finding.parameter}:${finding.atoms.join(',')}`;
      const definitions = definitionChain(finding.sourceDefinitions ?? []);
      const relatedLocations = definitions.map((definition, id) => ({ id, ...primary(definition.node), message: { text: id === 0 ? 'Taint source definition' : 'Taint propagation definition' } }));
      const allLocations = [...relatedLocations, { id: relatedLocations.length, ...primary(finding.node), message: { text: 'Taint sink' } }];
      return { ruleId, ruleIndex: rules.findIndex(rule => rule.id === ruleId), level: complete ? 'error' : 'warning',
        message: { text: `${complete ? 'tainted data reaches' : 'possible tainted data reaches'} sink parameter ${finding.parameter}: ${finding.target ?? 'unknown'}` },
        locations: [primary(finding.node)],
        partialFingerprints: { primaryLocationLineHash: fingerprint(ruleId, finding.node, key) },
        ...(relatedLocations.length ? { relatedLocations, codeFlows: [{ message: { text: 'Static taint source-to-sink provenance; runtime path is not reconstructed.' },
          threadFlows: [{ locations: allLocations.map((entry, executionOrder) => ({ location: entry, executionOrder })) }] }] } : {}),
        properties: { parameter: finding.parameter, atoms: finding.atoms, target: finding.target ?? null, sourceDefinitions: finding.sourceDefinitions ?? [],
          pathDefinitions: definitions.map(definition => definition.id), evidenceKind: 'explicit-model-taint', certainty: complete ? 'proven' : 'possible', analysisStatus: flow.completeness } };
    }),
  ];
  const notifications: Array<{ level: 'warning'; message: { text: string }; descriptor: { id: string } }> = flow.diagnostics.map(diagnostic => ({ level: 'warning', message: { text: diagnostic.message }, descriptor: { id: diagnostic.code } }));
  if (outcome.status === 'partial' && !notifications.length) notifications.push({ level: 'warning', message: { text: 'Analysis is partial; absence of findings does not establish full coverage.' }, descriptor: { id: 'partial-analysis' } });
  return { $schema: SARIF_SCHEMA, version: '2.1.0', runs: [{ tool: { driver: { name: 'cxt', version, rules } },
    columnKind: 'utf16CodeUnits', originalUriBaseIds: { '%SRCROOT%': { uri: pathToFileURL(resolve(projectPath) + sep).href } },
    invocations: [{ executionSuccessful: outcome.status !== 'failed', exitCode: outcome.exitCode, toolExecutionNotifications: notifications,
      properties: { analysisStatus: outcome.status, findingsFail: outcome.findingsFail } }], results,
    properties: { outcome, owner: flow.owner, summary: options.summary ?? null } }] };
}
