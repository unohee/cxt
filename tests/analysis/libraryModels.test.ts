import { describe, expect, it } from 'vitest';
import { extractFile } from '../../src/registry/entityScanner.js';
import { resolveSymbols } from '../../src/analysis/resolveSymbols.js';
import { analyzeSummaries } from '../../src/analysis/summaries.js';
import { LibraryModelCatalog, modelConfigSchema, modelPackSchema, modelSummary, standardModelPack, type ModelConfig, type ModelPack } from '../../src/analysis/libraryModels.js';
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
  ])('does not suppress unknown effects when a call contract fails: %s', (source, status) => {
    const result = analyze(source);
    expect(result.flows[0].calls.at(-1)?.model?.status).toBe(status);
    expect(result.flows[0].unknownEffects.length).toBeGreaterThan(0);
    expect(result.summaries[0].completeness).toBe('partial');
  });

  it('applies a model through default and namespace property imports', () => {
    for (const source of [
      "import * as path from 'node:path';function f(){return path.basename('x');}",
      "import path from 'node:path';function f(){return path.basename('x');}",
    ]) {
      const result = analyze(source);
      expect(result.sites[0].external).toEqual(symbol);
      expect(result.flows[0].calls[0].model?.status).toBe('applied');
      expect(result.summaries.find(summary => summary.owner.endsWith('::f'))?.returnAtoms).toEqual(['*string']);
    }
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
      (p: ModelPack) => { Object.assign(p.models[0], { ownership: { moves: [0], borrows: [0] } }); },
      (p: ModelPack) => { Object.assign(p.models[0], { taint: { propagatesParameters: [0], sanitizesParameters: [0] } }); },
      (p: ModelPack) => { Object.assign(p.models[0], { taint: { sinkParameters: [63] } }); },
      (p: ModelPack) => { Object.assign(p.models[0], { taint: { propagatesVariadic: true } }); },
      (p: ModelPack) => { Object.assign(p.models[0], { callbacks: [{ parameter: 0, variadicArgumentsFrom: 63 }] }); },
      (p: ModelPack) => { Object.assign(p.models[0], { callbacks: [{ parameter: 63 }] }); },
      (p: ModelPack) => { Object.assign(p.models[0], { callbacks: [{ parameter: 0, arguments: [0, 0] }] }); },
      (p: ModelPack) => { Object.assign(p.models[0], { parameterNames: ['first', 'extra'] }); },
      (p: ModelPack) => { Object.assign(p.models[0], { parameterNames: ['same'], parameters: ['any', 'any'] }); },
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

  it('applies the standard Python builtins.open resource contract through async and sync context managers', () => {
    const models = catalog();
    const sync = analyze("from builtins import open\ndef f():\n with open('tmp', 'r') as handle:\n  return handle\n", 'python', models);
    expect(sync.sites.find(site => site.external?.symbol === 'open')).toMatchObject({ external: { module: 'builtins', symbol: 'open' } });
    const syncFlow = sync.flows.find(item => item.owner.endsWith('::f'))!;
    expect(syncFlow.calls.some(call => call.model?.status === 'applied')).toBe(true);
    expect(syncFlow.resourceEvents.some(event => event.action === 'acquire' && event.proven)).toBe(true);
    expect(syncFlow.resourceEvents.some(event => event.action === 'release' && event.proven)).toBe(true);
    expect(syncFlow.diagnostics.some(diagnostic => diagnostic.message.includes('Context-manager return value'))).toBe(false);
    const asyncResult = analyze("from builtins import open\nasync def f():\n async with open('tmp') as handle:\n  return handle\n", 'python', models);
    const asyncFlow = asyncResult.flows.find(item => item.owner.endsWith('::f'))!;
    expect(asyncFlow.calls.some(call => call.model?.status === 'applied')).toBe(true);
    expect(asyncFlow.resourceEvents.some(event => event.action === 'acquire' && event.proven)).toBe(true);
    expect(asyncFlow.resourceEvents.some(event => event.action === 'release' && event.proven)).toBe(true);
    expect(asyncFlow.diagnostics.some(diagnostic => diagnostic.message.includes('Context-manager return value'))).toBe(false);
  });

  it('keeps a modeled context manager partial when its acquire arguments fail the contract', () => {
    const result = analyze("from builtins import open\ndef f():\n with open({}, 'r') as handle:\n  return handle\n", 'python', catalog());
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.status === 'argument-domain')).toBe(true);
    expect(flow.diagnostics.some(diagnostic => diagnostic.message.includes('Context-manager return value'))).toBe(true);
  });

  it('records statically proven callback targets from a modeled registration API', () => {
    const custom = structuredClone(standardModelPack);
    custom.id = 'callback.contracts';
    custom.models = [{ ...custom.models[0], id: 'register', module: 'callback-api', symbol: 'register', package: 'npm:callback-api',
      versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['string', 'any'],
      returns: { type: 'unit', dependsOn: [] }, callbacks: [{ parameter: 1 }], throws: { possible: false, dependsOn: [] } }];
    const models = catalog({ ...config, versions: { 'npm:callback-api': '1.0.0' } }, [custom]);
    const result = analyze("import {register} from 'callback-api';function handler(){}function wrap(cb){register('ready', cb);}function f(){wrap(handler);}", 'typescript', models);
    expect(result.summaries.find(summary => summary.owner.endsWith('::wrap'))?.callbackParameters).toEqual([0]);
    expect(result.flows.find(flow => flow.owner.endsWith('::f'))?.calls[0].callbacks).toEqual(['x.ts::handler']);
  });

  it('models Node callback scheduler registrations with explicit callback arity', () => {
    const timers = catalog({ ...config, versions: { node: '22.19.0' } });
    const timer = timers.select({ language: 'typescript', module: 'node:timers', symbol: 'setTimeout' });
    expect(timer.status).toBe('candidate');
    expect(modelSummary(timer.contract!.symbol, timer.contract!).callbackInvocations).toEqual([{ callbackParameter: 0, argumentParameters: [] }]);
    expect(timers.select({ language: 'typescript', module: 'node:timers', symbol: 'setImmediate' }).contract?.parameters).toEqual(['any']);
    expect(timers.select({ language: 'typescript', module: 'node:process', symbol: 'nextTick' }).contract?.parameters).toEqual(['any']);
    const registered = analyze("import {setImmediate} from 'node:timers';function handler(){}function f(){setImmediate(handler);}", 'typescript', timers);
    expect(registered.flows.find(flow => flow.owner.endsWith('::f'))?.calls[0]).toMatchObject({
      resolution: 'model', callbacks: ['x.ts::handler'], model: { status: 'applied' },
    });
    const variadic = analyze("import {setImmediate} from 'node:timers';function handler(){}function f(){setImmediate(handler, 'payload');}", 'typescript', timers);
    expect(variadic.flows.find(flow => flow.owner.endsWith('::f'))?.calls[0].model?.status).toBe('applied');
    for (const symbol of ['setTimeout', 'setInterval']) {
      const code = analyze(`import {${symbol}} from 'node:timers';function f(){${symbol}(process.env.CODE, 10);}`, 'typescript', timers);
      const codeFlow = code.flows.find(flow => flow.owner.endsWith('::f'))!;
      expect(codeFlow.taintFindings).toHaveLength(1);
      expect(codeFlow.taintFindings[0].target).toContain('node:timers');
    }
  });

  it('models Node EventEmitter callback registrations through external instances', () => {
    const result = analyze("import {EventEmitter} from 'node:events';const emitter=new EventEmitter();function handler(value){}function f(){emitter.on('data', handler);emitter.addListener('data', handler);emitter.once('data', handler);emitter.prependListener('data', handler);emitter.prependOnceListener('data', handler);}");
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls).toHaveLength(5);
    expect(flow.calls.every(call => call.model?.status === 'applied')).toBe(true);
    expect(flow.calls.map(call => call.model?.reference?.model)).toEqual([
      'node:events.EventEmitter.on.callback', 'node:events.EventEmitter.addListener.callback', 'node:events.EventEmitter.once.callback',
      'node:events.EventEmitter.prependListener.callback', 'node:events.EventEmitter.prependOnceListener.callback',
    ]);
    expect(flow.calls.every(call => call.callbacks?.includes('x.ts::handler'))).toBe(true);
  });

  it('applies external models to typed external receivers', () => {
    const result = analyze("import {EventEmitter} from 'node:events';function register(emitter: EventEmitter, callback){emitter.on('data', callback);}");
    const flow = result.flows.find(item => item.owner.endsWith('::register'))!;
    expect(flow.calls[0].model?.reference?.model).toBe('node:events.EventEmitter.on.callback');
    expect(flow.calls[0].model?.status).toBe('applied');
  });

  it('connects same-function EventEmitter emit payloads to registered callback sinks', () => {
    const result = analyze("import {EventEmitter} from 'node:events';import {readFileSync} from 'node:fs';function handler(value){eval(value);}function f(){const emitter=new EventEmitter();emitter.on('data', handler);emitter.emit('data', readFileSync('config.json','utf8'));}");
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'node:events.EventEmitter.emit.dispatch' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: 'x.ts::handler', parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) }]);
  });

  it('removes an EventEmitter once listener after its first dispatch', () => {
    const result = analyze("import {EventEmitter} from 'node:events';import {readFileSync} from 'node:fs';function handler(value){eval(value);}function f(){const emitter=new EventEmitter();emitter.once('data', handler);emitter.emit('data', readFileSync('first.json','utf8'));emitter.emit('data', readFileSync('second.json','utf8'));}");
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.filter(call => call.model?.reference?.model === 'node:events.EventEmitter.emit.dispatch' && call.model.status === 'applied')).toHaveLength(2);
    expect(flow.taintFindings).toHaveLength(1);
    expect(flow.taintFindings[0].target).toBe('x.ts::handler');
  });







  it('keeps EventEmitter payload delivery closed for other events', () => {
    const result = analyze("import {EventEmitter} from 'node:events';import {readFileSync} from 'node:fs';function handler(value){eval(value);}function f(){const emitter=new EventEmitter();emitter.on('data', handler);emitter.emit('other', readFileSync('config.json','utf8'));}");
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.taintFindings).toEqual([]);
  });

  it('keeps EventEmitter payload delivery closed for dynamic event names', () => {
    const result = analyze("import {EventEmitter} from 'node:events';import {readFileSync} from 'node:fs';function handler(value){eval(value);}function f(event){const emitter=new EventEmitter();emitter.on('data', handler);emitter.emit(event, readFileSync('config.json','utf8'));}");
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.taintFindings).toEqual([]);
  });

  it('keeps EventEmitter payload delivery intraprocedural', () => {
    const result = analyze("import {EventEmitter} from 'node:events';import {readFileSync} from 'node:fs';const emitter=new EventEmitter();function handler(value){eval(value);}function register(){emitter.on('data', handler);}function dispatch(){emitter.emit('data', readFileSync('config.json','utf8'));}function f(){register();dispatch();}");
    const flow = result.flows.find(item => item.owner.endsWith('::dispatch'))!;
    expect(flow.taintFindings).toEqual([]);
  });

  it('removes a specific EventEmitter listener before dispatch', () => {
    const result = analyze("import {EventEmitter} from 'node:events';import {readFileSync} from 'node:fs';function handler(value){eval(value);}function f(){const emitter=new EventEmitter();emitter.on('data', handler);emitter.off('data', handler);emitter.emit('data', readFileSync('config.json','utf8'));}");
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'node:events.EventEmitter.off.remove' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([]);
  });

  it('removes all EventEmitter listeners for an event before dispatch', () => {
    const result = analyze("import {EventEmitter} from 'node:events';import {readFileSync} from 'node:fs';function handler(value){eval(value);}function f(){const emitter=new EventEmitter();emitter.on('data', handler);emitter.removeAllListeners('data');emitter.emit('data', readFileSync('config.json','utf8'));}");
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'node:events.EventEmitter.removeAllListeners.remove' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([]);
  });

  it('removes all EventEmitter listeners when the event argument is omitted', () => {
    const result = analyze("import {EventEmitter} from 'node:events';import {readFileSync} from 'node:fs';function handler(value){eval(value);}function f(){const emitter=new EventEmitter();emitter.on('data', handler);emitter.removeAllListeners();emitter.emit('data', readFileSync('config.json','utf8'));}");
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'node:events.EventEmitter.removeAllListeners.remove' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([]);
  });

  it('propagates opaque Node fs.readFile callback data into a callback sink', () => {
    for (const source of [
      "import {readFile} from 'node:fs';function handler(error,data){eval(data);}function f(){readFile('config.json', handler);}",
      "import {readFile} from 'node:fs';function handler(error,data){eval(data);}function f(){readFile('config.json', {encoding:'utf8'}, handler);}",
    ]) {
      const result = analyze(source);
      const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
      expect(flow.calls.some(call => call.model?.reference?.model === 'fs.readFile.callback-taint' && call.model.status === 'applied')).toBe(true);
      expect(flow.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('handler'), parameter: 1,
        atoms: ['tainted:fs.readFile.callback-taint'], sourceDefinitions: ['external:callback:fs.readFile.callback-taint'] },
      ]);
    }
  });

  it('models fs.promises.readFile as an opaque file-content source', () => {
    const result = analyze("import {readFile} from 'node:fs/promises';function f(){return eval(readFile('config.json'));}");
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'fs.promises.readFile.taint-source' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('global'), parameter: 0,
        atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
  });

  it('tracks an explicit modeled taint source through a wrapper into a sink', () => {
    const custom = structuredClone(standardModelPack);
    custom.id = 'taint.contracts';
    custom.models = [
      { ...custom.models[0], id: 'readInput', module: 'taint-api', symbol: 'readInput', package: 'npm:taint-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: [], returns: { type: 'unknown', dependsOn: [] },
        taint: { source: true, sinkParameters: [] }, throws: { possible: false, dependsOn: [] } },
      { ...custom.models[0], id: 'execute', module: 'taint-api', symbol: 'execute', package: 'npm:taint-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['any'], returns: { type: 'unit', dependsOn: [] },
        taint: { sinkParameters: [0] }, throws: { possible: false, dependsOn: [] } },
      { ...custom.models[0], id: 'encode', module: 'taint-api', symbol: 'encode', package: 'npm:taint-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['any'], returns: { type: 'unknown', dependsOn: [0] },
        taint: { propagatesParameters: [0] }, throws: { possible: false, dependsOn: [] } },
      { ...custom.models[0], id: 'sanitize', module: 'taint-api', symbol: 'sanitize', package: 'npm:taint-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['any'], returns: { type: 'unknown', dependsOn: [0] },
        taint: { sanitizesParameters: [0] }, throws: { possible: false, dependsOn: [] } },
      { ...custom.models[0], id: 'register', module: 'taint-api', symbol: 'register', package: 'npm:taint-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['any', 'any'], returns: { type: 'unit', dependsOn: [] },
        callbacks: [{ parameter: 1, arguments: [0] }], throws: { possible: false, dependsOn: [] } },
      { ...custom.models[0], id: 'register-python', language: 'python', module: 'taint_api', symbol: 'register', package: 'pypi:taint-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['any', 'any'], parameterNames: ['data', 'cb'], returns: { type: 'unit', dependsOn: [] },
        callbacks: [{ parameter: 1, arguments: [0] }], throws: { possible: false, dependsOn: [] } },
      { ...custom.models[0], id: 'schedule', module: 'taint-api', symbol: 'schedule', package: 'npm:taint-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['any'], variadic: true, returns: { type: 'unit', dependsOn: [] },
        callbacks: [{ parameter: 0, arguments: [], variadicArgumentsFrom: 1 }], throws: { possible: false, dependsOn: [] } },
    ];
    const models = catalog({ ...config, versions: { 'npm:taint-api': '1.0.0' } }, [custom]);
    const result = analyze("import {readInput, execute} from 'taint-api';function load(){return readInput();}function f(){const value=load();execute(value);}", 'typescript', models);
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('execute'), parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) }]);
    const transformed = analyze("import {readInput, encode, execute} from 'taint-api';function f(){const value=readInput();execute(encode(value));}", 'typescript', models);
    expect(transformed.flows.find(item => item.owner.endsWith('::f'))?.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('execute'), parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
    const memberFlow = analyze("import {readInput, execute} from 'taint-api';function f(obj){obj.payload=readInput();execute(obj.payload);}", 'typescript', models);
    expect(memberFlow.flows.find(item => item.owner.endsWith('::f'))?.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('execute'), parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
    const concatenated = analyze("import {readInput, execute} from 'taint-api';function f(){execute(readInput() + '!');}", 'typescript', models);
    expect(concatenated.flows.find(item => item.owner.endsWith('::f'))?.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('execute'), parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
    const nullish = analyze("import {readInput, execute} from 'taint-api';function f(){execute(readInput() ?? 'fallback');}", 'typescript', models);
    expect(nullish.flows.find(item => item.owner.endsWith('::f'))?.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('execute'), parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
    const nonNull = analyze("import {readInput, execute} from 'taint-api';function f(){execute(readInput()!);}", 'typescript', models);
    expect(nonNull.flows.find(item => item.owner.endsWith('::f'))?.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('execute'), parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
    const sanitized = analyze("import {readInput, sanitize, execute} from 'taint-api';function f(){const value=readInput();execute(sanitize(value));}", 'typescript', models);
    expect(sanitized.flows.find(item => item.owner.endsWith('::f'))?.taintFindings).toEqual([]);
    const wrappedSink = analyze("import {readInput, execute} from 'taint-api';function sinkWrapper(value){execute(value);}function f(){sinkWrapper(readInput());}", 'typescript', models);
    expect(wrappedSink.summaries.find(summary => summary.owner.endsWith('::sinkWrapper'))?.taintSinkParameters).toEqual([0]);
    expect(wrappedSink.flows.find(item => item.owner.endsWith('::f'))?.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('sinkWrapper'), parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
    const callbackSink = analyze("import {readInput, register, execute} from 'taint-api';function handler(value){execute(value);}function f(){register(readInput(), handler);}", 'typescript', models);
    expect(callbackSink.flows.find(item => item.owner.endsWith('::f'))?.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('handler'), parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
    const wrappedCallbackSink = analyze("import {readInput, register, execute} from 'taint-api';function registerWrapper(data, cb){register(data, cb);}function handler(value){execute(value);}function f(){registerWrapper(readInput(), handler);}", 'typescript', models);
    expect(wrappedCallbackSink.summaries.find(summary => summary.owner.endsWith('::registerWrapper'))?.callbackInvocations).toEqual([{ callbackParameter: 1, argumentParameters: [0] }]);
    expect(wrappedCallbackSink.flows.find(item => item.owner.endsWith('::f'))?.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('handler'), parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
    const keywordCallback = analyze(
      'from taint_api import register\ndef f(data, cb):\n    register(cb=cb, data=data)\n', 'python',
      catalog({ ...config, versions: { ...config.versions, 'pypi:taint-api': '1.0.0' } }, [custom]));
    const keywordFlow = keywordCallback.flows.find(item => item.owner.endsWith('::f'))!;
    expect(keywordFlow.calls.find(call => call.target?.includes('register'))?.model?.status).toBe('applied');
    expect(keywordCallback.summaries.find(summary => summary.owner.endsWith('::f'))?.callbackParameters).toEqual([1]);
    expect(keywordCallback.summaries.find(summary => summary.owner.endsWith('::f'))?.callbackInvocations).toEqual([{ callbackParameter: 1, argumentParameters: [0] }]);
    const variadicCallbackSink = analyze("import {readInput, schedule, execute} from 'taint-api';function handler(value){execute(value);}function f(){schedule(handler, readInput());}", 'typescript', models);
    expect(variadicCallbackSink.flows.find(item => item.owner.endsWith('::f'))?.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('handler'), parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
    const wrappedVariadicCallbackSink = analyze("import {readInput, schedule, execute} from 'taint-api';function scheduleWrapper(cb, value){schedule(cb, value);}function handler(value){execute(value);}function f(){scheduleWrapper(handler, readInput());}", 'typescript', models);
    expect(wrappedVariadicCallbackSink.summaries.find(summary => summary.owner.endsWith('::scheduleWrapper'))?.callbackInvocations).toEqual([
      { callbackParameter: 0, argumentParameters: [], variadicArgumentParameters: [1] },
    ]);
    expect(wrappedVariadicCallbackSink.flows.find(item => item.owner.endsWith('::f'))?.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('handler'), parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
  });

  it('keeps an effectful Python sink contract through cross-file wrappers', () => {
    const result = analyze(
      'from source import load\nfrom sink import run\ndef f():\n return run(load())\n',
      'python', catalog(), {
        'source.py': 'from builtins import input\ndef load():\n return input("x")\n',
        'sink.py': 'from builtins import eval\ndef run(value):\n return eval(value)\n',
      });
    const sink = result.summaries.find(summary => summary.owner === 'sink.py::run')!;
    expect(sink.completeness).toBe('partial');
    expect(sink.taintSinkParameters).toEqual([0]);
    expect(result.flows.find(flow => flow.owner === 'x.py::f')?.taintFindings).toEqual([
      { node: expect.any(Number), target: 'sink.py::run', parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
  });

  it('models unqualified Python builtins without treating local shadowing as external', () => {
    const builtin = analyze('def f():\n return eval(input("x"))\n', 'python', catalog());
    const flow = builtin.flows.find(item => item.owner === 'x.py::f')!;
    expect(flow.calls.filter(call => call.model?.status === 'applied')).toHaveLength(2);
    expect(flow.taintFindings).toEqual([
      { node: expect.any(Number), target: expect.stringContaining('builtins","eval'), parameter: 0, atoms: ['tainted'], sourceDefinitions: expect.any(Array) },
    ]);
    const shadowed = analyze('def eval(value):\n return value\ndef f():\n return eval("safe")\n', 'python', catalog());
    expect(shadowed.flows.find(item => item.owner === 'x.py::f')?.calls.some(call => call.model?.status === 'applied')).toBe(false);
  });

  it('models the unqualified TypeScript global eval sink without local shadowing', () => {
    const builtin = analyze("import {readFileSync} from 'node:fs';function f(){eval(readFileSync('x','utf8'));}", 'typescript', catalog());
    const flow = builtin.flows.find(item => item.owner === 'x.ts::f')!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'fs.readFileSync.taint-source' && call.model.status === 'applied')).toBe(true);
    expect(flow.calls.some(call => call.model?.reference?.model === 'global.eval.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('global'), parameter: 0,
      atoms: ['tainted'], sourceDefinitions: expect.any(Array) }]);
    const shadowed = analyze("function eval(value){return value;}function f(){return eval('safe');}", 'typescript', catalog());
    expect(shadowed.flows.find(item => item.owner === 'x.ts::f')?.calls.some(call => call.model?.status === 'applied')).toBe(false);
  });

  it('models the unqualified TypeScript global Function constructor as a code sink', () => {
    const builtin = analyze("import {readFileSync} from 'node:fs';function f(){return Function(readFileSync('x','utf8'));}", 'typescript', catalog());
    const flow = builtin.flows.find(item => item.owner === 'x.ts::f')!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'global.Function.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('global'), parameter: 0,
      atoms: ['tainted'], sourceDefinitions: expect.any(Array) }]);
    const constructed = analyze("import {readFileSync} from 'node:fs';function f(){return new Function(readFileSync('x','utf8'));}", 'typescript', catalog());
    const constructedFlow = constructed.flows.find(item => item.owner === 'x.ts::f')!;
    expect(constructedFlow.calls.some(call => call.model?.reference?.model === 'global.Function.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(constructedFlow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('global'), parameter: 0,
      atoms: ['tainted'], sourceDefinitions: expect.any(Array) }]);
    const shadowed = analyze("function Function(value){return value;}function f(){return Function('safe');}", 'typescript', catalog());
    expect(shadowed.flows.find(item => item.owner === 'x.ts::f')?.calls.some(call => call.model?.status === 'applied')).toBe(false);
  });

  it('preserves taint through external global JSON serialization APIs', () => {
    for (const [method, source] of [
      ['parse', "JSON.parse(readFileSync('x','utf8'))"],
      ['stringify', "JSON.stringify(readFileSync('x','utf8'))"],
    ] as const) {
      const result = analyze(`import {readFileSync} from 'node:fs';function f(){return eval(${source});}`);
      const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
      expect(flow.calls.some(call => call.model?.reference?.model === `global.JSON.${method}.taint-propagator` && call.model.status === 'applied')).toBe(true);
      expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('global'), parameter: 0,
        atoms: ['tainted'], sourceDefinitions: expect.any(Array) }]);
    }
    const shadowed = analyze("const JSON={parse(value){return 'safe';}};import {readFileSync} from 'node:fs';function f(){return eval(JSON.parse(readFileSync('x','utf8')));}");
    expect(shadowed.flows.find(item => item.owner.endsWith('::f'))?.calls.some(call => call.model?.reference?.model === 'global.JSON.parse.taint-propagator')).toBe(false);
  });

  it('models Node process.env member reads as taint sources without local shadowing', () => {
    const builtin = analyze("function f(){eval(process.env.CODE);}", 'typescript', catalog());
    const flow = builtin.flows.find(item => item.owner === 'x.ts::f')!;
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('global'), parameter: 0,
      atoms: ['tainted:node-process-env'], sourceDefinitions: ['external:node:process.env'] }]);
    const shadowed = analyze("function f(process){eval(process.env.CODE);}", 'typescript', catalog());
    expect(shadowed.flows.find(item => item.owner === 'x.ts::f')?.taintFindings).toEqual([]);
  });

  it('models Python os.environ member reads as taint sources without local shadowing', () => {
    const builtin = analyze("import os\nfrom builtins import eval\ndef f():\n eval(os.environ['CODE'])\n", 'python', catalog());
    const flow = builtin.flows.find(item => item.owner === 'x.py::f')!;
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('builtins'), parameter: 0,
      atoms: ['tainted:python-os-environ'], sourceDefinitions: ['external:python:os.environ'] }]);
    const shadowed = analyze("def f(os):\n eval(os.environ['CODE'])\n", 'python', catalog());
    expect(shadowed.flows.find(item => item.owner === 'x.py::f')?.taintFindings).toEqual([]);
  });

  it('tracks environment-derived URLs into exact external request sinks', () => {
    const node = analyze("async function f(){await fetch(process.env.URL);}", 'typescript', catalog());
    const nodeFlow = node.flows.find(item => item.owner.endsWith('::f'))!;
    expect(nodeFlow.calls.some(call => call.model?.reference?.model === 'global.fetch.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(nodeFlow.taintFindings.some(finding => finding.parameter === 0 && finding.atoms.includes('tainted:node-process-env'))).toBe(true);
    const urlObject = analyze("async function f(){await fetch(new URL(process.env.URL));}", 'typescript', catalog());
    const urlFlow = urlObject.flows.find(item => item.owner.endsWith('::f'))!;
    expect(urlFlow.calls.some(call => call.model?.reference?.model === 'global.URL.taint-propagator' && call.model.status === 'applied')).toBe(true);
    expect(urlFlow.calls.some(call => call.model?.reference?.model === 'global.fetch.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(urlFlow.taintFindings.some(finding => finding.parameter === 0 && finding.atoms.includes('tainted:node-process-env'))).toBe(true);
    const python = analyze("import os\nfrom urllib.request import urlopen\ndef f():\n urlopen(os.getenv('URL'))\n", 'python', catalog());
    const pythonFlow = python.flows.find(item => item.owner.endsWith('::f'))!;
    expect(pythonFlow.calls.some(call => call.model?.reference?.model === 'urllib.request.urlopen.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(pythonFlow.taintFindings.some(finding => finding.parameter === 0 && finding.atoms.includes('tainted')
      && finding.sourceDefinitions?.some(definition => definition.includes('os') && definition.includes('getenv')))).toBe(true);
    const requestObject = analyze("import os\nfrom urllib.request import Request, urlopen\ndef f():\n urlopen(Request(os.getenv('URL')))\n", 'python', catalog());
    const requestFlow = requestObject.flows.find(item => item.owner.endsWith('::f'))!;
    expect(requestFlow.calls.some(call => call.model?.reference?.model === 'urllib.request.Request.taint-propagator' && call.model.status === 'applied')).toBe(true);
    expect(requestFlow.calls.some(call => call.model?.reference?.model === 'urllib.request.urlopen.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(requestFlow.taintFindings.some(finding => finding.parameter === 0 && finding.atoms.includes('tainted'))).toBe(true);
    const http = analyze("import {get} from 'node:https';function f(){get(process.env.URL);}", 'typescript', catalog());
    const httpFlow = http.flows.find(item => item.owner.endsWith('::f'))!;
    expect(httpFlow.calls.some(call => call.model?.reference?.model === 'node:https.get.url-taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(httpFlow.taintFindings.some(finding => finding.parameter === 0 && finding.atoms.includes('tainted:node-process-env'))).toBe(true);
    const options = analyze("import {request} from 'node:https';function f(){request({hostname: process.env.HOST});}", 'typescript', catalog());
    const optionsFlow = options.flows.find(item => item.owner.endsWith('::f'))!;
    expect(optionsFlow.calls.some(call => call.model?.reference?.model === 'node:https.request.url-taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(optionsFlow.taintFindings.some(finding => finding.parameter === 0 && finding.atoms.includes('tainted:node-process-env'))).toBe(true);
    const pathJoin = analyze("import {join} from 'node:path'; function f(){eval(join('safe', process.env.CODE));}", 'typescript', catalog());
    const pathFlow = pathJoin.flows.find(item => item.owner.endsWith('::f'))!;
    expect(pathFlow.calls.some(call => call.model?.reference?.model === 'node:path.join.variadic-taint' && call.model.status === 'applied')).toBe(true);
    expect(pathFlow.calls.some(call => call.model?.reference?.model === 'global.eval.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(pathFlow.taintFindings.some(finding => finding.parameter === 0 && finding.atoms.includes('tainted:node-process-env'))).toBe(true);
  });

  it('applies the standard Python html.escape sanitizer without name-based inference', () => {
    const custom = structuredClone(standardModelPack);
    custom.id = 'python-taint.contracts';
    custom.models = [
      { ...custom.models[0], id: 'readInput', language: 'python', module: 'taint_api', symbol: 'read_input', package: 'python-taint-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: [], returns: { type: 'string', dependsOn: [] },
        taint: { source: true, sinkParameters: [] }, throws: { possible: false, dependsOn: [] } },
      { ...custom.models[0], id: 'execute', language: 'python', module: 'taint_api', symbol: 'execute', package: 'python-taint-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['any'], returns: { type: 'unit', dependsOn: [] },
        taint: { sinkParameters: [0] }, throws: { possible: false, dependsOn: [] } },
    ];
    const models = catalog({ ...config, versions: { python: '3.12.0', 'python-taint-api': '1.0.0' } }, [standardModelPack, custom]);
    const result = analyze("from html import escape\nfrom taint_api import read_input, execute\ndef f():\n execute(escape(read_input()))\n", 'python', models);
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.find(call => call.model?.reference?.model === 'html.escape.sanitizer')?.model?.status).toBe('applied');
    expect(flow.taintFindings).toEqual([]);
  });

  it('applies shlex.quote as an explicit command sanitizer before shell sinks', () => {
    const result = analyze("from os import getenv, system\nfrom shlex import quote\ndef f():\n system(quote(getenv('COMMAND')))", 'python', catalog());
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.find(call => call.model?.reference?.model === 'shlex.quote.sanitizer')?.model?.status).toBe('applied');
    expect(flow.calls.find(call => call.model?.reference?.model === 'os.system.taint-sink')?.model?.status).toBe('applied');
    expect(flow.taintFindings).toEqual([]);
  });

  it('preserves the shlex.quote sanitizer contract through a wrapper summary', () => {
    const result = analyze("from os import getenv, system\nfrom shlex import quote\ndef safe(value):\n return quote(value)\ndef f():\n system(safe(getenv('COMMAND')))", 'python', catalog());
    const wrapper = result.summaries.find(summary => summary.owner.endsWith('::safe'))!;
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(wrapper.taintSanitizesParameters).toEqual([0]);
    expect(flow.taintFindings).toEqual([]);
  });

  it('tracks standard Python input to eval as a modeled taint source and sink', () => {
    const result = analyze("from builtins import input, eval\ndef f():\n eval(input('expression'))\n", 'python', catalog());
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'builtins.input.taint-source' && call.model.status === 'applied')).toBe(true);
    expect(flow.calls.some(call => call.model?.reference?.model === 'builtins.eval.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('builtins'), parameter: 0,
      atoms: ['tainted'], sourceDefinitions: expect.any(Array) }]);
  });

  it('tracks standard Python input to exec as a dynamic-code sink', () => {
    const result = analyze("from builtins import input, exec\ndef f():\n exec(input('source'))\n", 'python', catalog());
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'builtins.input.taint-source' && call.model.status === 'applied')).toBe(true);
    expect(flow.calls.some(call => call.model?.reference?.model === 'builtins.exec.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('builtins'), parameter: 0,
      atoms: ['tainted'], sourceDefinitions: expect.any(Array) }]);
    const shadowed = analyze("def exec(value):\n return value\ndef f():\n exec('safe')\n", 'python', catalog());
    expect(shadowed.flows.find(item => item.owner.endsWith('::f'))?.calls.some(call => call.model?.status === 'applied')).toBe(false);
  });

  it('preserves Python taint through compile before the exec sink', () => {
    const result = analyze("from builtins import input, compile, exec\ndef f():\n exec(compile(input('source'), '<input>', 'exec'))\n", 'python', catalog());
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'builtins.compile.taint-propagator' && call.model.status === 'applied')).toBe(true);
    expect(flow.calls.some(call => call.model?.reference?.model === 'builtins.exec.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('builtins'), parameter: 0,
      atoms: ['tainted'], sourceDefinitions: expect.arrayContaining([expect.stringContaining('"builtins","compile"')]) }]);
  });

  it('tracks standard Python environment input to subprocess.run as command taint', () => {
    const result = analyze("from os import getenv\nfrom subprocess import run\ndef f():\n run(getenv('COMMAND'))\n", 'python', catalog());
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'os.getenv.taint-source' && call.model.status === 'applied')).toBe(true);
    expect(flow.calls.some(call => call.model?.reference?.model === 'subprocess.run.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('subprocess'), parameter: 0,
      atoms: ['tainted'], sourceDefinitions: expect.arrayContaining([expect.stringContaining('"os","getenv"')]) }]);
  });

  it('applies Python library models to named keyword arguments', () => {
    const result = analyze("from os import getenv\nfrom subprocess import run\ndef f():\n run(args=getenv('COMMAND'))\n", 'python', catalog());
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'subprocess.run.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('subprocess'), parameter: 0,
      atoms: ['tainted'], sourceDefinitions: expect.any(Array) }]);
  });

  it('maps reordered named arguments to the contract sink parameter', () => {
    const custom = structuredClone(standardModelPack);
    custom.id = 'keyword.contracts';
    custom.models = [
      { ...custom.models[0], id: 'readInput', language: 'python', module: 'keyword_api', symbol: 'readInput', package: 'npm:keyword-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: [], returns: { type: 'string', dependsOn: [] },
        taint: { source: true, sinkParameters: [] }, throws: { possible: false, dependsOn: [] } },
      { ...custom.models[0], id: 'execute', language: 'python', module: 'keyword_api', symbol: 'execute', package: 'npm:keyword-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['string', 'any'], parameterNames: ['first', 'second'],
        returns: { type: 'unit', dependsOn: [] }, taint: { sinkParameters: [1] }, throws: { possible: false, dependsOn: [] } },
    ];
    const models = catalog({ ...config, versions: { 'npm:keyword-api': '1.0.0' } }, [custom]);
    const result = analyze("from keyword_api import readInput, execute\ndef f():\n execute(second=readInput(), first='safe')\n", 'python', models);
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('keyword_api'), parameter: 1,
      atoms: ['tainted'], sourceDefinitions: expect.any(Array) }]);
  });

  it('fails closed on **kwargs model calls', () => {
    const result = analyze("from os import getenv\nfrom subprocess import run\ndef f():\n run(**{'args': getenv('COMMAND')})\n", 'python', catalog());
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    const modeled = flow.calls.find(call => call.model?.reference?.model === 'subprocess.run.taint-sink');
    expect(modeled?.model?.status).toBe('argument-mapping');
    expect(flow.taintFindings).toEqual([]);
  });

  it('models Python command execution sink variants with exact external identity', () => {
    for (const [module, symbol] of [['subprocess', 'Popen'], ['os', 'system'], ['os', 'popen']] as const) {
      const result = analyze(`from os import getenv\nfrom ${module} import ${symbol}\ndef f():\n ${symbol}(getenv('COMMAND'))\n`, 'python', catalog());
      const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
      expect(flow.calls.some(call => call.model?.reference?.model === `${module}.${symbol}.taint-sink` && call.model.status === 'applied')).toBe(true);
      expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining(module), parameter: 0,
        atoms: ['tainted'], sourceDefinitions: expect.arrayContaining([expect.stringContaining('"os","getenv"')]) }]);
    }
  });

  it('tracks a modeled Node child_process.exec sink without inferring shell semantics', () => {
    const custom = structuredClone(standardModelPack);
    custom.id = 'node-taint.contracts';
    custom.models = [{ ...custom.models[0], id: 'readInput', language: 'typescript', module: 'source-api', symbol: 'readInput', package: 'npm:source-api',
      versions: { min: '1.0.0', before: '2.0.0' }, parameters: [], returns: { type: 'string', dependsOn: [] },
      taint: { source: true, sinkParameters: [], propagatesParameters: [], sanitizesParameters: [] }, throws: { possible: false, dependsOn: [] } }];
    const models = catalog({ ...config, versions: { node: '22.19.0', 'npm:source-api': '1.0.0' } }, [standardModelPack, custom]);
    const result = analyze("import {readInput} from 'source-api';import {exec} from 'node:child_process';function f(){exec(readInput());}", 'typescript', models);
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'child_process.exec.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('child_process'), parameter: 0,
      atoms: ['tainted'], sourceDefinitions: expect.arrayContaining([expect.stringContaining('source-api')]) }]);
  });

  it('models Node child_process command sink variants with exact external identity', () => {
    for (const symbol of ['execFile', 'execSync', 'spawn', 'spawnSync']) {
      const custom = structuredClone(standardModelPack);
      custom.id = `node-${symbol}-source`;
      custom.models = [{ ...custom.models[0], id: 'readInput', language: 'typescript', module: 'source-api', symbol: 'readInput', package: 'npm:source-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: [], returns: { type: 'string', dependsOn: [] },
        taint: { source: true, sinkParameters: [], propagatesParameters: [], sanitizesParameters: [] }, throws: { possible: false, dependsOn: [] } }];
      const models = catalog({ ...config, versions: { node: '22.19.0', 'npm:source-api': '1.0.0' } }, [standardModelPack, custom]);
      const result = analyze(`import {readInput} from 'source-api';import {${symbol}} from 'node:child_process';function f(){${symbol}(readInput());}`, 'typescript', models);
      const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
      expect(flow.calls.some(call => call.model?.reference?.model === `child_process.${symbol}.taint-sink` && call.model.status === 'applied')).toBe(true);
      expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('child_process'), parameter: 0,
        atoms: ['tainted'], sourceDefinitions: expect.arrayContaining([expect.stringContaining('source-api')]) }]);
    }
  });

  it('models Node vm dynamic-code sink variants with exact external identity', () => {
    for (const symbol of ['runInThisContext', 'runInNewContext', 'runInContext', 'compileFunction']) {
      const result = analyze(`import {${symbol}} from 'node:vm';function f(){${symbol}(process.env.CODE);}`, 'typescript', catalog());
      const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
      expect(flow.calls.some(call => call.model?.reference?.model === `vm.${symbol}.taint-sink` && call.model.status === 'applied')).toBe(true);
      expect(flow.taintFindings).toEqual([{ node: expect.any(Number), target: expect.stringContaining('node:vm'), parameter: 0,
        atoms: ['tainted:node-process-env'], sourceDefinitions: ['external:node:process.env'] }]);
    }
  });

  it('preserves environment taint through Python os.path.join variadic arguments', () => {
    const result = analyze("from os.path import join\nfrom subprocess import run\nimport os\ndef f():\n run([join('/bin', os.getenv('COMMAND'))])\n", 'python', catalog());
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'os.path.join.variadic-taint' && call.model.status === 'applied')).toBe(true);
    expect(flow.calls.some(call => call.model?.reference?.model === 'subprocess.run.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings.some(finding => finding.parameter === 0 && finding.atoms.includes('tainted'))).toBe(true);
  });

  it('preserves variadic path taint through a TypeScript wrapper summary', () => {
    const result = analyze("import {join} from 'node:path'; function wrap(base, suffix){return join(base, suffix);} function f(){eval(wrap('safe', process.env.CODE));}", 'typescript', catalog());
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'global.eval.taint-sink' && call.model.status === 'applied')).toBe(true);
    expect(flow.taintFindings.some(finding => finding.parameter === 0 && finding.atoms.includes('tainted:node-process-env'))).toBe(true);
  });

  it('models Node fs.readFileSync as an opaque taint source without guessing Buffer or encoding semantics', () => {
    const result = analyze("import {readFileSync} from 'node:fs';function f(){return readFileSync('config.json','utf8');}", 'typescript', catalog());
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.some(call => call.model?.reference?.model === 'fs.readFileSync.taint-source' && call.model.status === 'applied')).toBe(true);
    expect(flow.returns[0].value.atoms).toContain('tainted');
  });

  it('preserves modeled source taint on a direct return value', () => {
    const result = analyze("import {readFileSync} from 'node:fs';function f(){return readFileSync('config.json','utf8');}");
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.returns[0].value.atoms).toContain('tainted');
  });

  it('promotes modeled sink contracts into wrapper summaries', () => {
    const result = analyze("function run(value){eval(value);}function f(input){run(input);}");
    expect(result.summaries.find(summary => summary.owner.endsWith('::run'))?.taintSinkParameters).toEqual([0]);
  });

  it('preserves an imported modeled callable across repeated effectful calls', () => {
    const result = analyze("import {readFileSync} from 'node:fs';function f(){const first=readFileSync('a','utf8');const second=readFileSync('b','utf8');return second;}", 'typescript', catalog());
    const flow = result.flows.find(item => item.owner.endsWith('::f'))!;
    expect(flow.calls.filter(call => call.model?.reference?.model === 'fs.readFileSync.taint-source' && call.model.status === 'applied')).toHaveLength(2);
  });

  it('validates and preserves explicit resource lifecycle contracts', () => {
    const custom = structuredClone(standardModelPack);
    custom.id = 'resource.contracts';
    custom.models = [{ ...custom.models[0], id: 'acquire', module: 'resource-api', symbol: 'acquire', package: 'npm:resource-api',
      versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['string'],
      resource: { action: 'acquire', identity: 'return' } },
      { ...custom.models[0], id: 'release', module: 'resource-api', symbol: 'release', package: 'npm:resource-api',
        versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['any'], returns: { type: 'unit', dependsOn: [] },
        resource: { action: 'release', identity: 'argument', parameter: 0 } }];
    const models = catalog({ ...config, versions: { 'npm:resource-api': '1.0.0' } }, [custom]);
    const selected = models.select({ language: 'typescript', module: 'resource-api', symbol: 'acquire' });
    expect(selected.status).toBe('candidate');
    const summary = modelSummary(selected.contract!.symbol, selected.contract!);
    expect(summary.resource).toEqual({ action: 'acquire', identity: 'return' });
    const flow = analyze("import {acquire} from 'resource-api';function f(){return acquire('tmp');}", 'typescript', models);
    expect(flow.flows.flatMap(item => item.resourceEvents)).toEqual([
      expect.objectContaining({ action: 'acquire', identity: 'return', proven: true }),
    ]);
    const released = analyze("import {acquire, release} from 'resource-api';function f(){const h=acquire('tmp');release(h);return h.read();}", 'typescript', models);
    const releasedFindings = released.flows.flatMap(item => item.resourceFindings);
    expect(releasedFindings.some(finding => finding.kind === 'use-after-release' && finding.certainty === 'definite'
      && (finding.sourceNodes?.length ?? 0) > 0)).toBe(true);
    expect(releasedFindings.some(finding => finding.kind === 'leak' && finding.certainty === 'possible'
      && (finding.sourceNodes?.length ?? 0) > 0)).toBe(true);
    const wrapped = analyze("import {acquire, release} from 'resource-api';function wrap(){return acquire('tmp');}function f(){const h=wrap();release(h);return h.read();}", 'typescript', models);
    const caller = wrapped.flows.find(item => item.owner.endsWith('::f'))!;
    expect(caller.resourceEvents.some(event => event.action === 'acquire')).toBe(true);
    expect(caller.resourceEvents.some(event => event.action === 'release' && event.proven)).toBe(true);
    expect(caller.resourceFindings.some(finding => finding.kind === 'use-after-release')).toBe(true);
    const closeWrapper = analyze("import {acquire, release} from 'resource-api';function close(h){release(h);}function f(){const h=acquire('tmp');close(h);return h.read();}", 'typescript', models);
    const closeCaller = closeWrapper.flows.find(item => item.owner.endsWith('::f'))!;
    expect(closeWrapper.summaries.find(summary => summary.owner.endsWith('::close'))?.releasesResource).toEqual({ parameter: 0 });
    expect(closeCaller.resourceEvents.some(event => event.action === 'release' && event.proven)).toBe(true);
    expect(closeCaller.resourceFindings.some(finding => finding.kind === 'use-after-release')).toBe(true);
    const borrowed = analyze("import {acquire, release} from 'resource-api';function borrow(h){return h;}function f(){const h=acquire('tmp');const alias=borrow(h);release(alias);return h.read();}", 'typescript', models);
    expect(borrowed.summaries.find(summary => summary.owner.endsWith('::borrow'))?.returnsResource).toMatchObject({ source: 'parameter', parameter: 0 });
    const borrowedCaller = borrowed.flows.find(item => item.owner.endsWith('::f'))!;
    expect(borrowedCaller.resourceEvents.some(event => event.action === 'release' && event.proven)).toBe(true);
    expect(borrowedCaller.resourceFindings.some(finding => finding.kind === 'use-after-release')).toBe(true);
    const plainBorrow = analyze("function borrow(h){return h;}function f(){return borrow(1);}", 'typescript', models);
    expect(plainBorrow.flows.flatMap(item => item.resourceEvents)).toEqual([]);
    const rustOwnership = structuredClone(standardModelPack);
    rustOwnership.id = 'rust-ownership';
    rustOwnership.models = [{ ...rustOwnership.models[0], id: 'consume', language: 'rust', module: 'ownership_api', symbol: 'consume', package: 'rust-api',
      versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['any'], returns: { type: 'unit', dependsOn: [] },
      throws: { possible: false, dependsOn: [] }, ownership: { moves: [0], borrows: [] } }];
    const rustModels = catalog({ ...config, versions: { 'rust-api': '1.0.0' } }, [rustOwnership]);
    const borrowedContract = { ...rustOwnership.models[0], id: 'borrow', symbol: 'borrow', ownership: { moves: [], borrows: [0] } };
    rustOwnership.models = [...rustOwnership.models, borrowedContract];
    const rustModelsWithBorrow = catalog({ ...config, versions: { 'rust-api': '1.0.0' } }, [rustOwnership]);
    expect(modelSummary('external:rust-api.borrow', borrowedContract).borrowsParameters).toEqual([0]);
    const borrowedRust = analyze('use ownership_api::borrow;\nfn borrow_wrap(value: Vec<i32>){ borrow(value); }', 'rust', rustModelsWithBorrow);
    expect(borrowedRust.summaries.find(summary => summary.owner.endsWith('::borrow_wrap'))?.borrowsParameters).toEqual([0]);
    const consumed = analyze('use ownership_api::consume;\nfn f(){\n let x=Value{value:1};\n consume(x);\n x;\n}', 'rust', rustModels);
    expect(consumed.summaries.find(summary => summary.owner.endsWith('::f'))?.completeness).toBe('complete');
    expect(consumed.flows.find(item => item.owner.endsWith('::f'))?.ownershipFindings).toEqual([
      expect.objectContaining({ kind: 'use-after-move', certainty: 'possible' }),
    ]);
    const wrappedConsumed = analyze('use ownership_api::consume;\nfn consume_wrap(value: Vec<i32>){ consume(value); }\nfn f(){\n let x=Value{value:1};\n consume_wrap(x);\n x;\n}', 'rust', rustModels);
    expect(wrappedConsumed.summaries.find(summary => summary.owner.endsWith('::consume_wrap'))?.movesParameters).toEqual([0]);
    expect(wrappedConsumed.flows.find(item => item.owner.endsWith('::f'))?.ownershipFindings).toEqual([
      expect.objectContaining({ kind: 'use-after-move', certainty: 'possible' }),
    ]);
    const alias = analyze('function alias(handle){return handle;}function f(){const original={value:1};const copied=alias(original);copied.value=2;return original.value;}');
    expect(alias.summaries.find(summary => summary.owner.endsWith('::alias'))?.returnsParameter).toBe(0);
    expect(alias.flows.find(item => item.owner.endsWith('::f'))?.returns[0].value.atoms).toEqual(['number:2']);
    const pythonPack = structuredClone(standardModelPack);
    pythonPack.id = 'python-resource';
    pythonPack.models = [{ ...pythonPack.models[0], id: 'acquire', language: 'python', module: 'api', symbol: 'acquire', package: 'python-api',
      versions: { min: '1.0.0', before: '2.0.0' }, parameters: ['string'], resource: { action: 'acquire', identity: 'return', enter: 'same' } }];
    const pythonModels = catalog({ ...config, versions: { 'python-api': '1.0.0' } }, [pythonPack]);
    const managed = analyze("from api import acquire\ndef f():\n with acquire('tmp') as handle:\n  return handle\n", 'python', pythonModels);
    const managedFlow = managed.flows.find(item => item.owner.endsWith('::f'))!;
    expect(managedFlow.resourceEvents.filter(event => event.action === 'acquire')).toHaveLength(1);
    expect(managedFlow.resourceEvents.some(event => event.action === 'release' && event.proven)).toBe(true);
    // An unknown __enter__ exception may occur before __exit__; that edge stays a definite leak candidate.
    expect(managedFlow.resourceFindings.some(finding => finding.kind === 'leak' && finding.certainty === 'definite')).toBe(true);
    const asyncManaged = analyze("from api import acquire\nasync def f():\n async with acquire('tmp') as handle:\n  return handle\n", 'python', pythonModels);
    const asyncManagedFlow = asyncManaged.flows.find(item => item.owner.endsWith('::f'))!;
    expect(asyncManagedFlow.completeness).toBe('complete');
    expect(asyncManagedFlow.resourceEvents.filter(event => event.action === 'acquire')).toHaveLength(1);
    expect(asyncManagedFlow.resourceEvents.some(event => event.action === 'release' && event.proven)).toBe(true);
    const exceptional = analyze("import {acquire} from 'resource-api';function f(){const h=acquire('tmp');throw error;}", 'typescript', models);
    expect(exceptional.flows.find(item => item.owner.endsWith('::f'))?.resourceFindings).toEqual([
      expect.objectContaining({ kind: 'leak', certainty: 'definite', sourceNodes: expect.arrayContaining([expect.any(Number)]) }),
    ]);
    const managedExceptional = analyze("from api import acquire\ndef f():\n with acquire('tmp') as handle:\n  raise error\n", 'python', pythonModels);
    const managedExceptionalFindings = managedExceptional.flows.find(item => item.owner.endsWith('::f'))?.resourceFindings ?? [];
    expect(managedExceptional.flows.find(item => item.owner.endsWith('::f'))?.resourceEvents.some(event => event.action === 'release' && event.proven)).toBe(true);
    expect(managedExceptionalFindings.some(finding => finding.kind === 'leak' && finding.certainty === 'definite')).toBe(true);
    const neverSuppressPack = structuredClone(pythonPack);
    neverSuppressPack.id = 'python-resource-never-suppress';
    neverSuppressPack.models[0].resource = { action: 'acquire', identity: 'return', enter: 'same', suppress: 'never' };
    const neverSuppress = analyze("from api import acquire\ndef f():\n with acquire('tmp') as handle:\n  raise error\n", 'python', catalog({ ...config, versions: { 'python-api': '1.0.0' } }, [neverSuppressPack]));
    const neverGraph = neverSuppress.graphs.find(graph => graph.owner.endsWith('::f'))!;
    const suppression = neverGraph.nodes.find(node => node.text.includes('suppresses exception'))!;
    const suppressedEdge = neverGraph.edges.find(edge => edge.from === suppression.id && edge.kind === 'true')!;
    expect(neverSuppress.flows.find(item => item.owner.endsWith('::f'))?.reachableNodes).not.toContain(suppressedEdge.to);
    const neverAsync = analyze("from api import acquire\nasync def f():\n async with acquire('tmp') as handle:\n  raise error\n", 'python', catalog({ ...config, versions: { 'python-api': '1.0.0' } }, [neverSuppressPack]));
    const neverAsyncGraph = neverAsync.graphs.find(graph => graph.owner.endsWith('::f'))!;
    const asyncSuppression = neverAsyncGraph.nodes.find(node => node.text === '__aexit__ suppresses exception')!;
    const asyncSuppressedEdge = neverAsyncGraph.edges.find(edge => edge.from === asyncSuppression.id && edge.kind === 'true')!;
    expect(neverAsync.flows.find(item => item.owner.endsWith('::f'))?.reachableNodes).not.toContain(asyncSuppressedEdge.to);
    const builtinSuppress = analyze("from contextlib import suppress\ndef f():\n with suppress(ValueError):\n  raise error\n", 'python', catalog());
    const builtinSuppressFlow = builtinSuppress.flows.find(item => item.owner.endsWith('::f'))!;
    expect(builtinSuppressFlow.calls.some(call => call.model?.reference?.model === 'contextlib.suppress.resource' && call.model.status === 'applied')).toBe(true);
    const builtinSuppressGraph = builtinSuppress.graphs.find(graph => graph.owner.endsWith('::f'))!;
    const builtinSuppression = builtinSuppressGraph.nodes.find(node => node.text === '__exit__ suppresses exception')!;
    const builtinSuppressedEdge = builtinSuppressGraph.edges.find(edge => edge.from === builtinSuppression.id && edge.kind === 'true')!;
    expect(builtinSuppressFlow.reachableNodes).toContain(builtinSuppressedEdge.to);
    expect(builtinSuppressFlow.throws.some(thrown => thrown.node === builtinSuppression.id)).toBe(true);
    for (const [raised, suppressed] of [['ValueError', false], ['TypeError', true]] as const) {
      const typed = analyze(`from contextlib import suppress\ndef f():\n with suppress(ValueError):\n  raise ${raised}\n after()`, 'python', catalog());
      const typedGraph = typed.graphs.find(graph => graph.owner.endsWith('::f'))!;
      const typedSuppression = typedGraph.nodes.find(node => node.text === '__exit__ suppresses exception')!;
      expect(typed.flows.find(item => item.owner.endsWith('::f'))?.throws.some(thrown => thrown.node === typedSuppression.id)).toBe(suppressed);
    }
    for (const [raised, suppressed] of [['ValueError', false], ['TypeError', true]] as const) {
      const typed = analyze(`from contextlib import suppress\nasync def f():\n async with suppress(ValueError):\n  raise ${raised}\n after()`, 'python', catalog());
      const typedGraph = typed.graphs.find(graph => graph.owner.endsWith('::f'))!;
      const typedSuppression = typedGraph.nodes.find(node => node.text === '__aexit__ suppresses exception')!;
      expect(typed.flows.find(item => item.owner.endsWith('::f'))?.throws.some(thrown => thrown.node === typedSuppression.id)).toBe(suppressed);
    }
    const possibleGraph = managedExceptional.graphs.find(graph => graph.owner.endsWith('::f'))!;
    const possibleSuppression = possibleGraph.nodes.find(node => node.text === '__exit__ suppresses exception')!;
    const possibleSuppressedEdge = possibleGraph.edges.find(edge => edge.from === possibleSuppression.id && edge.kind === 'true')!;
    expect(managedExceptional.flows.find(item => item.owner.endsWith('::f'))?.reachableNodes).toContain(possibleSuppressedEdge.to);
    const afterWith = analyze("from api import acquire\ndef f():\n with acquire('tmp') as handle:\n  pass\n return handle.read()\n", 'python', pythonModels);
    expect(afterWith.flows.find(item => item.owner.endsWith('::f'))?.resourceFindings.some(finding => finding.kind === 'use-after-release')).toBe(true);
    const invalid = structuredClone(custom);
    invalid.models[0].resource = { action: 'acquire', identity: 'argument' } as never;
    expect(modelPackSchema.safeParse(invalid).success).toBe(false);
    const invalidEnter = structuredClone(custom);
    invalidEnter.models[1].resource = { action: 'release', identity: 'argument', parameter: 0, enter: 'same' } as never;
    expect(modelPackSchema.safeParse(invalidEnter).success).toBe(false);
    const invalidSuppress = structuredClone(custom);
    invalidSuppress.models[1].resource = { action: 'release', identity: 'argument', parameter: 0, suppress: 'never' } as never;
    expect(modelPackSchema.safeParse(invalidSuppress).success).toBe(false);
    const invalidOptional = structuredClone(custom);
    invalidOptional.models[0].parameters = ['string', 'string'];
    invalidOptional.models[0].optionalParameters = [0];
    expect(modelPackSchema.safeParse(invalidOptional).success).toBe(false);
  });
});
