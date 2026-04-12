import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { handleInit } from '../../src/cli/initHandler.js';
import { createTmpDir, type TmpDirHandle } from '../helpers/tmpDir.js';

let tmp: TmpDirHandle;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = createTmpDir('cxt-init-');
  // Silence console output during tests
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  tmp.cleanup();
});

describe('handleInit — append to new file', () => {
  it('creates target file with cxt section', async () => {
    const target = join(tmp.root, 'AGENTS.md');
    await handleInit({ path: target });

    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('<!-- cxt:start -->');
    expect(content).toContain('<!-- cxt:end -->');
    expect(content).toContain('## cxt');
    expect(content).toContain('cxt scan');
    expect(content).toContain('cxt export');
  });

  it('creates parent directory if missing', async () => {
    const target = join(tmp.root, 'nested', 'sub', 'GUIDE.md');
    await handleInit({ path: target });
    expect(existsSync(target)).toBe(true);
  });
});

describe('handleInit — idempotency', () => {
  it('is idempotent — second run reports unchanged', async () => {
    const target = join(tmp.root, 'AGENTS.md');
    await handleInit({ path: target });
    const first = readFileSync(target, 'utf-8');

    await handleInit({ path: target });
    const second = readFileSync(target, 'utf-8');
    expect(second).toBe(first);
  });

  it('preserves existing user content outside markers', async () => {
    const target = join(tmp.root, 'AGENTS.md');
    tmp.write('AGENTS.md', '# My Notes\n\nSome custom guidance.\n');

    await handleInit({ path: target });

    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('# My Notes');
    expect(content).toContain('Some custom guidance.');
    expect(content).toContain('<!-- cxt:start -->');
  });
});

describe('handleInit — update existing section', () => {
  it('updates section in place when content differs', async () => {
    const target = join(tmp.root, 'AGENTS.md');
    // Plant an old section with different content
    tmp.write(
      'AGENTS.md',
      '# Header\n\n<!-- cxt:start -->\n## cxt (old version)\nOLD CONTENT\n<!-- cxt:end -->\n\n# Footer\n',
    );

    await handleInit({ path: target });

    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('# Header');
    expect(content).toContain('# Footer');
    expect(content).not.toContain('OLD CONTENT');
    expect(content).toContain('cxt scan');
  });
});

describe('handleInit — remove', () => {
  it('removes section when --remove is set', async () => {
    const target = join(tmp.root, 'AGENTS.md');
    tmp.write('AGENTS.md', '# Header\n\nMy content here.\n');

    await handleInit({ path: target });
    expect(readFileSync(target, 'utf-8')).toContain('<!-- cxt:start -->');

    await handleInit({ path: target, remove: true });
    const after = readFileSync(target, 'utf-8');
    expect(after).not.toContain('<!-- cxt:start -->');
    expect(after).not.toContain('<!-- cxt:end -->');
    expect(after).toContain('# Header');
    expect(after).toContain('My content here.');
  });

  it('handles --remove on file without section gracefully', async () => {
    const target = join(tmp.root, 'AGENTS.md');
    tmp.write('AGENTS.md', '# Just a doc\n');
    await handleInit({ path: target, remove: true });
    // Should not throw, file should remain unchanged
    expect(readFileSync(target, 'utf-8')).toContain('# Just a doc');
  });

  it('handles --remove on missing file gracefully', async () => {
    const target = join(tmp.root, 'never-existed.md');
    await expect(handleInit({ path: target, remove: true })).resolves.toBeUndefined();
    expect(existsSync(target)).toBe(false);
  });
});

describe('handleInit — dry-run', () => {
  it('does not write to file in dry mode', async () => {
    const target = join(tmp.root, 'AGENTS.md');
    await handleInit({ path: target, dry: true });
    expect(existsSync(target)).toBe(false);
  });

  it('does not modify file in dry --remove mode', async () => {
    const target = join(tmp.root, 'AGENTS.md');
    await handleInit({ path: target });
    const before = readFileSync(target, 'utf-8');
    await handleInit({ path: target, remove: true, dry: true });
    expect(readFileSync(target, 'utf-8')).toBe(before);
  });
});

describe('handleInit — target validation', () => {
  it('rejects unknown target and exits with code 1', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await expect(handleInit({ target: 'bogus' })).rejects.toThrow('exit:1');
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('accepts comma-separated valid targets in dry mode', async () => {
    // Use dry mode so we don't actually write to ~/.claude etc.
    await expect(handleInit({ target: 'claude,codex,gemini', dry: true })).resolves.toBeUndefined();
  });

  it('accepts "all" keyword in dry mode', async () => {
    await expect(handleInit({ target: 'all', dry: true })).resolves.toBeUndefined();
  });
});
