import { describe, expect, it } from 'vitest';
import { loadRuleCorpus, scoreRule, ruleFixturePass } from '../../bench/rule-accuracy.js';
import { analyzeSemanticRules } from '../../src/analysis/semanticRules.js';

describe('rule accuracy gate', () => {
  it.each(loadRuleCorpus())('$id satisfies its hand-labeled contract', fixture => {
    const findings = analyzeSemanticRules(fixture.source, fixture.file, fixture.language).findings.filter(hit => hit.rule.id === fixture.rule);
    expect(ruleFixturePass(scoreRule(fixture, findings))).toBe(true);
  });
  it('rejects extra, missing, duplicate, wrong-rule and inconsistent source-span mutations', () => {
    const fixture = loadRuleCorpus().find(f => f.id === 'debugger-statement-positive')!;
    const finding = analyzeSemanticRules(fixture.source, fixture.file, fixture.language).findings[0];
    expect(ruleFixturePass(scoreRule(fixture, []))).toBe(false);
    expect(ruleFixturePass(scoreRule(fixture, [finding, finding]))).toBe(false);
    expect(ruleFixturePass(scoreRule(fixture, [{ ...finding, rule: { ...finding.rule, id: 'cxt/another' } }]))).toBe(false);
    expect(ruleFixturePass(scoreRule(fixture, [{ ...finding, span: { ...finding.span, column: finding.span.column + 1 } }]))).toBe(false);
    const negative = loadRuleCorpus().find(f => f.id === 'debugger-statement-negative')!;
    expect(ruleFixturePass(scoreRule(negative, [finding]))).toBe(false);
  });
});
