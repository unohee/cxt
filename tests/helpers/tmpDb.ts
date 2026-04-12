import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRegistryStore } from '../../src/registry/sqliteStore.js';

export interface TmpDbHandle {
  store: SqliteRegistryStore;
  dir: string;
  cleanup: () => void;
}

export function createTmpStore(): TmpDbHandle {
  const dir = mkdtempSync(join(tmpdir(), 'cxt-test-'));
  const dbPath = join(dir, 'registry.db');
  const store = new SqliteRegistryStore(dbPath);
  return {
    store,
    dir,
    cleanup: () => {
      try {
        store.close?.();
      } catch {
        // ignore — close may not exist
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
