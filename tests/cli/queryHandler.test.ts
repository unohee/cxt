import { describe, expect, it } from 'vitest';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifySnapshotFreshness } from '../../src/cli/queryHandler.js';
import { engineFingerprint, hashText } from '../../src/analysis/cache.js';

describe('query snapshot freshness', () => {
  it('reports current when indexed files are not newer than the snapshot', () => {
    const root = join(tmpdir(), `cxt-freshness-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'const a = 1;');
    expect(verifySnapshotFreshness(root, { updatedAt: new Date(Date.now() + 5000).toISOString(), filePaths: ['a.ts'] })).toBe('current');
  });

  it('reports stale when an indexed file is newer or missing', () => {
    const root = join(tmpdir(), `cxt-freshness-${Date.now()}-stale`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'const a = 1;');
    utimesSync(join(root, 'a.ts'), new Date(), new Date());
    expect(verifySnapshotFreshness(root, { updatedAt: new Date(Date.now() - 5000).toISOString(), filePaths: ['a.ts'] })).toBe('stale');
    expect(verifySnapshotFreshness(root, { updatedAt: new Date().toISOString(), filePaths: ['missing.ts'] })).toBe('stale');
  });

  it('reports stale when a new source file is outside the indexed snapshot', () => {
    const root = join(tmpdir(), `cxt-freshness-${Date.now()}-new`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'const a = 1;');
    writeFileSync(join(root, 'new.ts'), 'const newer = 1;');
    expect(verifySnapshotFreshness(root, { updatedAt: new Date(Date.now() + 5000).toISOString(), filePaths: ['a.ts'] })).toBe('stale');
  });

  it('ignores cxt metadata files when checking source freshness', () => {
    const root = join(tmpdir(), `cxt-freshness-${Date.now()}-metadata`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'const a = 1;');
    writeFileSync(join(root, '.cxt-models.json'), '{}');
    expect(verifySnapshotFreshness(root, { updatedAt: new Date(Date.now() + 5000).toISOString(), filePaths: ['a.ts'] })).toBe('current');
  });

  it('fails closed when snapshot metadata is unavailable', () => {
    expect(verifySnapshotFreshness('/tmp', { filePaths: ['a.ts'] })).toBe('not-verified');
  });

  it('uses the persisted frontend input hash when metadata is available', () => {
    const root = join(tmpdir(), `cxt-freshness-${Date.now()}-hash`);
    mkdirSync(root, { recursive: true });
    const file = join(root, 'a.ts');
    writeFileSync(file, 'const a = 1;');
    const inputHash = hashText(JSON.stringify([engineFingerprint(), 'auto', 'typescript', 'const a = 1;']));
    const inputs = { updatedAt: new Date(Date.now() + 5000).toISOString(), filePaths: ['a.ts'], cachedFiles: [{ filePath: 'a.ts', inputHash }] };
    expect(verifySnapshotFreshness(root, inputs)).toBe('current');
    writeFileSync(file, 'const a = 2;');
    expect(verifySnapshotFreshness(root, inputs)).toBe('stale');
  });

  it('accepts a hash persisted by an explicit parser mode', () => {
    const root = join(tmpdir(), `cxt-freshness-${Date.now()}-ast`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'const a = 1;');
    const inputHash = hashText(JSON.stringify([engineFingerprint(), 'ast', 'typescript', 'const a = 1;']));
    expect(verifySnapshotFreshness(root, {
      updatedAt: new Date(Date.now() + 5000).toISOString(), filePaths: ['a.ts'],
      cachedFiles: [{ filePath: 'a.ts', inputHash }],
    })).toBe('current');
  });

  it('fails closed when any indexed source lacks a persisted hash', () => {
    const root = join(tmpdir(), `cxt-freshness-${Date.now()}-partial-hash`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'const a = 1;');
    writeFileSync(join(root, 'b.ts'), 'const b = 1;');
    const inputHash = hashText(JSON.stringify([engineFingerprint(), 'auto', 'typescript', 'const a = 1;']));
    expect(verifySnapshotFreshness(root, {
      updatedAt: new Date(Date.now() + 5000).toISOString(), filePaths: ['a.ts', 'b.ts'],
      cachedFiles: [{ filePath: 'a.ts', inputHash }],
    })).toBe('not-verified');
  });
});
