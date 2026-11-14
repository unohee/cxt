import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ExternalSymbol } from './symbols.js';
import type { FunctionSummary } from './summaryTypes.js';

const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).max(32);
const name = z.string().min(1).max(256);
const index = z.number().int().min(0).max(63);
const resourceSchema = z.object({
  action: z.enum(['acquire', 'release']),
  identity: z.enum(['return', 'receiver', 'argument']),
  parameter: index.optional(),
  enter: z.enum(['same', 'unknown']).optional(),
  /** Whether an acquired context manager suppresses an exceptional body exit. */
  suppress: z.enum(['never', 'possible', 'always']).optional(),
}).strict();
const ownershipSchema = z.object({
  moves: z.array(index).max(64).default([]),
  borrows: z.array(index).max(64).default([]),
}).strict();
const callbackSchema = z.object({
  parameter: z.union([index, z.literal('last')]),
  /** Whether the registered callback is removed after its first dispatch. */
  once: z.boolean().default(false),
  /** Event-name argument used when this callback is registered. */
  eventParameter: index.optional(),
  arguments: z.array(index).max(16).default([]),
  variadicArgumentsFrom: index.optional(),
  /** Callback argument positions supplied as opaque external taint. */
  taintArguments: z.array(index).max(16).default([]),
}).strict();
const emitSchema = z.object({
  eventParameter: index,
  argumentParameters: z.array(index).max(16).default([]),
}).strict();
const removeSchema = z.object({
  eventParameter: index.optional(),
  callbackParameter: index.optional(),
  all: z.boolean().optional(),
}).strict();
const taintSchema = z.object({
  source: z.boolean().optional(),
  sinkParameters: z.array(index).max(16).default([]),
  /** Input positions whose taint is explicitly preserved on the return value. */
  propagatesParameters: z.array(index).max(16).default([]),
  /** Preserve taint from every positional argument after the declared arity. */
  propagatesVariadic: z.boolean().optional(),
  /** Input positions whose taint is explicitly removed by this sanitizer. */
  sanitizesParameters: z.array(index).max(16).default([]),
}).strict();
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
  /** Python/other named argument names aligned with `parameters`; absent means positional-only. */
  parameterNames: z.array(name).max(64).optional(),
  /** Accept additional positional arguments after the declared prefix. */
  variadic: z.boolean().default(false),
  /** Declared trailing parameters that may be omitted by an overload. */
  optionalParameters: z.array(index).max(64).optional(),
  returns: z.object({ type: z.enum(['string', 'number', 'boolean', 'null', 'undefined', 'unit', 'unknown']), dependsOn: z.array(index).max(64) }).strict(),
  effects: z.enum(['none', 'heap', 'unknown']),
  /** Resource state is an explicit contract; generic __enter__/__exit__ is never inferred. */
  resource: resourceSchema.optional(),
  /** Explicit ownership contract for argument-consuming/borrowing APIs. */
  ownership: ownershipSchema.optional(),
  /** Explicit callback registration parameters; execution order is not inferred. */
  callbacks: z.array(callbackSchema).max(16).default([]),
  /** Explicit event payload delivery for a modeled callback dispatcher. */
  emits: emitSchema.optional(),
  /** Explicit listener removal for event-dispatch models. */
  removes: removeSchema.optional(),
  /** Explicit source/sink labels; taint is never inferred from names. */
  taint: taintSchema.optional(),
  throws: z.object({ possible: z.boolean(), dependsOn: z.array(index).max(64) }).strict(),
  source: z.string().url().max(2048),
}).strict().superRefine((model, context) => {
  if (compare(model.versions.min, model.versions.before) >= 0) context.addIssue({ code: 'custom', message: 'Version interval must be nonempty' });
  if (model.parameterNames && model.parameterNames.length !== model.parameters.length)
    context.addIssue({ code: 'custom', message: 'parameterNames must align with parameters' });
  if (model.parameterNames && new Set(model.parameterNames).size !== model.parameterNames.length)
    context.addIssue({ code: 'custom', message: 'parameterNames must be unique' });
  const optionalParameters = model.optionalParameters ?? [];
  if (new Set(optionalParameters).size !== optionalParameters.length
    || optionalParameters.some(i => i >= model.parameters.length)
    || optionalParameters.length > 0 && optionalParameters[0] !== model.parameters.length - optionalParameters.length
    || optionalParameters.some((i, position, values) => position > 0 && i !== values[position - 1] + 1))
    context.addIssue({ code: 'custom', message: 'Optional parameter indices must be unique, in-range, and trailing' });
  for (const indexes of [model.returns.dependsOn, model.throws.dependsOn]) {
    if (new Set(indexes).size !== indexes.length || indexes.some(i => i >= model.parameters.length)) context.addIssue({ code: 'custom', message: 'Dependency indices must be unique and within arity' });
  }
  if (!model.throws.possible && model.throws.dependsOn.length) context.addIssue({ code: 'custom', message: 'Nonthrowing models cannot have throw dependencies' });
  if (model.ownership) {
    for (const indexes of [model.ownership.moves, model.ownership.borrows]) {
      if (new Set(indexes).size !== indexes.length || indexes.some(i => i >= model.parameters.length))
        context.addIssue({ code: 'custom', message: 'Ownership parameter indices must be unique and within arity' });
    }
    if (model.ownership.moves.some(index => model.ownership!.borrows.includes(index)))
      context.addIssue({ code: 'custom', message: 'A parameter cannot be both moved and borrowed' });
  }
  if (model.resource?.identity === 'argument' && model.resource.parameter === undefined)
    context.addIssue({ code: 'custom', message: 'Argument resource contracts require a parameter index' });
  if (model.resource?.identity !== 'argument' && model.resource?.parameter !== undefined)
    context.addIssue({ code: 'custom', message: 'Only argument resource contracts may declare a parameter index' });
  if (model.resource?.parameter !== undefined && model.resource.parameter >= model.parameters.length)
    context.addIssue({ code: 'custom', message: 'Resource parameter index must be within arity' });
  if (model.resource?.action !== 'acquire' && model.resource?.enter !== undefined)
    context.addIssue({ code: 'custom', message: 'Only acquire resource contracts may declare enter identity' });
  if (model.resource?.action !== 'acquire' && model.resource?.suppress !== undefined)
    context.addIssue({ code: 'custom', message: 'Only acquire resource contracts may declare suppression behavior' });
  if (model.taint?.source && model.taint.sinkParameters.length)
    context.addIssue({ code: 'custom', message: 'A taint model cannot be both source and sink' });
  if (model.taint?.propagatesVariadic && !model.variadic)
    context.addIssue({ code: 'custom', message: 'Variadic taint propagation requires a variadic model' });
  if (model.taint) {
    const groups = [model.taint.sinkParameters, model.taint.propagatesParameters, model.taint.sanitizesParameters];
    for (const indexes of groups) {
      if (new Set(indexes).size !== indexes.length || indexes.some(i => i >= model.parameters.length))
        context.addIssue({ code: 'custom', message: 'Taint parameter indices must be unique and within arity' });
    }
    if (model.taint.propagatesParameters.some(i => model.taint!.sanitizesParameters.includes(i)))
      context.addIssue({ code: 'custom', message: 'A taint parameter cannot both propagate and sanitize' });
  }
  if (model.callbacks.some(callback => callback.arguments.some(argument => argument >= model.parameters.length)))
    context.addIssue({ code: 'custom', message: 'Callback argument indices must be within arity' });
  if (model.callbacks.some(callback => typeof callback.parameter === 'number' && callback.parameter >= model.parameters.length))
    context.addIssue({ code: 'custom', message: 'Callback parameter indices must be within arity' });
  if (model.callbacks.some(callback => new Set(callback.arguments).size !== callback.arguments.length))
    context.addIssue({ code: 'custom', message: 'Callback argument indices must be unique' });
  if (model.callbacks.some(callback => callback.variadicArgumentsFrom !== undefined
    && callback.variadicArgumentsFrom > model.parameters.length))
    context.addIssue({ code: 'custom', message: 'Variadic callback argument start must be within arity' });
  if (model.callbacks.some(callback => callback.eventParameter !== undefined && callback.eventParameter >= model.parameters.length))
    context.addIssue({ code: 'custom', message: 'Callback event parameter index must be within arity' });
  if (model.emits && (model.emits.eventParameter >= model.parameters.length
    || model.emits.argumentParameters.some(argument => argument >= model.parameters.length)
    || new Set(model.emits.argumentParameters).size !== model.emits.argumentParameters.length))
    context.addIssue({ code: 'custom', message: 'Event payload parameter indices must be unique and within arity' });
  if (model.removes && (!(model.removes.all ?? false) && model.removes.eventParameter === undefined
    || model.removes.eventParameter !== undefined && model.removes.eventParameter >= model.parameters.length
    || model.removes.callbackParameter !== undefined && model.removes.callbackParameter >= model.parameters.length))
    context.addIssue({ code: 'custom', message: 'Event removal parameter indices must be within arity' });
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
export type ResourceContract = NonNullable<LibraryModel['resource']>;
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
  if (model.taint?.source) atoms.push('tainted');
  return { owner: target, filePath: '', completeness: 'complete', reasons: [], parameters,
    returnAtoms: atoms, returnParameters: keys(model.returns.dependsOn), mayReturn: true,
    mayThrow: model.throws.possible, throwParameters: keys(model.throws.dependsOn),
    effects: { heap: model.effects !== 'none', bindings: [], parameters: model.effects === 'none' ? [] : keys(parameters.map(p => p.index)), unknown: model.effects === 'unknown' },
    component: -1, iterations: 0,
    ...(model.resource ? { resource: model.resource } : {}),
    ...(model.resource?.action === 'acquire' && model.resource.identity === 'return' ? { returnsResource: { source: 'fresh' as const, ...(model.resource.enter ? { enter: model.resource.enter } : {}) } } : {}),
    ...(model.resource?.action === 'release' && model.resource.identity === 'argument' && model.resource.parameter !== undefined
      ? { releasesResource: { parameter: model.resource.parameter } } : {}),
    ...(model.ownership?.moves.length ? { movesParameters: model.ownership.moves } : {}),
    ...(model.ownership?.borrows.length ? { borrowsParameters: model.ownership.borrows } : {}),
    ...(model.callbacks.length ? { callbackParameters: model.callbacks.map(callback => callback.parameter),
      callbackInvocations: model.callbacks.map(callback => ({ callbackParameter: callback.parameter, argumentParameters: callback.arguments,
        ...(callback.variadicArgumentsFrom !== undefined ? { variadicArgumentFrom: callback.variadicArgumentsFrom } : {}),
        ...(callback.taintArguments.length ? { taintArgumentPositions: callback.taintArguments } : {}) })) } : {}),
    ...(model.taint?.source ? { taintSource: true } : {}),
    ...(model.taint?.sinkParameters.length ? { taintSinkParameters: model.taint.sinkParameters } : {}),
    ...(model.taint?.propagatesParameters.length ? { taintReturnParameters: model.taint.propagatesParameters } : {}),
    ...(model.taint?.propagatesVariadic ? { taintReturnVariadic: true } : {}),
    ...(model.taint?.sanitizesParameters.length ? { taintSanitizesParameters: model.taint.sanitizesParameters } : {}) };
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
  parameters: LibraryModel['parameters'], type: LibraryModel['returns']['type'], source: string,
  taint?: LibraryModel['taint']): void {
  standard.push({ id: `${module}.${symbol}.${parameters.length}`, language, module, symbol, package: package_, versions: { min, before }, parameters,
    variadic: false, returns: { type, dependsOn: parameters.map((_, i) => i) }, effects: 'none', callbacks: [],
    ...(taint ? { taint } : {}), throws: { possible: true, dependsOn: parameters.map((_, i) => i) }, source });
}
// 적용 구간은 문서로 확인한 stable API 구간이다. runtime 버전을 추측하지 않는다.
for (const module of ['node:path', 'path']) for (const symbol of ['basename', 'dirname', 'extname', 'normalize', 'isAbsolute']) {
  add('typescript', module, symbol, 'node', '22.0.0', '27.0.0', ['string'], symbol === 'isAbsolute' ? 'boolean' : 'string', 'https://nodejs.org/api/path.html',
    symbol === 'isAbsolute' ? undefined : { source: false, sinkParameters: [], propagatesParameters: [0], sanitizesParameters: [] });
}
for (const module of ['node:path', 'path']) for (const symbol of ['join', 'resolve']) {
  standard.push({ id: `${module}.${symbol}.variadic-taint`, language: 'typescript', module, symbol, package: 'node',
    versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['string'], variadic: true,
    returns: { type: 'string', dependsOn: [0] }, effects: 'none', callbacks: [],
    taint: { source: false, sinkParameters: [], propagatesParameters: [0], propagatesVariadic: true, sanitizesParameters: [] },
    throws: { possible: true, dependsOn: [0] }, source: 'https://nodejs.org/api/path.html' });
}
for (const symbol of ['isfinite', 'isinf', 'isnan', 'sqrt', 'fabs', 'floor', 'ceil']) {
  add('python', 'math', symbol, 'python', '3.12.0', '3.13.0', ['number'], symbol.startsWith('is') ? 'boolean' : 'number', 'https://docs.python.org/3.12/library/math.html');
}
for (const symbol of ['basename', 'dirname', 'normpath', 'abspath']) {
  add('python', 'os.path', symbol, 'python', '3.12.0', '3.13.0', ['string'], 'string', 'https://docs.python.org/3.12/library/os.path.html',
    { source: false, sinkParameters: [], propagatesParameters: [0], sanitizesParameters: [] });
}
standard.push({ id: 'os.path.join.variadic-taint', language: 'python', module: 'os.path', symbol: 'join', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['string'], variadic: true,
  returns: { type: 'string', dependsOn: [0] }, effects: 'none', callbacks: [],
  taint: { source: false, sinkParameters: [], propagatesParameters: [0], propagatesVariadic: true, sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://docs.python.org/3.12/library/os.path.html#os.path.join' });
standard.push({ id: 'html.escape.sanitizer', language: 'python', module: 'html', symbol: 'escape', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['string'], parameterNames: ['s'], variadic: false,
  returns: { type: 'string', dependsOn: [0] }, effects: 'none', callbacks: [],
  taint: { sinkParameters: [], propagatesParameters: [], sanitizesParameters: [0] }, throws: { possible: true, dependsOn: [0] },
  source: 'https://docs.python.org/3.12/library/html.html#html.escape' });
standard.push({ id: 'shlex.quote.sanitizer', language: 'python', module: 'shlex', symbol: 'quote', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['string'], parameterNames: ['s'], variadic: false,
  returns: { type: 'string', dependsOn: [0] }, effects: 'none', callbacks: [],
  taint: { sinkParameters: [], propagatesParameters: [], sanitizesParameters: [0] }, throws: { possible: true, dependsOn: [0] },
  source: 'https://docs.python.org/3.12/library/shlex.html#shlex.quote' });
standard.push({ id: 'builtins.open.resource', language: 'python', module: 'builtins', symbol: 'open', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['string'], variadic: true,
  returns: { type: 'unknown', dependsOn: [0] }, effects: 'heap',
  resource: { action: 'acquire', identity: 'return', enter: 'same', suppress: 'never' }, callbacks: [],
  throws: { possible: true, dependsOn: [0] }, source: 'https://docs.python.org/3.12/library/functions.html#open' });
standard.push({ id: 'contextlib.suppress.resource', language: 'python', module: 'contextlib', symbol: 'suppress', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['any'], variadic: true,
  returns: { type: 'unknown', dependsOn: [] }, effects: 'none',
  resource: { action: 'acquire', identity: 'return', enter: 'unknown', suppress: 'possible' }, callbacks: [],
  throws: { possible: false, dependsOn: [] }, source: 'https://docs.python.org/3.12/library/contextlib.html#contextlib.suppress' });
standard.push({ id: 'builtins.input.taint-source', language: 'python', module: 'builtins', symbol: 'input', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['string'], parameterNames: ['prompt'], variadic: true,
  returns: { type: 'string', dependsOn: [] }, effects: 'none', callbacks: [],
  taint: { source: true, sinkParameters: [], propagatesParameters: [], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [] }, source: 'https://docs.python.org/3.12/library/functions.html#input' });
standard.push({ id: 'builtins.eval.taint-sink', language: 'python', module: 'builtins', symbol: 'eval', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['any'], parameterNames: ['source'], variadic: true,
  returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
  taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://docs.python.org/3.12/library/functions.html#eval' });
standard.push({ id: 'builtins.exec.taint-sink', language: 'python', module: 'builtins', symbol: 'exec', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['any'], parameterNames: ['source'], variadic: true,
  returns: { type: 'unit', dependsOn: [] }, effects: 'unknown', callbacks: [],
  taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://docs.python.org/3.12/library/functions.html#exec' });
standard.push({ id: 'builtins.compile.taint-propagator', language: 'python', module: 'builtins', symbol: 'compile', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['any'], parameterNames: ['source'], variadic: true,
  returns: { type: 'unknown', dependsOn: [0] }, effects: 'none', callbacks: [],
  taint: { source: false, sinkParameters: [], propagatesParameters: [0], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://docs.python.org/3.12/library/functions.html#compile' });
standard.push({ id: 'os.getenv.taint-source', language: 'python', module: 'os', symbol: 'getenv', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['string'], parameterNames: ['key'], variadic: true,
  returns: { type: 'string', dependsOn: [] }, effects: 'none', callbacks: [],
  taint: { source: true, sinkParameters: [], propagatesParameters: [], sanitizesParameters: [] },
  throws: { possible: false, dependsOn: [] }, source: 'https://docs.python.org/3.12/library/os.html#os.getenv' });
standard.push({ id: 'subprocess.run.taint-sink', language: 'python', module: 'subprocess', symbol: 'run', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['any'], parameterNames: ['args'], variadic: true,
  returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
  taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://docs.python.org/3.12/library/subprocess.html#subprocess.run' });
for (const [module, symbol, anchor] of [
  ['subprocess', 'Popen', 'subprocess.Popen'],
  ['os', 'system', 'os.system'],
  ['os', 'popen', 'os.popen'],
] as const) {
  standard.push({ id: `${module}.${symbol}.taint-sink`, language: 'python', module, symbol, package: 'python',
    versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['any'], parameterNames: [symbol === 'Popen' ? 'args' : symbol === 'system' ? 'command' : 'cmd'], variadic: true,
    returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
    taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
    throws: { possible: true, dependsOn: [0] }, source: `https://docs.python.org/3.12/library/${anchor.includes('subprocess') ? 'subprocess' : 'os'}.html#${anchor}` });
}
standard.push({ id: 'urllib.request.urlopen.taint-sink', language: 'python', module: 'urllib.request', symbol: 'urlopen', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['any'], parameterNames: ['url'], variadic: true,
  returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
  taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://docs.python.org/3.12/library/urllib.request.html#urllib.request.urlopen' });
standard.push({ id: 'urllib.request.Request.taint-propagator', language: 'python', module: 'urllib.request', symbol: 'Request', package: 'python',
  versions: { min: '3.12.0', before: '3.13.0' }, parameters: ['any'], parameterNames: ['url'], variadic: true,
  returns: { type: 'unknown', dependsOn: [0] }, effects: 'none', callbacks: [],
  taint: { source: false, sinkParameters: [], propagatesParameters: [0], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://docs.python.org/3.12/library/urllib.request.html#urllib.request.Request' });
standard.push({ id: 'child_process.exec.taint-sink', language: 'typescript', module: 'node:child_process', symbol: 'exec', package: 'node',
  versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['string'], variadic: true,
  returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
  taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://nodejs.org/api/child_process.html#child_processexeccommand-options-callback' });
for (const [symbol, anchor] of [
  ['execFile', 'child_processexecfilefile-args-options-callback'],
  ['execSync', 'child_processexecsynccommand-options'],
  ['spawn', 'child_processspawncommand-args-options'],
  ['spawnSync', 'child_processspawnsynccommand-args-options'],
] as const) {
  standard.push({ id: `child_process.${symbol}.taint-sink`, language: 'typescript', module: 'node:child_process', symbol, package: 'node',
    versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['any'], variadic: true,
    returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
    taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
    throws: { possible: true, dependsOn: [0] }, source: `https://nodejs.org/api/child_process.html#${anchor}` });
}
for (const [symbol, anchor] of [
  ['runInThisContext', 'vmruninthiscontextcode-options'],
  ['runInNewContext', 'vmruninnewcontextcode-contextobject-options'],
  ['runInContext', 'vmrunincontextcode-contextifiedobject-options'],
  ['compileFunction', 'vmcompilefunctioncode-params-options'],
] as const) {
  standard.push({ id: `vm.${symbol}.taint-sink`, language: 'typescript', module: 'node:vm', symbol, package: 'node',
    versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['any'], variadic: true,
    returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
    taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
    throws: { possible: true, dependsOn: [0] }, source: `https://nodejs.org/api/vm.html#${anchor}` });
}
standard.push({ id: 'global.eval.taint-sink', language: 'typescript', module: 'global', symbol: 'eval', package: 'node',
  versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['any'], variadic: true,
  returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
  taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval' });
standard.push({ id: 'global.Function.taint-sink', language: 'typescript', module: 'global', symbol: 'Function', package: 'node',
  versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['any'], variadic: true,
  returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
  taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/Function' });
standard.push({ id: 'global.fetch.taint-sink', language: 'typescript', module: 'global', symbol: 'fetch', package: 'node',
  versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['any'], variadic: true,
  returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
  taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch' });
standard.push({ id: 'global.URL.taint-propagator', language: 'typescript', module: 'global', symbol: 'URL', package: 'node',
  versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['any'], variadic: true,
  returns: { type: 'unknown', dependsOn: [0] }, effects: 'none', callbacks: [],
  taint: { source: false, sinkParameters: [], propagatesParameters: [0], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://developer.mozilla.org/en-US/docs/Web/API/URL/URL' });
for (const module of ['node:http', 'node:https']) for (const symbol of ['get', 'request']) {
  standard.push({ id: `${module}.${symbol}.url-taint-sink`, language: 'typescript', module, symbol, package: 'node',
    versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['any'], variadic: true,
    returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
    taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
    throws: { possible: true, dependsOn: [0] }, source: `https://nodejs.org/api/${module.slice(5)}.html#${module.slice(5)}_${symbol}` });
}
standard.push({ id: 'global.JSON.parse.taint-propagator', language: 'typescript', module: 'global', symbol: 'JSON.parse', package: 'node',
  versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['any'], parameterNames: ['text'], variadic: false,
  returns: { type: 'unknown', dependsOn: [0] }, effects: 'none', callbacks: [],
  taint: { source: false, sinkParameters: [], propagatesParameters: [0], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse' });
standard.push({ id: 'global.JSON.stringify.taint-propagator', language: 'typescript', module: 'global', symbol: 'JSON.stringify', package: 'node',
  versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['any'], parameterNames: ['value'], variadic: true,
  returns: { type: 'string', dependsOn: [0] }, effects: 'none', callbacks: [],
  taint: { source: false, sinkParameters: [], propagatesParameters: [0], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify' });
standard.push({ id: 'fs.readFileSync.taint-source', language: 'typescript', module: 'node:fs', symbol: 'readFileSync', package: 'node',
  versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['string'], variadic: true,
  returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
  taint: { source: true, sinkParameters: [], propagatesParameters: [], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://nodejs.org/api/fs.html#fsreadfilesyncpath-options' });
standard.push({ id: 'fs.readFile.callback-taint', language: 'typescript', module: 'node:fs', symbol: 'readFile', package: 'node',
  versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['string'], variadic: true,
  returns: { type: 'unit', dependsOn: [] }, effects: 'unknown', callbacks: [{ parameter: 'last', once: false, arguments: [], taintArguments: [1] }],
  throws: { possible: true, dependsOn: [0] }, source: 'https://nodejs.org/api/fs.html#fsreadfilepath-options-callback' });
standard.push({ id: 'fs.promises.readFile.taint-source', language: 'typescript', module: 'node:fs/promises', symbol: 'readFile', package: 'node',
  versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['string'], variadic: true,
  returns: { type: 'unknown', dependsOn: [] }, effects: 'unknown', callbacks: [],
  taint: { source: true, sinkParameters: [], propagatesParameters: [], sanitizesParameters: [] },
  throws: { possible: true, dependsOn: [0] }, source: 'https://nodejs.org/api/fs.html#fspromisesreadfilepath-options' });
for (const symbol of ['min', 'max']) {
  add('rust', 'std::cmp', symbol, 'rust', '1.85.0', '1.98.0', ['number', 'number'], 'number', `https://doc.rust-lang.org/std/cmp/fn.${symbol}.html`);
}
const callbackApis: Array<[string, string, LibraryModel['parameters']]> = [
  ['node:timers', 'setTimeout', ['any', 'number']], ['node:timers', 'setInterval', ['any', 'number']],
  ['node:timers', 'setImmediate', ['any']], ['node:process', 'nextTick', ['any']],
];
for (const [module, symbol, parameters] of callbackApis) {
  standard.push({ id: `${module}.${symbol}.callback`, language: 'typescript', module, symbol, package: 'node',
    versions: { min: '22.0.0', before: '27.0.0' }, parameters, variadic: true,
    returns: { type: 'unit', dependsOn: [] }, effects: 'none', callbacks: [{ parameter: 0, once: false, arguments: [], taintArguments: [] }],
    ...(symbol === 'setTimeout' || symbol === 'setInterval' ? {
      taint: { source: false, sinkParameters: [0], propagatesParameters: [], sanitizesParameters: [] },
    } : {}),
    throws: { possible: true, dependsOn: [] }, source: 'https://nodejs.org/api/timers.html' });
}
for (const symbol of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener']) {
  standard.push({ id: `node:events.EventEmitter.${symbol}.callback`, language: 'typescript', module: 'node:events', symbol: `EventEmitter.${symbol}`, package: 'node',
    versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['string', 'any'], variadic: false,
    returns: { type: 'unknown', dependsOn: [] }, effects: 'heap', callbacks: [{ parameter: 1, eventParameter: 0, once: symbol === 'once' || symbol === 'prependOnceListener', arguments: [], taintArguments: [] }],
    throws: { possible: true, dependsOn: [0, 1] }, source: 'https://nodejs.org/api/events.html#class-eventemitter' });
}
for (const symbol of ['off', 'removeListener']) {
  standard.push({ id: `node:events.EventEmitter.${symbol}.remove`, language: 'typescript', module: 'node:events', symbol: `EventEmitter.${symbol}`, package: 'node',
    versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['string', 'any'], variadic: false,
    returns: { type: 'unknown', dependsOn: [] }, effects: 'heap', callbacks: [], removes: { eventParameter: 0, callbackParameter: 1 },
    throws: { possible: true, dependsOn: [0, 1] }, source: 'https://nodejs.org/api/events.html#emitterremovelistenereventname-listener' });
}
standard.push({ id: 'node:events.EventEmitter.removeAllListeners.remove', language: 'typescript', module: 'node:events', symbol: 'EventEmitter.removeAllListeners', package: 'node',
  versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['string'], optionalParameters: [0], variadic: false,
  returns: { type: 'unknown', dependsOn: [] }, effects: 'heap', callbacks: [], removes: { eventParameter: 0, all: true },
  throws: { possible: true, dependsOn: [0] }, source: 'https://nodejs.org/api/events.html#emitterremovealllistenerseventname' });
standard.push({ id: 'node:events.EventEmitter.emit.dispatch', language: 'typescript', module: 'node:events', symbol: 'EventEmitter.emit', package: 'node',
  versions: { min: '22.0.0', before: '27.0.0' }, parameters: ['string', 'any'], variadic: true,
  returns: { type: 'boolean', dependsOn: [] }, effects: 'heap', emits: { eventParameter: 0, argumentParameters: [1] }, callbacks: [],
  throws: { possible: true, dependsOn: [0, 1] }, source: 'https://nodejs.org/api/events.html#emitteremit-eventname-args' });
standard.push({ id: 'std::mem.drop.1', language: 'rust', module: 'std::mem', symbol: 'drop', package: 'rust',
  versions: { min: '1.85.0', before: '1.98.0' }, parameters: ['any'], variadic: false, returns: { type: 'unit', dependsOn: [] },
  effects: 'none', ownership: { moves: [0], borrows: [] }, callbacks: [], throws: { possible: false, dependsOn: [] }, source: 'https://doc.rust-lang.org/std/mem/fn.drop.html' });
export const standardModelPack = modelPackSchema.parse({ schemaVersion: 1, id: 'cxt.stdlib', version: '1.0.0', models: standard });
