import { cpSync, mkdirSync } from 'node:fs';

const target = new URL('../dist/frontend/queries/', import.meta.url);
mkdirSync(target, { recursive: true });
cpSync(new URL('../src/frontend/queries/', import.meta.url), target, { recursive: true });
