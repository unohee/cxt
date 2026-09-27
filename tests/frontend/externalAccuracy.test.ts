import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { externalGate, loadExternalCorpus, scoreExternalFixture } from '../../bench/external-accuracy.js';
import { extractFile } from '../../src/registry/entityScanner.js';

describe('licensed external declaration corpus', () => {
  it('checks source, license and handwritten metadata for all three languages', () => {
    const fixtures = loadExternalCorpus();
    expect(fixtures.map(f => f.entities.length)).toEqual([18, 6, 8]);
    for (const fixture of fixtures) {
      const actual = extractFile(fixture.source, fixture.filePath, fixture.language, 'ast').entities;
      expect(externalGate(scoreExternalFixture(fixture, actual))).toBe(true);
    }
  });

  it('fails on incorrect metadata as well as missing, duplicate and misplaced declarations', () => {
    const fixture = loadExternalCorpus()[0];
    const actual = extractFile(fixture.source, fixture.filePath, fixture.language, 'ast').entities;
    const mutations = [[], [...actual, actual[0]], actual.slice(1), actual.map(e => ({ ...e, lineEnd: e.lineEnd! + 1 })),
      actual.map(e => ({ ...e, scopedName: 'wrong-scope' })), actual.map(e => ({ ...e, isExported: !e.isExported })),
      actual.map(e => ({ ...e, paramCount: e.paramCount + 1 }))];
    for (const mutation of mutations) expect(externalGate(scoreExternalFixture(fixture, mutation))).toBe(false);
  });

  it('rejects altered source, license or labels before invoking the analyzer', () => {
    const root = mkdtempSync(join(tmpdir(), 'cxt-corpus-integrity-'));
    try {
      cpSync(new URL('../../bench/corpus/real-world/', import.meta.url), root, { recursive: true });
      const url = pathToFileURL(root + '/');
      for (const file of ['expected.json', 'zod-util.ts', 'ZOD-LICENSE.txt']) {
        const path = join(root, file), prior = readFileSync(path);
        writeFileSync(path, Buffer.concat([prior, Buffer.from('\n')]));
        expect(() => loadExternalCorpus(url)).toThrow(/integrity mismatch/);
        writeFileSync(path, prior);
      }
      expect(loadExternalCorpus(url)).toHaveLength(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
