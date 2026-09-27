import { describe, expect, it } from 'vitest';
import { countMatches, metrics, checkGate, loadCorpus } from '../../bench/accuracy.js';
import { extractFile } from '../../src/registry/entityScanner.js';

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
});
