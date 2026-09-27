import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ExternalSymbol } from './symbols.js';
import type { FunctionSummary } from './summaryTypes.js';

const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).max(32);
const name = z.string().min(1).max(256);
const index = z.number().int().min(0).max(63);
const compare = (a: string, b: string) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
};
const modelSchema = z.object({
  id: name,
  language: z.enum(['typescript', 'python', 'rust']),
  module: name,
  symbol: name,
  package: name,
  versions: z.object({ min: version, before: version }).strict(),
  parameters: z.array(z.enum(['any', 'string', 'number', 'boolean', 'primitive'])).max(64),
  returns: z.object({ type: z.enum(['string', 'number', 'boolean', 'null', 'undefined', 'unit', 'unknown']), dependsOn: z.array(index).max(64) }).strict(),
  effects: z.enum(['none', 'heap', 'unknown']),
  throws: z.object({ possible: z.boolean(), dependsOn: z.array(index).max(64) }).strict(),
  source: z.string().url().max(2048),
}).strict().superRefine((model, context) => {
  if (compare(model.versions.min, model.versions.before) >= 0) context.addIssue({ code: 'custom', message: 'Version interval must be nonempty' });
  for (const indexes of [model.returns.dependsOn, model.throws.dependsOn]) {
    if (new Set(indexes).size !== indexes.length || indexes.some(i => i >= model.parameters.length)) context.addIssue({ code: 'custom', message: 'Dependency indices must be unique and within arity' });
  }
  if (!model.throws.possible && model.throws.dependsOn.length) context.addIssue({ code: 'custom', message: 'Nonthrowing models cannot have throw dependencies' });
});
export const modelPackSchema = z.object({ schemaVersion: z.literal(1), id: name, version,
  models: z.array(modelSchema).min(1).max(1000) }).strict().superRefine((pack, context) => {
  if (new Set(pack.models.map(m => m.id)).size !== pack.models.length) context.addIssue({ code: 'custom', message: 'Duplicate model ID' });
});
export const modelConfigSchema = z.object({ schemaVersion: z.literal(1),
  versions: z.record(name, version),
  assumptions: z.array(z.literal('unmodified-external-bindings')).max(1),
  packs: z.array(name).max(32).default([]),
}).strict();
export type LibraryModel = z.infer<typeof modelSchema>;
export type ModelPack = z.infer<typeof modelPackSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export interface ModelReference {
  pack: string; packVersion: string; digest: string; model: string; package: string; targetVersion: string;
  assumption: 'unmodified-external-bindings';
}
export interface ModelSelection {
  status: 'candidate' | 'unmodeled' | 'version-missing' | 'version-mismatch' | 'ambiguous' | 'assumption-missing';
  reference?: ModelReference;
  contract?: LibraryModel;
}
export interface ModelApplication extends Omit<ModelSelection, 'contract' | 'status'> {
  status: ModelSelection['status'] | 'applied' | 'argument-domain' | 'argument-mapping' | 'callee-not-proven';
}
export interface ModelManifest {
  schemaVersion: 1; configured: boolean; versionSource: 'project-declaration'; versions: Record<string, string>;
  assumptions: ModelConfig['assumptions']; packs: Array<{ id: string; version: string; digest: string }>;
}
export const externalKey = (symbol: ExternalSymbol) => `external:${JSON.stringify([symbol.language, symbol.module, symbol.symbol])}`;
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** JSON만 읽는다. 모델은 실행 코드/정규식/임의 표현식을 포함하지 않는다. */
export class LibraryModelCatalog {
  readonly manifest: ModelManifest;
  private readonly bySymbol = new Map<string, Array<{ model: LibraryModel; pack: ModelManifest['packs'][number] }>>();
  constructor(config: ModelConfig, packs: ModelPack[], configured = true) {
    const parsed = modelConfigSchema.parse(config), validated = packs.map(p => modelPackSchema.parse(p));
    if (new Set(validated.map(p => p.id)).size !== validated.length) throw new Error('Duplicate model pack ID');
    this.manifest = { schemaVersion: 1, configured, versionSource: 'project-declaration', versions: parsed.versions,
      assumptions: parsed.assumptions, packs: validated.map(p => ({ id: p.id, version: p.version, digest: digest(p) })) };
    for (const [i, pack] of validated.entries()) for (const model of pack.models) {
      const key = externalKey(model), entries = this.bySymbol.get(key) ?? [];
      entries.push({ model, pack: this.manifest.packs[i] }); this.bySymbol.set(key, entries);
    }
  }
  select(symbol: ExternalSymbol): ModelSelection {
    const candidates = this.bySymbol.get(externalKey(symbol)) ?? [];
    if (!candidates.length) return { status: 'unmodeled' };
    if (!this.manifest.assumptions.includes('unmodified-external-bindings')) return { status: 'assumption-missing' };
    const versioned = candidates.filter(({ model }) => Object.hasOwn(this.manifest.versions, model.package));
    if (versioned.length !== candidates.length) return { status: 'version-missing' };
    const applicable = versioned.filter(({ model }) => {
      const target = this.manifest.versions[model.package];
      return compare(target, model.versions.min) >= 0 && compare(target, model.versions.before) < 0;
    });
    if (!applicable.length) return { status: 'version-mismatch' };
    if (applicable.length !== 1) return { status: 'ambiguous' };
    const { model, pack } = applicable[0];
    return { status: 'candidate', contract: model, reference: { pack: pack.id, packVersion: pack.version, digest: pack.digest,
      model: model.id, package: model.package, targetVersion: this.manifest.versions[model.package], assumption: 'unmodified-external-bindings' } };
  }
}

