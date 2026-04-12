import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

export interface TmpDirHandle {
  root: string;
  write: (relPath: string, content: string) => string;
  cleanup: () => void;
}

export function createTmpDir(prefix = 'cxt-test-'): TmpDirHandle {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    write(relPath: string, content: string): string {
      const abs = join(root, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf-8');
      return abs;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
