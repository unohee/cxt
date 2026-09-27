import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpStore, type TmpDbHandle } from '../helpers/tmpDb.js';
import { SqliteRegistryStore } from '../../src/registry/sqliteStore.js';
import { extractFile } from '../../src/registry/entityScanner.js';
import { analyzeSummaries } from '../../src/analysis/summaries.js';
import { resolveSymbols } from '../../src/analysis/resolveSymbols.js';
import { loadLibraryModels, standardModelPack } from '../../src/analysis/libraryModels.js';

let h: TmpDbHandle;
beforeEach(() => { h = createTmpStore(); });
afterEach(() => { h.cleanup(); });

describe('model persistence and loading', () => {
  it('migrates v7 without inventing external identities or replacing facts/FTS', async () => {
    h.store.registerEntity({ projectId: 'p', kind: 'function', name: 'f', filePath: 'x.ts' });
    const file = extractFile("import {basename} from 'node:path';function f(){return basename('x');}", 'x.ts', 'typescript', 'ast');
    const sites = resolveSymbols([file.symbols!]).calls, analysis = analyzeSummaries(file.controlFlow!, sites);
    h.store.replaceCallSitesForProject('p', sites); h.store.replaceDataflowForProject('p', analysis.flows);
    h.store.replaceSummariesForProject('p', analysis.summaries); h.store.close();
    const path = join(h.dir, 'registry.db'), raw = new Database(path);
    raw.exec('ALTER TABLE code_call_sites DROP COLUMN external_json; DROP TABLE code_model_manifests'); raw.pragma('user_version = 7'); raw.close();
    const migrated = new SqliteRegistryStore(path);
    try {
      expect(migrated.getCallSites('p')[0].external).toBeUndefined();
      expect(migrated.getDataflow('p')).toEqual(analysis.flows);
      expect(migrated.getSummaries('p')).toEqual(analysis.summaries);
      expect(migrated.searchEntities('f', 20, 'p')).toHaveLength(1);
      expect(migrated.getModelManifest('p')).toBeNull();
      const manifest = (await loadLibraryModels(h.dir)).manifest;
      migrated.replaceCallSitesForProject('p', sites); migrated.setModelManifest('p', manifest);
      expect(migrated.getCallSites('p')[0].external).toEqual(sites[0].external);
      migrated.setModelManifest('other', manifest); migrated.deleteProject('p');
      expect(migrated.getModelManifest('p')).toBeNull();
      expect(migrated.getModelManifest('other')).toEqual(manifest);
      const check = new Database(path, { readonly: true });
      try { expect(check.pragma('user_version', { simple: true })).toBe(8); expect(check.pragma('foreign_key_check')).toEqual([]); }
      finally { check.close(); }
    } finally { migrated.close(); }
  });

  it('loads and hashes local JSON packs, rejects missing or malformed referenced packs', async () => {
    const pack = { ...standardModelPack, id: 'local.test', models: [standardModelPack.models[0]] };
    writeFileSync(join(h.dir, 'models.json'), JSON.stringify(pack));
    writeFileSync(join(h.dir, '.cxt-models.json'), JSON.stringify({ schemaVersion: 1, versions: {}, assumptions: [], packs: ['models.json'] }));
    const loaded = await loadLibraryModels(h.dir);
    expect(loaded.manifest.packs).toHaveLength(2);
    expect(loaded.manifest.configured).toBe(true);
    writeFileSync(join(h.dir, 'models.json'), JSON.stringify({ ...pack, version: '1.0.1' }));
    expect((await loadLibraryModels(h.dir)).manifest.packs[1].digest).not.toBe(loaded.manifest.packs[1].digest);
    writeFileSync(join(h.dir, 'models.json'), '{}');
    await expect(loadLibraryModels(h.dir)).rejects.toThrow();
    writeFileSync(join(h.dir, '.cxt-models.json'), JSON.stringify({ schemaVersion: 1, versions: {}, assumptions: [], packs: ['missing.json'] }));
    await expect(loadLibraryModels(h.dir)).rejects.toThrow('ENOENT');
  });
});
