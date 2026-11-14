import { createHash } from 'node:crypto';
import type { BsIssue, BsScanResult } from '../registry/bsDetector.js';
import type { ScanResult } from '../registry/entityScanner.js';

export interface AnalysisOutcome {
  status: 'complete' | 'partial' | 'failed';
  findingsFail: boolean;
  pass: boolean;
  exitCode: 0 | 1 | 2 | 3;
}
export function analysisOutcome(errors: string[], partial: boolean, findingsFail: boolean): AnalysisOutcome {
  const status = errors.length ? 'failed' : partial ? 'partial' : 'complete';
  const exitCode = status === 'failed' ? 3 : status === 'partial' ? 2 : findingsFail ? 1 : 0;
  return { status, findingsFail, pass: exitCode === 0, exitCode };
}
export function bsOutcome(result: Pick<BsScanResult, 'critical' | 'errors' | 'analysis'> & { warning?: number }, warningsFail = false): AnalysisOutcome {
  return analysisOutcome(result.errors, result.analysis?.completeness !== 'complete', result.critical > 0 || warningsFail && (result.warning ?? 0) > 0);
}
export function scanOutcome(result: ScanResult): AnalysisOutcome {
  const partial = !!(result.diagnostics.length || result.parserBreakdown.lexical || result.controlFlow.partial || result.dataflow.partial
    || result.summaries.partial || result.callSites.unresolved || result.callSites.external);
  return analysisOutcome(result.errors, partial, result.taintFindings.proven > 0);
}
export const findingRuleId = (issue: BsIssue): string => issue.ruleId ?? `cxt/legacy-${issue.category.replaceAll('_', '-')}`;

/** 위치 이동에는 안정적이며, 같은 rule/file/text의 반복은 소스 순서로 구분한다. */
export function fingerprintFindings(issues: BsIssue[]): Array<BsIssue & { fingerprint: string }> {
  const occurrences = new Map<string, number>();
  return [...issues].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || (a.column ?? 0) - (b.column ?? 0)
    || findingRuleId(a).localeCompare(findingRuleId(b))).map(issue => {
    const key = JSON.stringify([findingRuleId(issue), issue.filePath.replaceAll('\\', '/'), issue.matchedText.replaceAll(/\s+/g, ' ').trim()]);
    const ordinal = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, ordinal);
    const fingerprint = createHash('sha256').update(key).digest('hex') + `:${ordinal}`;
    return { ...issue, fingerprint };
  });
}

export function failedBsScan(error: unknown): BsScanResult {
  return { issues: [], filesScanned: 0, critical: 0, warning: 0, minor: 0, bsScore: 0,
    errors: [error instanceof Error ? error.message : String(error)],
    analysis: { completeness: 'partial', engines: {}, diagnostics: [] } };
}

export function assertOutputOptions(options: { json?: boolean; sarif?: boolean }): void {
  if (options.json && options.sarif) throw new Error('--json and --sarif are mutually exclusive');
}
