import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleExport } from '../../src/cli/exportHandler.js';
import {
  getRegistryStore,
  closeRegistryStore,
} from '../../src/registry/sqliteStore.js';

let projectDir: string;
let dbDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  closeRegistryStore();
  projectDir = mkdtempSync(join(tmpdir(), 'cxt-export-proj-'));
  dbDir = mkdtempSync(join(tmpdir(), 'cxt-export-db-'));

  // Pre-init store with isolated tmp DB
  const store = getRegistryStore(join(dbDir, 'registry.db'));

  // Seed: 3 entities across 2 dirs/files
  store.registerEntity({
    projectId: 'tproj',
    kind: 'function',
    name: 'helper',
    filePath: 'src/util.ts',
    lineStart: 10,
    lineEnd: 20,
    signature: '(x: number)',
    riskLevel: 'low',
    hasTests: true,
    complexityScore: 2,
  });
  store.registerEntity({
    projectId: 'tproj',
    kind: 'class',
    name: 'Service',
    filePath: 'src/api/service.ts',
    lineStart: 5,
    lineEnd: 50,
    riskLevel: 'high',
    hasTests: false,
    complexityScore: 8,
  });
  const dep = store.registerEntity({
    projectId: 'tproj',
    kind: 'function',
    name: 'oldHandler',
    filePath: 'src/api/service.ts',
    lineStart: 60,
    lineEnd: 70,
    riskLevel: 'medium',
    hasTests: false,
  });
  store.deprecateEntity(dep.id, 'replaced by Service');

  // Mock cwd so resolveProjectId picks up our tmp project
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
});

afterEach(() => {
  cwdSpy.mockRestore();
  closeRegistryStore();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

describe('handleExport — stdout output', () => {
  it('emits SDL header + directory tree to stdout', async () => {
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });

    try {
      await handleExport({ project: 'tproj' });
    } finally {
      writeSpy.mockRestore();
    }

    const out = writes.join('');
    expect(out).toContain('# cxt snapshot');
    expect(out).toContain('# entities: 3/3');
    expect(out).toContain('directory "src/"');
    expect(out).toContain('directory "api/"');
    expect(out).toContain('class Service');
    expect(out).toContain('function helper');
    expect(out).toContain('risk:high');
    expect(out).toContain('tested:yes');
    expect(out).toContain('tested:no');
  });

  it('renders deprecated_reason inside entity block', async () => {
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    try {
      await handleExport({ project: 'tproj' });
    } finally {
      writeSpy.mockRestore();
    }
    const out = writes.join('');
    expect(out).toContain('deprecated_reason: "replaced by Service"');
  });

  it('aggregates dir-level entity counts', async () => {
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    try {
      await handleExport({ project: 'tproj' });
    } finally {
      writeSpy.mockRestore();
    }
    const out = writes.join('');
    // src/ holds all 3 entities
    expect(out).toMatch(/directory "src\/" \[entities:3/);
    // src/api/ holds 2
    expect(out).toMatch(/directory "api\/" \[entities:2/);
  });
});

describe('handleExport — file output', () => {
  it('writes snapshot to file when -o is provided', async () => {
    const outPath = join(dbDir, 'snapshot.gql');
    await handleExport({ project: 'tproj', output: outPath });

    const content = readFileSync(outPath, 'utf-8');
    expect(content).toContain('# cxt snapshot');
    expect(content).toContain('class Service');
  });
});

describe('handleExport — --dir filtering', () => {
  it('limits output to entities under given prefix', async () => {
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    try {
      await handleExport({ project: 'tproj', dir: 'src/api' });
    } finally {
      writeSpy.mockRestore();
    }
    const out = writes.join('');
    expect(out).toContain('Service');
    expect(out).toContain('oldHandler');
    expect(out).not.toContain('function helper'); // src/util.ts excluded
    expect(out).toContain('# entities: 2/2');
  });

  it('escapes terminal controls in an unmatched directory diagnostic', async () => {
    const messages: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((message) => { messages.push(String(message)); });
    const previousExitCode = process.exitCode;
    try {
      await handleExport({ project: 'tproj', dir: 'missing\u001b]8;;https://evil.invalid\u0007' });
    } finally {
      errSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
    expect(messages.join('\n')).not.toContain('\u001b');
    expect(messages.join('\n')).not.toContain('\u0007');
  });
});

describe('handleExport — empty registry', () => {
  it('emits error message and sets exit code when no entities match', async () => {
    closeRegistryStore();
    // Fresh empty DB
    const emptyDir = mkdtempSync(join(tmpdir(), 'cxt-empty-'));
    getRegistryStore(join(emptyDir, 'registry.db'));

    const errLines: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
      errLines.push(String(msg));
    });

    const prevExit = process.exitCode;
    try {
      await handleExport({ project: 'nonexistent' });
    } finally {
      errSpy.mockRestore();
      rmSync(emptyDir, { recursive: true, force: true });
    }

    expect(errLines.join('\n')).toContain('no entities found');
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
  });
});

describe('handleExport — broken exclusion (INT-1476)', () => {
  it('excludes broken (zombie) entities from the snapshot', async () => {
    const store = getRegistryStore();
    const zombie = store.registerEntity({
      projectId: 'tproj',
      kind: 'function',
      name: 'ghostFn',
      filePath: 'src/ghost.ts',
      lineStart: 1,
      lineEnd: 2,
    });
    store.changeEntityStatus(zombie.id, 'broken');

    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    try {
      await handleExport({ project: 'tproj' });
    } finally {
      writeSpy.mockRestore();
    }

    const out = writes.join('');
    expect(out).not.toContain('ghostFn');          // 좀비는 스냅샷에서 제외
    expect(out).toContain('function helper');      // 정상 엔티티는 유지
    expect(out).toContain('# entities: 3/3');      // 카운트도 broken 제외 기준
  });
});
