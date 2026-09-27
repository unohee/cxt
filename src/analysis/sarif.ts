import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BsIssue, BsScanResult } from '../registry/bsDetector.js';
import type { SourceSpan } from './cfg.js';
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
