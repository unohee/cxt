import { describe, expect, it } from 'vitest';
import { extractFile } from '../../src/registry/entityScanner.js';
import { resolveSymbols } from '../../src/analysis/resolveSymbols.js';
import { analyzeSummaries } from '../../src/analysis/summaries.js';
import { LibraryModelCatalog, modelConfigSchema, modelPackSchema, standardModelPack, type ModelConfig, type ModelPack } from '../../src/analysis/libraryModels.js';
import type { AstLanguage } from '../../src/frontend/types.js';

const config: ModelConfig = { schemaVersion: 1, versions: { node: '22.19.0', python: '3.12.0', rust: '1.85.0' }, assumptions: ['unmodified-external-bindings'], packs: [] };
const catalog = (options = config, packs = [standardModelPack]) => new LibraryModelCatalog(options, packs);
const symbol = { language: 'typescript' as const, module: 'node:path', symbol: 'basename' };
function analyze(source: string, language: AstLanguage = 'typescript', models = catalog(), others: Record<string, string> = {}) {
  const path = language === 'python' ? 'x.py' : language === 'rust' ? 'x.rs' : 'x.ts';
  const files = Object.entries({ [path]: source, ...others }).map(([file, code]) => extractFile(code, file, language, 'ast'));
  const sites = resolveSymbols(files.map(f => f.symbols!)).calls;
  return { sites, ...analyzeSummaries(files.flatMap(f => f.controlFlow!), sites, { models }) };
}

