import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildIgnoreConfig,
  shouldSkipDir,
  shouldSkipFile,
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

  it('honors ordered negation patterns', () => {
    tmp.write('.cxtignore', 'generated/\n!generated/important/\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(shouldSkipDir('generated', '', cfg)).toBe(false); // descendant 재포함을 위해 순회
    expect(shouldSkipDir('important', 'generated', cfg)).toBe(false);
    expect(shouldSkipDir('other', 'generated', cfg)).toBe(true);
    expect(shouldSkipFile('generated/other.ts', cfg)).toBe(true);
    expect(shouldSkipFile('generated/important/keep.ts', cfg)).toBe(false);
  });

  it('keeps ignored sibling files excluded while re-including one descendant', () => {
    tmp.write('.cxtignore', 'generated/\n!generated/keep.ts\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(shouldSkipDir('generated', '', cfg)).toBe(false);
    expect(shouldSkipFile('generated/other.ts', cfg)).toBe(true);
    expect(shouldSkipFile('generated/keep.ts', cfg)).toBe(false);
  });

  it('traverses ignored descendants that may match a wildcard negation', () => {
    tmp.write('.cxtignore', 'generated/\n!generated/**/*.ts\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(shouldSkipDir('generated', '', cfg)).toBe(false);
    expect(shouldSkipDir('foo', 'generated', cfg)).toBe(false);
    expect(shouldSkipFile('generated/foo/keep.ts', cfg)).toBe(false);
    expect(shouldSkipFile('generated/foo/drop.txt', cfg)).toBe(true);
  });

  it('does not apply directory-only rules to same-named files', () => {
    tmp.write('.cxtignore', 'generated.ts/\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(shouldSkipFile('generated.ts', cfg)).toBe(false);
    expect(shouldSkipFile('generated.ts/output.js', cfg)).toBe(true);
    expect(shouldSkipFile('nested/generated.ts/output.js', cfg)).toBe(true);
    expect(shouldSkipDir('generated.ts', '', cfg)).toBe(true);
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

describe('buildIgnoreConfig — vendored subprojects', () => {
  it('excludes a nested package with its own installed dependencies', () => {
    tmp.write('package.json', '{}'); // root manifest
    tmp.write('vendored-pkg/package.json', '{}');
    tmp.write('vendored-pkg/node_modules/.placeholder', '');

    const cfg = buildIgnoreConfig(tmp.root);
    expect(shouldSkipDir('vendored-pkg', '', cfg)).toBe(true);
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

  it('excludes a nested Python project with its own environment', () => {
    tmp.write('package.json', '{}');
    tmp.write('pyproj/pyproject.toml', '');
    tmp.write('pyproj/.venv/.placeholder', '');

    const cfg = buildIgnoreConfig(tmp.root);
    expect(shouldSkipDir('pyproj', '', cfg)).toBe(true);
  });

  it('honors anchored patterns and escaped glob characters', () => {
    tmp.write('.gitignore', '/root-output/\nfoo\\*bar/\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(shouldSkipDir('root-output', '', cfg)).toBe(true);
    expect(shouldSkipDir('root-output', 'nested', cfg)).toBe(false);
    expect(shouldSkipDir('foo*bar', '', cfg)).toBe(true);
    expect(shouldSkipDir('fooxbar', '', cfg)).toBe(false);
  });

  it('supports bracket expressions and escaped spaces', () => {
    tmp.write('.gitignore', '*.[ch]\n[Tt]mp/\nspace\\ dir/\n');
    const cfg = buildIgnoreConfig(tmp.root);
    expect(shouldSkipFile('src/native.c', cfg)).toBe(true);
    expect(shouldSkipFile('src/native.h', cfg)).toBe(true);
    expect(shouldSkipDir('Tmp', '', cfg)).toBe(true);
    expect(shouldSkipDir('tmp', '', cfg)).toBe(true);
    expect(shouldSkipDir('space dir', '', cfg)).toBe(true);
  });

  it('ignores malformed bracket expressions without aborting config loading', () => {
    tmp.write('.gitignore', '[z-a]\nvalid/\n');
    expect(() => buildIgnoreConfig(tmp.root)).not.toThrow();
    expect(shouldSkipDir('valid', '', buildIgnoreConfig(tmp.root))).toBe(true);
  });
});
