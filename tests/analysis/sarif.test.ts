import { readFileSync } from 'node:fs';
import Ajv from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { analyzeFileContent, aggregateResults } from '../../src/registry/bsDetector.js';
import { artifactUri, toSarif } from '../../src/analysis/sarif.js';
import { toDataflowSarif } from '../../src/analysis/sarif.js';
import { analysisOutcome, bsOutcome, fingerprintFindings } from '../../src/analysis/report.js';
import { extractFile } from '../../src/registry/entityScanner.js';
import type { DataflowResult } from '../../src/analysis/dataflow.js';

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
export const validateSarif = ajv.compile(JSON.parse(readFileSync(new URL('../schemas/sarif-schema-2.1.0.json', import.meta.url), 'utf8')));
function report(source: string, file = 'src/read.py', language = 'python') {
  const analysis = analyzeFileContent(source, file, language);
  return { ...aggregateResults(analysis.issues, 1), analysis: { completeness: analysis.completeness, engines: { [analysis.engine]: 1 }, diagnostics: analysis.diagnostics } };
}
function validate(value: unknown) { expect(validateSarif(value), JSON.stringify(validateSarif.errors)).toBe(true); }

describe('SARIF 2.1.0 contract', () => {
  it('validates locations, definition/read evidence, metadata and multiple escaped file URIs', () => {
    const input = report('def read():\n print(x)\n x=1', 'src/a #한글%.py');
    input.issues.push(...analyzeFileContent('debugger;', 'src/second.ts', 'typescript').issues);
    const sarif = toSarif(input, '/workspace/project');
    validate(sarif);
    const run = sarif.runs[0];
    expect(run.results).toHaveLength(2);
    expect(run.results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('src/a%20%23%ED%95%9C%EA%B8%80%25.py');
    expect(run.originalUriBaseIds['%SRCROOT%'].uri).toBe('file:///workspace/project/');
    expect(run.results[0].codeFlows?.[0].threadFlows[0].locations).toHaveLength(2);
    expect(run.results[0].relatedLocations?.[0].physicalLocation.region.startLine).toBe(1);
    expect(run.results[0].properties.evidenceKind).toBe('definition-read-endpoints');
    expect(run.invocations[0]).toMatchObject({ executionSuccessful: true, exitCode: 1 });
    expect(run.tool.driver.rules[0].properties.precisionBasis).toBe('policy-estimate');
  });

  it('distinguishes incomplete analysis from failed execution and retains findings in both', () => {
    const input = report('function f(){with (resource) {work();}} debugger;', 'x.ts', 'typescript');
    const partial = toSarif(input, '/workspace');
    validate(partial);
    expect(partial.runs[0].invocations[0]).toMatchObject({ executionSuccessful: true, exitCode: 2 });
    expect(partial.runs[0].properties.outcome).toMatchObject({ status: 'partial', findingsFail: true, pass: false });
    input.errors.push('scan timed out');
    const failed = toSarif(input, '/workspace');
    validate(failed);
    expect(failed.runs[0].invocations[0]).toMatchObject({ executionSuccessful: false, exitCode: 3 });
    expect(failed.runs[0].results).toEqual(partial.runs[0].results);
    expect(failed.runs[0].invocations[0].toolExecutionNotifications.some(note => note.level === 'error')).toBe(true);
  });

  it('keeps fingerprints stable across line shifts, locales and result ordering, disambiguating duplicates', () => {
    const original = report('debugger;\ndebugger;', 'x.ts', 'typescript');
    const moved = report('\n\ndebugger;\ndebugger;', 'x.ts', 'typescript');
    const hashes = fingerprintFindings(original.issues).map(issue => issue.fingerprint);
    expect(new Set(hashes).size).toBe(2);
    expect(fingerprintFindings(moved.issues.reverse().map(issue => ({ ...issue, message: 'translated' }))).map(issue => issue.fingerprint)).toEqual(hashes);
    expect(toSarif(moved, '/new/check-out').runs[0].results.map(issue => issue.partialFingerprints.primaryLocationLineHash)).toEqual(hashes);
    expect(fingerprintFindings(original.issues.map(issue => ({ ...issue, ruleId: 'cxt/other' })))[0].fingerprint).not.toBe(hashes[0]);
  });

  it('does not include credential literals and rejects artifact paths outside the root', () => {
    const sarif = toSarif(report('const token="secret-123456789";', 'x.ts', 'typescript'), '/workspace');
    validate(sarif);
    expect(JSON.stringify(sarif)).not.toContain('secret-123456789');
    expect(JSON.stringify(analyzeFileContent('const token="secret-123456789";', 'x.ts', 'typescript', { parser: 'lexical' }).issues)).not.toContain('secret-123456789');
    expect(() => artifactUri('../outside.py', '/workspace')).toThrow('inside the project');
    expect(() => artifactUri('/outside.py', '/workspace')).toThrow('inside the project');
    expect(artifactUri('/workspace/inside.py', '/workspace')).toBe('inside.py');
  });

  it('uses UTF-16 columns for Unicode source text', () => {
    const source = 'const x="🎵"; debugger;';
    const sarif = toSarif(report(source, 'x.ts', 'typescript'), '/workspace');
    validate(sarif);
    expect(sarif.runs[0].columnKind).toBe('utf16CodeUnits');
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.region.startColumn).toBe(source.indexOf('debugger') + 1);
  });

  it('validates semantic flow provenance code flows', () => {
    const graph = extractFile('function f(){const h=acquire();return h.read();}', 'src/x.ts', 'typescript').controlFlow![0];
    const flow = { owner: graph.owner, completeness: 'complete', diagnostics: [], definitions: [], uses: [], returns: [], throws: [], calls: [],
      resourceEvents: [], resourceFindings: [{ kind: 'use-after-release', node: graph.exit, ids: ['resource-1'], certainty: 'definite', sourceNodes: [graph.entry] }],
      ownershipFindings: [], reachableNodes: [], unknownEffects: [], iterations: 1, workUnits: 1 } as DataflowResult;
    const sarif = toDataflowSarif(flow, graph, '/workspace');
    validate(sarif);
    expect(sarif.runs[0].results[0].ruleId).toBe('cxt/resource-use-after-release');
    expect(sarif.runs[0].results[0].partialFingerprints.primaryLocationLineHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sarif.runs[0].results[0].codeFlows?.[0].threadFlows[0].locations).toHaveLength(2);
  });

  it('downgrades resource and ownership certainty for partial flows', () => {
    const graph = extractFile('function f(){return value;}', 'src/partial-state.ts', 'typescript').controlFlow![0];
    const flow = { owner: graph.owner, completeness: 'partial', diagnostics: [], definitions: [], uses: [], returns: [], throws: [], calls: [],
      resourceEvents: [], resourceFindings: [{ kind: 'use-after-release', node: graph.exit, ids: ['resource-1'], certainty: 'definite', sourceNodes: [graph.entry] }],
      ownershipFindings: [{ kind: 'use-after-move', node: graph.exit, variable: 'value', certainty: 'definite', definitions: [] }], taintFindings: [],
      reachableNodes: [], unknownEffects: [], iterations: 1, workUnits: 1 } as DataflowResult;
    const sarif = toDataflowSarif(flow, graph, '/workspace');
    validate(sarif);
    expect(sarif.runs[0].results).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'cxt/resource-use-after-release', level: 'warning', properties: expect.objectContaining({ certainty: 'possible' }) }),
      expect.objectContaining({ ruleId: 'cxt/ownership-use-after-move', level: 'warning', properties: expect.objectContaining({ certainty: 'possible' }) }),
    ]));
    expect(sarif.runs[0].invocations[0]).toMatchObject({ exitCode: 2, executionSuccessful: true, properties: { findingsFail: false } });
  });

  it('exports explicit modeled taint sinks and fails strict flow output', () => {
    const graph = extractFile('function f(){sink(input);}', 'src/taint.ts', 'typescript').controlFlow![0];
    const flow = { owner: graph.owner, completeness: 'complete', diagnostics: [], definitions: [], uses: [], returns: [], throws: [], calls: [],
      resourceEvents: [], resourceFindings: [], ownershipFindings: [], taintFindings: [{ node: graph.exit, target: 'src/taint.ts::sink', parameter: 0, atoms: ['tainted'], sourceDefinitions: [] }],
      reachableNodes: [], unknownEffects: [], iterations: 1, workUnits: 1 } as DataflowResult;
    const sarif = toDataflowSarif(flow, graph, '/workspace');
    validate(sarif);
    expect(sarif.runs[0].results[0]).toMatchObject({ ruleId: 'cxt/taint-sink', level: 'error' });
    expect(sarif.runs[0].results[0].properties).toMatchObject({ parameter: 0, atoms: ['tainted'], evidenceKind: 'explicit-model-taint' });
    expect(sarif.runs[0].invocations[0]).toMatchObject({ exitCode: 1, executionSuccessful: true });
  });

  it('marks taint from partial flow as possible warning evidence', () => {
    const graph = extractFile('function f(){sink(input);with (resource) {work();}}', 'src/partial-taint.ts', 'typescript').controlFlow![0];
    const flow = { owner: graph.owner, completeness: 'partial', diagnostics: [], definitions: [], uses: [], returns: [], throws: [], calls: [],
      resourceEvents: [], resourceFindings: [], ownershipFindings: [], taintFindings: [{ node: graph.exit, target: 'src/partial-taint.ts::sink', parameter: 0, atoms: ['tainted'], sourceDefinitions: [] }],
      reachableNodes: [], unknownEffects: [], iterations: 1, workUnits: 1 } as DataflowResult;
    const sarif = toDataflowSarif(flow, graph, '/workspace');
    validate(sarif);
    expect(sarif.runs[0].results[0]).toMatchObject({ ruleId: 'cxt/taint-sink', level: 'warning', properties: { certainty: 'possible', analysisStatus: 'partial' } });
    expect(sarif.runs[0].invocations[0]).toMatchObject({ exitCode: 2, executionSuccessful: true, properties: { findingsFail: false } });
  });

  it('includes intermediate static taint definition dependencies in the code flow', () => {
    const graph = extractFile('function f(){const a=input;const b=a;sink(b);}', 'src/taint-chain.ts', 'typescript').controlFlow![0];
    const flow = { owner: graph.owner, completeness: 'complete', diagnostics: [],
      definitions: [
        { id: 'source', location: 'var:a', node: 3, dependencies: [] },
        { id: 'alias', location: 'var:b', node: 5, dependencies: ['source'] },
      ], uses: [], returns: [], throws: [], calls: [], resourceEvents: [], resourceFindings: [], ownershipFindings: [],
      taintFindings: [{ node: 6, target: 'sink', parameter: 0, atoms: ['tainted'], sourceDefinitions: ['alias'] }],
      reachableNodes: [], unknownEffects: [], iterations: 1, workUnits: 1 } as DataflowResult;
    const sarif = toDataflowSarif(flow, graph, '/workspace');
    validate(sarif);
    const result = sarif.runs[0].results[0];
    expect(result.properties.pathDefinitions).toEqual(['source', 'alias']);
    expect(result.codeFlows?.[0].threadFlows[0].locations).toHaveLength(3);
    expect(result.codeFlows?.[0].threadFlows[0].locations[1].location.message.text).toBe('Taint propagation definition');
  });

  it('rejects invalid schema mutations and fails closed on missing completeness', () => {
    const sarif = toSarif(report('debugger;', 'x.ts', 'typescript'), '/workspace');
    expect(validateSarif({ ...sarif, version: '3.0.0' })).toBe(false);
    sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine = 0;
    expect(validateSarif(sarif)).toBe(false);
    expect(bsOutcome({ critical: 0, errors: [] }).exitCode).toBe(2);
    expect(analysisOutcome([], false, false).exitCode).toBe(0);
    expect(analysisOutcome([], false, true).exitCode).toBe(1);
    expect(analysisOutcome([], true, true).exitCode).toBe(2);
    expect(analysisOutcome(['failed'], true, true).exitCode).toBe(3);
  });
});
