import { describe, expect, it } from 'vitest';
import { countMatches, metrics, checkGate, loadCorpus } from '../../bench/accuracy.js';
import { extractFile } from '../../src/registry/entityScanner.js';
import { loadFlowCorpus, runFlowCorpus, validateHeldOutStatus, validateIndependentReview } from '../../bench/dataflow-accuracy.js';

const gate = { precision: 0.98, recall: 0.98, spanAccuracy: 0.98, scopeAccuracy: 0.98 };
describe('independent accuracy scoring and gates', () => {
  it('validates all 60 handwritten fixtures across three languages', () => {
    const corpus = loadCorpus();
    expect(corpus).toHaveLength(60);
    expect(new Set(corpus.map(f => f.language)).size).toBe(3);
  });

  it('does not hide duplicated predictions behind set deduplication', () => {
    const entities = extractFile('function real() {}', 'x.ts', 'typescript', 'ast').entities;
    const score = metrics(countMatches([['function', 'real', 1, 1, undefined]], [...entities, ...entities]));
    expect(score).toMatchObject({ tp: 1, fp: 1, fn: 0, precision: 0.5, recall: 1 });
    expect(checkGate(score, gate)).toBe(false);
  });

  it('fails when declarations disappear or their scope/span becomes wrong', () => {
    const fixture = loadCorpus().find(f => f.id === 'typescript/methods')!;
    const entities = extractFile(fixture.source, fixture.filePath, fixture.language, 'ast').entities;
    expect(checkGate(metrics(countMatches(fixture.expected, [])), gate)).toBe(false);
    expect(checkGate(metrics(countMatches(fixture.expected, entities.map(e => ({ ...e, lineEnd: 100 })))), gate)).toBe(false);
    expect(checkGate(metrics(countMatches(fixture.expected, entities.map(e => ({ ...e, scopedName: e.name })))), gate)).toBe(false);
  });

  it('rejects malformed thresholds instead of weakening the gate', () => {
    const measured = metrics({ tp: 1, fp: 0, fn: 0, spanCorrect: 1, scopeCorrect: 1 });
    expect(() => checkGate(measured, { ...gate, recall: -1 })).toThrow();
    expect(() => checkGate(measured, { ...gate, precision: NaN })).toThrow();
  });

  it('runs the held-out dataflow tier separately and preserves its provenance boundary', () => {
    const heldOut = loadFlowCorpus('held-out-review');
    const synthetic = loadFlowCorpus('synthetic-development');
    expect(heldOut).toHaveLength(6);
    expect(new Set(heldOut.map(fixture => fixture.id)).size).toBe(6);
    expect(heldOut.every(fixture => !synthetic.some(other => other.id === fixture.id || other.source === fixture.source))).toBe(true);
    const report = runFlowCorpus(heldOut, 'held-out-review');
    expect(report.tier).toBe('held-out-review');
    expect(report.pass).toBe(true);
    expect(report.results.every(result => result.fixtures === 2 && result.failures.length === 0)).toBe(true);
  });

  it('does not allow the pending held-out labels to be called independent review', () => {
    expect(() => loadFlowCorpus('held-out-review', { requireIndependentReview: true }))
      .toThrow('Independent second-reviewer sign-off is required');
  });

  it('allows the independent gate to consume an approved held-out status', () => {
    const base = { schemaVersion: 1, tier: 'held-out-review', reviewStatus: 'approved' };
    expect(() => validateHeldOutStatus(base, true)).not.toThrow();
    expect(() => validateHeldOutStatus({ ...base, reviewStatus: 'pending' }, true))
      .toThrow('Independent second-reviewer sign-off is required');
    expect(() => validateHeldOutStatus(base, false)).toThrow('Held-out provenance is incomplete');
  });

  it('requires both reviewers to cover every current label byte exactly', () => {
    const labels = new Map([['a', 'typescript'], ['b', 'python']]);
    const digest = 'a'.repeat(64);
    const base = { schemaVersion: 1, tier: 'held-out-review', reviewStatus: 'approved', labelsSha256: digest,
      fixtures: [{ id: 'a', language: 'typescript' }, { id: 'b', language: 'python' }] };
    const reviewer = (id: string, role: string, fixtureIds: string[], labelsSha256 = digest) => ({ id, role, fixtureIds, labelsSha256 });
    expect(() => validateIndependentReview({ ...base, reviewers: [reviewer('p', 'primary', ['a', 'b']), reviewer('s', 'secondary', ['a'], digest)] }, labels, digest))
      .toThrow('Independent second-reviewer sign-off is required');
    expect(() => validateIndependentReview({ ...base, reviewers: [reviewer('p', 'primary', ['a', 'b']), reviewer('s', 'secondary', ['a', 'b'], 'b'.repeat(64))] }, labels, digest))
      .toThrow('Independent second-reviewer sign-off is required');
    expect(() => validateIndependentReview({ ...base, reviewers: [reviewer('p', 'primary', ['a', 'b']), reviewer('s', 'secondary', ['a', 'b'])] }, labels, digest)).not.toThrow();
  });
});
