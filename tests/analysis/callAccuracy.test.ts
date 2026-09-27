import { describe, expect, it } from 'vitest';
import { callMetrics, checkCallGate, countCallMatches, loadCallCorpus } from '../../bench/call-accuracy.js';
import { extractFile } from '../../src/registry/entityScanner.js';
import { resolveSymbols } from '../../src/analysis/resolveSymbols.js';

describe('call accuracy gate', () => {
  const gate = { precision: 0.95, recall: 0.9, siteAccuracy: 1, resolutionAccuracy: 0.95 };
  const fixture = loadCallCorpus().find(f => f.id === 'ts-import')!;
  const actual = resolveSymbols(Object.entries(fixture.files).map(([file, source]) => extractFile(source, file, fixture.language, 'ast').symbols!)).calls;

  it('passes exact handwritten labels', () => {
    expect(checkCallGate(callMetrics(countCallMatches(fixture.expected, actual)), gate)).toBe(true);
  });
  it('fails for wrong target, omitted call, wrong position and duplicate call mutations', () => {
    for (const corrupted of [
      actual.map(site => ({ ...site, target: 'other.ts::run' })), [],
      actual.map(site => ({ ...site, column: site.column + 1 })), [...actual, ...actual],
      actual.map(site => ({ ...site, target: undefined, resolution: 'unresolved' as const })),
    ]) {
      expect(checkCallGate(callMetrics(countCallMatches(fixture.expected, corrupted)), gate)).toBe(false);
    }
    expect(countCallMatches(fixture.expected, actual.map(site => ({ ...site, target: 'other.ts::run' }))))
      .toMatchObject({ tp: 0, fp: 1, fn: 1 });
  });
  it('counts fabricated targets on unresolved labels as false positives', () => {
    const labels = fixture.expected.map(label => [label[0], label[1], label[2], null, 'unresolved', undefined, undefined] as typeof label);
    expect(countCallMatches(labels, actual)).toMatchObject({ tp: 0, fp: 1, fn: 0 });
    expect(checkCallGate(callMetrics(countCallMatches(labels, actual)), gate)).toBe(false);
  });
});
