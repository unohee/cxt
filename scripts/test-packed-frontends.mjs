import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
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
  assert.equal(clean.status, 0, clean.stderr + clean.stdout);
  assert.match(clean.stdout, mode === 'full' ? /ast: 3/ : /lexical: 3/);
  console.log(`${mode}: installed package; 6 grammar probes and real CLI scan passed`);
  if (mode === 'full') {
    writeFileSync(join(source, 'sample.ts'), 'export function broken(');
    const invalid = spawnSync(process.execPath, [probe], { cwd: source, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, CXT_PARSER: 'auto' } });
    assert.equal(invalid.status, 1, invalid.stderr + invalid.stdout);
    assert.match(invalid.stdout, /Scan Incomplete/);
    assert.match(invalid.stdout, /syntax-error/);
    writeFileSync(join(source, 'sample.ts'), 'export function read() {}');
    console.log('full: malformed source fails the CLI with exit 1');
  }
}
console.log('Packed frontend smoke passed; artifacts retained in the printed temporary directory.');