/** 조건부 계약의 primitive 결과와 의존성만 요약한다. 구체적 값은 실행하지 않는다. */
export function modelSummary(target: string, model: LibraryModel): FunctionSummary {
  const parameters = model.parameters.map((_, index) => ({ key: `argument:${index}`, name: `argument${index}`, index, receiver: false }));
  const keys = (indices: number[]) => indices.map(i => parameters[i].key);
  const atoms = model.returns.type === 'unknown' ? ['*boolean', '*number', '*string', '*object', '*function', 'null', 'undefined', 'unit']
    : ['string', 'number', 'boolean'].includes(model.returns.type) ? [`*${model.returns.type}`] : [model.returns.type];
  return { owner: target, filePath: '', completeness: 'complete', reasons: [], parameters,
    returnAtoms: atoms, returnParameters: keys(model.returns.dependsOn), mayReturn: true,
    mayThrow: model.throws.possible, throwParameters: keys(model.throws.dependsOn),
    effects: { heap: model.effects !== 'none', bindings: [], parameters: model.effects === 'none' ? [] : keys(parameters.map(p => p.index)), unknown: model.effects === 'unknown' },
    component: -1, iterations: 0 };
}

async function readJson(path: string): Promise<unknown> {
  if ((await stat(path)).size > 1024 * 1024) throw new Error(`Model JSON exceeds 1 MiB: ${path}`);
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
export async function loadLibraryModels(projectPath: string): Promise<LibraryModelCatalog> {
  let input: unknown;
  try { input = await readJson(resolve(projectPath, '.cxt-models.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return new LibraryModelCatalog({ schemaVersion: 1, versions: {}, assumptions: [], packs: [] }, [standardModelPack], false);
  }
  const config = modelConfigSchema.parse(input), packs = [standardModelPack];
  for (const path of config.packs) packs.push(modelPackSchema.parse(await readJson(resolve(projectPath, path))));
  return new LibraryModelCatalog(config, packs);
}

const standard: LibraryModel[] = [];
function add(language: ExternalSymbol['language'], module: string, symbol: string, package_: string, min: string, before: string,
  parameters: LibraryModel['parameters'], type: LibraryModel['returns']['type'], source: string): void {
  standard.push({ id: `${module}.${symbol}.${parameters.length}`, language, module, symbol, package: package_, versions: { min, before }, parameters,
    returns: { type, dependsOn: parameters.map((_, i) => i) }, effects: 'none', throws: { possible: true, dependsOn: parameters.map((_, i) => i) }, source });
}
// 적용 구간은 문서로 확인한 stable API 구간이다. runtime 버전을 추측하지 않는다.
for (const module of ['node:path', 'path']) for (const symbol of ['basename', 'dirname', 'extname', 'normalize', 'isAbsolute']) {
  add('typescript', module, symbol, 'node', '22.0.0', '27.0.0', ['string'], symbol === 'isAbsolute' ? 'boolean' : 'string', 'https://nodejs.org/api/path.html');
}
for (const symbol of ['isfinite', 'isinf', 'isnan', 'sqrt', 'fabs', 'floor', 'ceil']) {
  add('python', 'math', symbol, 'python', '3.12.0', '3.13.0', ['number'], symbol.startsWith('is') ? 'boolean' : 'number', 'https://docs.python.org/3.12/library/math.html');
}
for (const symbol of ['min', 'max']) {
  add('rust', 'std::cmp', symbol, 'rust', '1.85.0', '1.98.0', ['number', 'number'], 'number', `https://doc.rust-lang.org/std/cmp/fn.${symbol}.html`);
}
export const standardModelPack = modelPackSchema.parse({ schemaVersion: 1, id: 'cxt.stdlib', version: '1.0.0', models: standard });
