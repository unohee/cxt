import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeAstRules } from '../../src/analysis/astRules.js';
import { builtInRules, pathRole, ruleConfigSchema } from '../../src/analysis/rulePack.js';
import type { AstLanguage } from '../../src/frontend/types.js';

const fixtures = JSON.parse(readFileSync(new URL('../../bench/corpus/rules.json', import.meta.url), 'utf8')) as Array<{
  id: string; language: AstLanguage; file: string; source: string; rule: string; lines: number[];
}>;
describe('AST rule contracts', () => {
  it.each(fixtures.filter(fixture => fixture.rule !== 'cxt/uninitialized-read'))('$id', fixture => {
    const hits = analyzeAstRules(fixture.source, fixture.file, fixture.language).filter(hit => hit.rule.id === fixture.rule);
    expect(hits.map(hit => hit.span.line)).toEqual(fixture.lines);
    for (const hit of hits) {
      expect(hit.span.endOffset).toBeGreaterThan(hit.span.startOffset);
      expect(hit.span.column).toBeGreaterThan(0);
      expect(hit.rule.rationale.length).toBeGreaterThan(10);
    }
  });

  it('requires positive and negative oracle cases for every migrated rule', () => {
    expect(builtInRules).toHaveLength(21);
    expect(new Set(builtInRules.map(rule => rule.id)).size).toBe(21);
    for (const rule of builtInRules) {
      expect(fixtures.find(f => f.id === rule.fixtures.positive)).toMatchObject({ rule: rule.id });
      expect(fixtures.find(f => f.id === rule.fixtures.negative)?.lines).toEqual([]);
    }
  });

  it('requires every catch path to propagate and ignores nested callback throws', () => {
    for (const body of ['if(flag)return;throw error;', 'const report=()=>{throw error;};return;', 'if(flag)throw error;']) {
      expect(analyzeAstRules(`try{work();}catch(error){${body}}`, 'x.ts', 'typescript').some(hit => hit.rule.id === 'cxt/catch-swallow')).toBe(true);
    }
    expect(analyzeAstRules('try{work();}catch(error){if(flag)throw error;throw error;}', 'x.ts', 'typescript').some(hit => hit.rule.id === 'cxt/catch-swallow')).toBe(false);
  });

  it('separates IPv4 octet projections from identical unbound numbers and reassigned variables', () => {
    const source = 'def public_ip(text):\n octets = [int(o) for o in text.split(".")]\n if any(o > 255 for o in octets):\n  return False\n a,b=octets[0],octets[1]\n return a == 192 and b == 168';
    const magic = (code: string) => analyzeAstRules(code, 'src/ip.py', 'python').filter(hit => hit.rule.id === 'cxt/magic-number');
    expect(magic(source)).toEqual([]);
    expect(magic('def f(a,b):\n return a == 192 and b == 168')).toHaveLength(2);
    expect(magic(source.replace(' return a ==', ' a = unknown()\n return a =='))).toHaveLength(1);
    expect(magic('admin = 400\nitems = 500')).toHaveLength(2);
    expect(magic('RETRYABLE = {402, 429, 502}\nLIMITS = {"light": 4000}')).toEqual([]);
  });

  it('does not suppress from literal text and scopes actual comment suppressions by category', () => {
    expect(analyzeAstRules("const x='// cxt-ignore'; eval(input);", 'x.ts', 'typescript').some(hit => hit.rule.id === 'cxt/eval-call')).toBe(true);
    expect(analyzeAstRules('eval(input); // cxt-ignore: security', 'x.ts', 'typescript')).toEqual([]);
    expect(analyzeAstRules('// cxt-ignore-next-line: type_safety\nconst x = value as any;', 'x.ts', 'typescript')).toEqual([]);
    expect(analyzeAstRules('const x = value as any; // cxt-ignore: security', 'x.ts', 'typescript').some(hit => hit.rule.id === 'cxt/as-any')).toBe(true);
  });

  it('applies explicit path roles by prefix boundaries with the most specific override', () => {
    const config = ruleConfigSchema.parse({ schemaVersion: 1, roles: [{ prefix: 'custom/tools', role: 'tooling' }, { prefix: 'custom/tools/lib', role: 'production' }] });
    expect(pathRole('custom/toolsmith/x.ts', config)).toBe('production');
    expect(analyzeAstRules("console.log('done');", 'custom/tools/x.ts', 'typescript', config)).toEqual([]);
    expect(analyzeAstRules("console.log('done');", 'custom/tools/lib/x.ts', 'typescript', config).some(hit => hit.rule.severity === 'critical')).toBe(true);
    expect(ruleConfigSchema.safeParse({ schemaVersion: 1, roles: [{ prefix: '../outside', role: 'test' }] }).success).toBe(false);
  });
});
