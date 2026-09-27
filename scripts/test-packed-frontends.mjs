import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv-draft-04';
import addFormats from 'ajv-formats';

const repo = fileURLToPath(new URL('../', import.meta.url));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validateSarif = ajv.compile(JSON.parse(readFileSync(join(repo, 'tests', 'schemas', 'sarif-schema-2.1.0.json'), 'utf8')));
const scratch = mkdtempSync(join(tmpdir(), 'cxt-packed-frontends-'));
console.log(`Package smoke artifacts: ${scratch}`);
function npm(args) {
  return execFileSync('npm', args, { cwd: repo, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
const pack = JSON.parse(npm(['pack', '--ignore-scripts', '--pack-destination', scratch, '--json']))[0];
const tarball = join(scratch, pack.filename);
const source = join(scratch, 'source');
mkdirSync(source);
writeFileSync(join(source, 'sample.ts'), 'export function read() {}');
writeFileSync(join(source, 'sample.py'), 'def read(): pass');
writeFileSync(join(source, 'sample.rs'), 'pub fn read() {}');
writeFileSync(join(source, 'caller.ts'), "import { read as alias } from './sample.js';\nexport function caller() { alias(); missing(); }\ncaller();");
writeFileSync(join(source, 'control.ts'), 'export function branch(x) { if(x) return 1; return 2; }\nexport function* partial() { yield task(); }\nexport async function awaited() { await task(); }\nexport function identity(input){return input;}\nexport function through(input){return identity(input);}\nexport function ignored(input){identity(input);return 0;}');
writeFileSync(join(source, '.cxt-models.json'), JSON.stringify({ schemaVersion: 1, versions: { node: '22.19.0' }, assumptions: ['unmodified-external-bindings'] }));
writeFileSync(join(source, 'library.ts'), "import {basename} from 'node:path';export function modeled(){return basename('x');}export function rejected(input){return basename(input);}");
const rulesSource = join(scratch, 'rules');
mkdirSync(rulesSource);
mkdirSync(join(rulesSource, 'commands'));
writeFileSync(join(rulesSource, 'sample.ts'), 'debugger;\nconst text = "debugger; eval(x)";');
writeFileSync(join(rulesSource, 'read.py'), 'def read():\n print(x)\n x=1\ndef partial():\n yield 1');
writeFileSync(join(rulesSource, 'commands', 'report.ts'), 'console.log("complete");');
writeFileSync(join(rulesSource, '.cxt-rules.json'), JSON.stringify({ schemaVersion: 1, roles: [{ prefix: 'commands', role: 'tooling' }] }));

for (const mode of ['full', 'missing']) {
  const prefix = join(scratch, 'full');
  if (mode === 'full') npm(['install', '--global', '--prefix', prefix, tarball]);
  const installed = join(prefix, 'lib', 'node_modules', '@intrect', 'cxt');
  if (mode === 'missing') {
    // npm 11 may retain optional peers even with --omit=optional. Make native
    // unavailability real and inspectable by relocating only this temp install.
    const unavailable = join(scratch, 'unavailable-native-packages');
    mkdirSync(unavailable);
    for (const name of ['tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript', 'tree-sitter-python', 'tree-sitter-rust']) {
      renameSync(join(installed, 'node_modules', name), join(unavailable, name));
    }
  }
  const probe = join(scratch, `${mode}.mjs`);
  writeFileSync(probe, `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    const api = await import(pathToFileURL(${JSON.stringify(join(installed, 'dist', 'index.js'))}));
    for (const [path, language, source] of [
      ['x.ts','typescript','type Hidden = string;'],
      ['x.tsx','typescript','export const View = () => <div/>;'],
      ['x.js','typescript','export const run = () => 1;'],
      ['x.jsx','typescript','export const View = () => <div/>;'],
      ['x.py','python','def run(): pass'],
      ['x.rs','rust','pub fn run() {}'],
    ]) {
      const result = api.extractFile(source, path, language, 'auto');
      assert.equal(result.engine, ${JSON.stringify(mode === 'full' ? 'ast' : 'lexical')});
      if (${JSON.stringify(mode)} === 'full') {
        assert.equal(result.entities.length, 1);
        assert.deepEqual(result.diagnostics, []);
      } else {
        assert.equal(result.diagnostics[0].code, 'parser-unavailable');
        assert.throws(() => api.extractFile(source, path, language, 'ast'), /parser-unavailable/);
      }
    }
    api.getRegistryStore(${JSON.stringify(join(scratch, `${mode}.db`))});
    process.argv = [process.execPath, ${JSON.stringify(join(installed, 'dist', 'cli.js'))}, '--lang', 'en', 'scan'];
    await import(pathToFileURL(${JSON.stringify(join(installed, 'dist', 'cli.js'))}));
  `);
  const clean = spawnSync(process.execPath, [probe], { cwd: source, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CXT_PARSER: 'auto' } });
  assert.equal(clean.status, 2, clean.stderr + clean.stdout);
  assert.match(clean.stdout, mode === 'full' ? /ast: 6/ : /lexical: 6/);
  console.log(`${mode}: installed package; 6 grammar probes and real CLI scan passed`);
  const bs = spawnSync(process.execPath, [join(installed, 'dist', 'cli.js'), 'bs', '--json'], {
    cwd: rulesSource, encoding: 'utf8', timeout: 30_000, env: { ...process.env, CXT_PARSER: 'auto' },
  });
  assert.equal(bs.status, 2, bs.stderr + bs.stdout);
  const parsedBs = JSON.parse(bs.stdout);
  assert.equal(parsedBs.analysis.completeness, 'partial');
  const sarifBs = spawnSync(process.execPath, [join(installed, 'dist', 'cli.js'), 'bs', '--sarif', '-v'], {
    cwd: rulesSource, encoding: 'utf8', timeout: 30_000, env: { ...process.env, CXT_PARSER: 'auto' },
  });
  assert.equal(sarifBs.status, 2, sarifBs.stderr + sarifBs.stdout);
  const parsedSarifBs = JSON.parse(sarifBs.stdout);
  assert.ok(validateSarif(parsedSarifBs), JSON.stringify(validateSarif.errors));
  assert.deepEqual(parsedSarifBs.runs[0].results.map(result => result.partialFingerprints.primaryLocationLineHash), parsedBs.issues.map(issue => issue.fingerprint));
  const sarifScanProbe = join(scratch, `sarif-scan-${mode}.mjs`);
  writeFileSync(sarifScanProbe, readFileSync(probe, 'utf8').replace("'--lang', 'en', 'scan'", "'scan', '--sarif', '-v'"));
  const sarifScan = spawnSync(process.execPath, [sarifScanProbe], { cwd: source, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CXT_PARSER: 'auto' } });
  assert.equal(sarifScan.status, 2, sarifScan.stderr + sarifScan.stdout);
  assert.ok(validateSarif(JSON.parse(sarifScan.stdout)), JSON.stringify(validateSarif.errors));
  if (mode === 'full') {
    assert.equal(parsedBs.analysis.engines.ast, 3);
    assert.deepEqual(parsedBs.issues.map(issue => issue.ruleId).sort(), ['cxt/debugger-statement', 'cxt/uninitialized-read']);
    const read = parsedBs.issues.find(issue => issue.ruleId === 'cxt/uninitialized-read');
    assert.equal(read.line, 2);
    assert.ok(read.column > 0 && read.endColumn > read.column);
    assert.equal(read.flow.owner, 'read.py::read');
    assert.equal(read.precisionBasis, 'policy-estimate');
  } else {
    assert.equal(parsedBs.analysis.engines.lexical, 3);
    assert.ok(parsedBs.analysis.diagnostics.some(diagnostic => diagnostic.code === 'parser-unavailable'));
  }
  console.log(`${mode}: installed BS CLI reports rule evidence, role configuration and incomplete coverage`);
  if (mode === 'full') {
    const callProbe = join(scratch, 'calls.mjs');
    writeFileSync(callProbe, `
      import { pathToFileURL } from 'node:url';
      const api = await import(pathToFileURL(${JSON.stringify(join(installed, 'dist', 'index.js'))}));
      api.getRegistryStore(${JSON.stringify(join(scratch, 'full.db'))});
      process.argv = [process.execPath, ${JSON.stringify(join(installed, 'dist', 'cli.js'))}, 'calls', 'caller', '--json'];
      await import(pathToFileURL(${JSON.stringify(join(installed, 'dist', 'cli.js'))}));
    `);
    const calls = spawnSync(process.execPath, [callProbe], { cwd: source, encoding: 'utf8', timeout: 30_000 });
    assert.equal(calls.status, 0, calls.stderr + calls.stdout);
    const parsedCalls = JSON.parse(calls.stdout);
    assert.deepEqual(parsedCalls.callSites.map(site => [site.line, site.target ?? null, site.resolution]),
      [[2, 'sample.ts::read', 'resolved'], [2, null, 'unresolved']]);
    assert.equal(parsedCalls.callees[0].file, 'sample.ts');
    console.log('full: installed CLI resolves imports and exposes unresolved call-site locations');
    for (const [name, status, completeness] of [['branch', 0, 'complete'], ['partial', 2, 'partial'], ['awaited', 0, 'complete']]) {
      const cfgProbe = join(scratch, `cfg-${name}.mjs`);
      writeFileSync(cfgProbe, `
        import { pathToFileURL } from 'node:url';
        const api = await import(pathToFileURL(${JSON.stringify(join(installed, 'dist', 'index.js'))}));
        api.getRegistryStore(${JSON.stringify(join(scratch, 'full.db'))});
        process.argv = [process.execPath, ${JSON.stringify(join(installed, 'dist', 'cli.js'))}, 'cfg', ${JSON.stringify(name)}, '--json', '--strict'];
        await import(pathToFileURL(${JSON.stringify(join(installed, 'dist', 'cli.js'))}));
      `);
      const cfg = spawnSync(process.execPath, [cfgProbe], { cwd: source, encoding: 'utf8', timeout: 30_000 });
      assert.equal(cfg.status, status, cfg.stderr + cfg.stdout);
      assert.equal(JSON.parse(cfg.stdout).completeness, completeness);
      assert.ok(JSON.parse(cfg.stdout).blocks.length > 0);
      if (name === 'awaited') assert.ok(JSON.parse(cfg.stdout).edges.some(edge => edge.kind === 'resume'));
    }
    console.log('full: installed CFG CLI reports complete/partial with strict exit 0/2');
    for (const [name, status] of [['branch', 0], ['partial', 2], ['modeled', 0], ['rejected', 2]]) {
      const flowProbe = join(scratch, `flow-${name}.mjs`);
      writeFileSync(flowProbe, `
        import { pathToFileURL } from 'node:url';
        const api = await import(pathToFileURL(${JSON.stringify(join(installed, 'dist', 'index.js'))}));
        api.getRegistryStore(${JSON.stringify(join(scratch, 'full.db'))});
        process.argv = [process.execPath, ${JSON.stringify(join(installed, 'dist', 'cli.js'))}, 'flow', ${JSON.stringify(name)}, '--json', '--strict'];
        await import(pathToFileURL(${JSON.stringify(join(installed, 'dist', 'cli.js'))}));
      `);
      const flow = spawnSync(process.execPath, [flowProbe], { cwd: source, encoding: 'utf8', timeout: 30_000 });
      assert.equal(flow.status, status, flow.stderr + flow.stdout);
      const parsed = JSON.parse(flow.stdout);
      assert.equal(parsed.analysisCompleteness, status ? 'partial' : 'complete');
      assert.ok(Object.keys(parsed.locations).length > 0);
      if (name === 'branch') assert.deepEqual([...new Set(parsed.returns.flatMap(r => r.value.atoms))].sort(), ['number:1', 'number:2']);
      if (name === 'modeled') {
        assert.equal(parsed.calls[0].model.status, 'applied');
        assert.equal(parsed.summary.models[0].pack, 'cxt.stdlib');
        assert.equal(parsed.modelManifest.versions.node, '22.19.0');
      }
      if (name === 'rejected') assert.equal(parsed.calls[0].model.status, 'argument-domain');
    }
    console.log('full: installed dataflow CLI persists values, locations and partial strict exit 2');
    const impactProbe = join(scratch, 'parameter-impact.mjs');
    writeFileSync(impactProbe, `
      import { pathToFileURL } from 'node:url';
      const api = await import(pathToFileURL(${JSON.stringify(join(installed, 'dist', 'index.js'))}));
      api.getRegistryStore(${JSON.stringify(join(scratch, 'full.db'))});
      process.argv = [process.execPath, ${JSON.stringify(join(installed, 'dist', 'cli.js'))}, 'impact', 'identity', '--param', 'input', '--explain', '--json', '--strict'];
      await import(pathToFileURL(${JSON.stringify(join(installed, 'dist', 'cli.js'))}));
    `);
    const impact = spawnSync(process.execPath, [impactProbe], { cwd: source, encoding: 'utf8', timeout: 30_000 });
    // 같은 snapshot의 missing()/task()는 미해석 호출 coverage 경계로 남는다.
    assert.equal(impact.status, 2, impact.stderr + impact.stdout);
    const parameterImpact = JSON.parse(impact.stdout);
    assert.deepEqual(parameterImpact.impacted.map(item => item.owner), ['control.ts::through']);
    assert.equal(parameterImpact.impacted[0].path[0].evidence, 'return');
    assert.ok(parameterImpact.unresolvedCalls > 0);
    console.log('full: installed parameter impact explains used outputs and reports unresolved coverage with exit 2');
    writeFileSync(join(source, 'sample.ts'), 'export function broken(');
    const invalid = spawnSync(process.execPath, [probe], { cwd: source, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, CXT_PARSER: 'auto' } });
    assert.equal(invalid.status, 3, invalid.stderr + invalid.stdout);
    assert.match(invalid.stdout, /Scan Incomplete/);
    assert.match(invalid.stdout, /syntax-error/);
    writeFileSync(join(source, 'sample.ts'), 'export function read() {}');
    console.log('full: malformed source fails the CLI with exit 3');
  }
}
console.log('Packed frontend smoke passed; artifacts retained in the printed temporary directory.');
