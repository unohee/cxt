import { describe, expect, it } from 'vitest';
import { loadImpactCorpus, evaluateImpact, impactFixturePass, scoreImpact } from '../../bench/impact-accuracy.js';
describe('parameter impact oracle', () => {
  const corpus = loadImpactCorpus();
  for (const fixture of corpus) it(fixture.id, () => expect(impactFixturePass(evaluateImpact(fixture).measured)).toBe(true));
  it('rejects fabricated candidates, missing paths, wrong source spans and duplicate results', () => {
    const fixture = corpus[0], { result, graphs } = evaluateImpact(fixture);
    const wrongSpan = structuredClone(result); wrongSpan.impacted[0].path[0].span.column++;
    const wrongCall = structuredClone(result); wrongCall.impacted[0].path[0].callNode = 0;
    for (const mutation of [wrongSpan, wrongCall, { ...result, impacted: [] },
      { ...result, impacted: [...result.impacted, { ...result.impacted[0], owner: 'x.ts::invented' }] },
      { ...result, impacted: [...result.impacted, result.impacted[0]] }]) {
      expect(impactFixturePass(scoreImpact(fixture, mutation, graphs))).toBe(false);
    }
  });
});