describe('external library contracts', () => {
  it.each([
    ['typescript', "import {basename as base} from 'node:path';function wrap(){return base('/tmp/x');}function f(){return wrap();}", '*string'],
    ['python', 'from math import sqrt as root\ndef wrap():\n return root(4)\ndef f():\n return wrap()', '*number'],
    ['rust', 'use std::cmp::min as smallest;fn wrap()->i32{smallest(2,3)}fn f()->i32{wrap()}', '*number'],
  ] as const)('substitutes %s model through wrappers and persists provenance', (language, source, atom) => {
    const result = analyze(source, language);
    expect(result.sites[0].external?.symbol).toBe(language === 'python' ? 'sqrt' : language === 'rust' ? 'min' : 'basename');
    expect(result.flows[0].calls[0].model?.status).toBe('applied');
    for (const summary of result.summaries) {
      expect(summary.completeness).toBe('complete');
      expect(summary.returnAtoms).toEqual([atom]);
      expect(summary.models?.[0]).toMatchObject({ pack: 'cxt.stdlib', packVersion: '1.0.0', assumption: 'unmodified-external-bindings' });
      expect(summary.models?.[0].digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('fails closed on version gaps, mismatches, overlapping contracts and missing assumptions', () => {
    expect(catalog({ ...config, versions: {} }).select(symbol).status).toBe('version-missing');
    expect(catalog({ ...config, versions: { node: '27.0.0' } }).select(symbol).status).toBe('version-mismatch');
    expect(catalog({ ...config, assumptions: [] }).select(symbol).status).toBe('assumption-missing');
    expect(catalog(config, [standardModelPack, { ...standardModelPack, id: 'other' }]).select(symbol).status).toBe('ambiguous');
    expect(catalog().select({ ...symbol, module: 'other' }).status).toBe('unmodeled');
    expect(catalog({ ...config, versions: { node: '22.0.0' } }).select(symbol).status).toBe('candidate');
  });

  it.each([
    ["import {basename} from 'node:path';function f(x){return basename(x);}", 'argument-domain'],
    ["import {basename} from 'node:path';function f(){return basename({});}", 'argument-domain'],
    ["import {basename} from 'node:path';function f(){return basename('x','.txt');}", 'argument-mapping'],
    ["import {basename} from 'node:path';function f(xs){return basename(...xs);}", 'argument-mapping'],
    ["import {basename} from 'node:path';function f(){unknown();return basename('x');}", 'callee-not-proven'],
    ["import * as path from 'node:path';function f(){return path.basename('x');}", 'callee-not-proven'],
  ])('does not suppress unknown effects when a call contract fails: %s', (source, status) => {
    const result = analyze(source);
    expect(result.flows[0].calls.at(-1)?.model?.status).toBe(status);
    expect(result.flows[0].unknownEffects.length).toBeGreaterThan(0);
    expect(result.summaries[0].completeness).toBe('partial');
  });

  it('retains a proven copied callable across later unknown mutation', () => {
    const result = analyze("import {basename} from 'node:path';function f(){const saved=basename;unknown();return saved('x');}");
    expect(result.flows[0].calls.at(-1)?.model?.status).toBe('applied');
    expect(result.summaries[0].completeness).toBe('partial'); // preceding unknown call remains
  });

  it('does not equate local same-name functions, parameters or local Python modules with stdlib', () => {
    const local = analyze('function basename(x){return 7;}function f(){return basename("x");}');
    expect(local.sites[0].external).toBeUndefined();
    expect(local.summaries.find(s => s.owner.endsWith('::f'))?.returnAtoms).toEqual(['number:7']);
    expect(analyze("import {basename} from 'node:path';function f(basename){return basename('x');}").sites[0].external).toBeUndefined();
    const python = analyze('from math import sqrt\ndef f():\n return sqrt(4)', 'python', catalog(), { 'math.py': 'def sqrt(x):\n return "local"' });
    expect(python.sites[0].external).toBeUndefined();
    expect(python.summaries.find(s => s.owner.endsWith('::f'))?.returnAtoms).toEqual(['string:"local"']);
  });

  it('carries external identities through reexports without turning factory results into imported functions', () => {
    const result = analyze("import {base} from './barrel';function f(){return base('x');}", 'typescript', catalog(), {
      'barrel.ts': "export {basename as base} from 'node:path';",
    });
    expect(result.sites[0].external).toEqual(symbol);
    expect(result.flows[0].calls[0].model?.status).toBe('applied');
    const factory = analyze("import {factory} from 'package';function f(){return factory().method();}");
    const method = factory.sites.find(site => site.expression === 'factory().method')!;
    expect(method.external).toBeUndefined();
    expect(method.resolution).toBe('unresolved');
  });

  it('validates user packs strictly including dependency bounds, versions and unknown fields', () => {
    for (const mutate of [
      (p: ModelPack) => { p.models[0].returns.dependsOn = [63]; },
      (p: ModelPack) => { p.models[0].returns.dependsOn = [0, 0]; },
      (p: ModelPack) => { p.models[0].versions.before = p.models[0].versions.min; },
      (p: ModelPack) => { p.models.push(p.models[0]); },
      (p: ModelPack) => { Object.assign(p.models[0], { eval: 'process.exit()' }); },
    ]) {
      const bad = structuredClone(standardModelPack); mutate(bad);
      expect(modelPackSchema.safeParse(bad).success).toBe(false);
    }
    expect(modelConfigSchema.safeParse({ ...config, versions: { node: '>=22' } }).success).toBe(false);
    expect(() => catalog(config, [standardModelPack, standardModelPack])).toThrow('Duplicate model pack');
  });

  it('models user-defined return/throw dependence and known heap effects without making unknown effects pure', () => {
    const custom = structuredClone(standardModelPack);
    custom.id = 'user.contracts'; custom.models = [{ ...custom.models[0], id: 'pick', module: 'user-package', symbol: 'pick', package: 'npm:user-package',
      versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['any', 'any'], returns: { type: 'number', dependsOn: [1] },
      throws: { possible: false, dependsOn: [] } }];
    const models = () => catalog({ ...config, versions: { 'npm:user-package': '1.0.0' } }, [custom]);
    const source = "import {pick} from 'user-package';function f(a,b){return pick(a,b);}";
    const result = analyze(source, 'typescript', models());
    expect(result.summaries[0].returnParameters).toEqual([expect.stringMatching(/:b$/)]);
    expect(result.summaries[0].mayThrow).toBe(false);
    custom.models[0].throws = { possible: true, dependsOn: [0] };
    const throwing = analyze(source, 'typescript', models());
    expect(throwing.summaries[0].throwParameters).toEqual([expect.stringMatching(/:a$/)]);
    custom.models[0].effects = 'heap';
    expect(analyze(source, 'typescript', models()).summaries[0].effects.heap).toBe(true);
    custom.models[0].effects = 'unknown';
    expect(analyze(source, 'typescript', models()).summaries[0].completeness).toBe('partial');
  });
});
