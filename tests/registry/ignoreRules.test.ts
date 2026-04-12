import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildIgnoreConfig,
  shouldSkipDir,
  BUILTIN_SKIP_DIRS,
} from '../../src/registry/ignoreRules.js';
import { createTmpDir, type TmpDirHandle } from '../helpers/tmpDir.js';

let tmp: TmpDirHandle;

beforeEach(() => {
  tmp = createTmpDir('cxt-ignore-');
});
afterEach(() => {
  tmp.cleanup();
});

describe('shouldSkipDir — built-in', () => {
  const cfg = { skipDirs: BUILTIN_SKIP_DIRS, skipPrefixes: [], skipPathPatterns: [] };

  it('skips node_modules', () => {
    expect(shouldSkipDir('node_modules', '', cfg)).toBe(true);
  });

  it('skips .git, dist, build, target, vendor', () => {
    expect(shouldSkipDir('.git', '', cfg)).toBe(true);
    expect(shouldSkipDir('dist', '', cfg)).toBe(true);
    expect(shouldSkipDir('build', '', cfg)).toBe(true);
    expect(shouldSkipDir('target', '', cfg)).toBe(true);
    expect(shouldSkipDir('vendor', '', cfg)).toBe(true);
  });

  it('skips all hidden directories starting with .', () => {
    expect(shouldSkipDir('.cache', '', cfg)).toBe(true);
    expect(shouldSkipDir('.foo', '', cfg)).toBe(true);
  });

  it('does not skip normal dirs', () => {
    expect(shouldSkipDir('src', '', cfg)).toBe(false);
    expect(shouldSkipDir('lib', '', cfg)).toBe(false);
  });
});

describe('shouldSkipDir — prefix matching', () => {
  it('skips dirs matching prefix patterns', () => {
    const cfg = {
      skipDirs: new Set<string>(),
      skipPrefixes: ['build-'],
      skipPathPatterns: [],
    };
    expect(shouldSkipDir('build-prod', '', cfg)).toBe(true);
    expect(shouldSkipDir('build-debug', '', cfg)).toBe(true);
    expect(shouldSkipDir('production', '', cfg)).toBe(false);
  });
});

describe('shouldSkipDir — path patterns', () => {
  it('skips dirs matching glob path patterns', () => {
    const cfg = {
      skipDirs: new Set<string>(),
      skipPrefixes: [],
      skipPathPatterns: [/^subprojects\/legacy/],
    };
    expect(shouldSkipDir('legacy', 'subprojects', cfg)).toBe(true);
    expect(shouldSkipDir('legacy', 'src', cfg)).toBe(false);
  });
});

describe('buildIgnoreConfig — .cxtignore parsing', () => {
  it('reads directory entries from .cxtignore', () => {
    tmp.write('.cxtignore', 'docker/\nlegacy/\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(cfg.skipDirs.has('docker')).toBe(true);
    expect(cfg.skipDirs.has('legacy')).toBe(true);
  });

  it('reads prefix patterns from .cxtignore', () => {
    tmp.write('.cxtignore', 'build-*/\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(cfg.skipPrefixes).toContain('build-');
  });

  it('reads glob path patterns from .cxtignore', () => {
    tmp.write('.cxtignore', 'subprojects/pykis/**\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(cfg.skipPathPatterns.length).toBeGreaterThan(0);
    const matched = cfg.skipPathPatterns.some((p) => p.test('subprojects/pykis/foo'));
    expect(matched).toBe(true);
  });

  it('skips comment lines and blank lines', () => {
    tmp.write('.cxtignore', '# comment\n\nlegacy/\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(cfg.skipDirs.has('legacy')).toBe(true);
    expect(cfg.skipDirs.has('# comment')).toBe(false);
  });

  it('skips negation patterns (not supported)', () => {
    tmp.write('.cxtignore', '!important/\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(cfg.skipDirs.has('important')).toBe(false);
    expect(cfg.skipDirs.has('!important')).toBe(false);
  });

  it('treats no-extension entries as directory names', () => {
    tmp.write('.cxtignore', 'somedir\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(cfg.skipDirs.has('somedir')).toBe(true);
  });
});

describe('buildIgnoreConfig — .gitignore parsing', () => {
  it('reads directory entries from .gitignore', () => {
    tmp.write('.gitignore', 'coverage/\nartifacts/\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(cfg.skipDirs.has('coverage')).toBe(true); // already in builtin but harmless
    expect(cfg.skipDirs.has('artifacts')).toBe(true);
  });
});

describe('buildIgnoreConfig — vendored subproject auto-detection', () => {
  it('detects subproject with package.json + node_modules as vendored', () => {
    tmp.write('package.json', '{}'); // root manifest
    tmp.write('vendored-pkg/package.json', '{}');
    tmp.write('vendored-pkg/node_modules/.placeholder', '');

    const cfg = buildIgnoreConfig(tmp.root);
    expect(cfg.skipDirs.has('vendored-pkg')).toBe(true);
  });

  it('does not skip subdirs without their own manifest', () => {
    tmp.write('package.json', '{}');
    tmp.write('src/index.ts', 'export {};');

    const cfg = buildIgnoreConfig(tmp.root);
    expect(cfg.skipDirs.has('src')).toBe(false);
  });

  it('does not skip subproject manifest without vendored deps', () => {
    tmp.write('package.json', '{}');
    tmp.write('subpkg/package.json', '{}');
    // no node_modules → not vendored
    const cfg = buildIgnoreConfig(tmp.root);
    expect(cfg.skipDirs.has('subpkg')).toBe(false);
  });

  it('detects Python subproject (.venv)', () => {
    tmp.write('package.json', '{}');
    tmp.write('pyproj/pyproject.toml', '');
    tmp.write('pyproj/.venv/.placeholder', '');

    const cfg = buildIgnoreConfig(tmp.root);
    expect(cfg.skipDirs.has('pyproj')).toBe(true);
  });
});
