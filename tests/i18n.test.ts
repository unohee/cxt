import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { detectLocale, getLocale, setLocale, t } from '../src/i18n.js';

describe('i18n locale validation', () => {
  it('rejects unsupported runtime locales without corrupting current state', () => {
    setLocale('ko');
    expect(() => setLocale('fr')).toThrow('Unsupported locale: fr');
    expect(getLocale()).toBe('ko');
    expect(t()).toBeDefined();
    setLocale(detectLocale());
  });

  it('escapes terminal controls in public setLocale errors', () => {
    expect(() => setLocale('fr\u001b]8;;https://evil.invalid\u0007')).toThrow('Unsupported locale: fr]8;;https://evil.invalid�');
  });

  it('escapes Unicode bidi controls in public setLocale errors', () => {
    expect(() => setLocale('fr\u202eok')).toThrow('Unsupported locale: fr�ok');
  });

  it('rejects unsupported locale while rendering help', () => {
    const result = spawnSync(process.execPath, ['--import=tsx', 'src/cli.ts', '--lang', 'zz', '--help'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported language 'zz'");
  });

  it('rejects unsupported locale while rendering subcommand help', () => {
    const result = spawnSync(process.execPath, ['--import=tsx', 'src/cli.ts', '--lang', 'zz', 'check', '--help'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported language 'zz'");
  });

  it('rejects an empty locale value and ignores tokens after the option terminator', () => {
    const empty = spawnSync(process.execPath, ['--import=tsx', 'src/cli.ts', '--lang=', '--help'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain("unsupported language ''");

    const terminated = spawnSync(process.execPath, ['--import=tsx', 'src/cli.ts', 'check', '--', '--lang=zz'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(terminated.stderr).not.toContain('unsupported language');

    const consumedTerminator = spawnSync(process.execPath, ['--import=tsx', 'src/cli.ts', 'check', '--search', '--', '--lang=zz'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(consumedTerminator.stderr).not.toContain('unsupported language');
  });

  it('validates the effective final repeated locale option', () => {
    const result = spawnSync(process.execPath, ['--import=tsx', 'src/cli.ts', '--lang', 'en', '--lang', 'zz', 'check', '--help'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported language 'zz'");
  });

  it('rejects unsupported explicit locale during command execution', () => {
    const result = spawnSync(process.execPath, ['--import=tsx', 'src/cli.ts', '--lang', 'zz', 'check', '--stats'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported language 'zz'");
  });

  it('does not interpret another option value as a locale option', () => {
    const result = spawnSync(process.execPath, ['--import=tsx', 'src/cli.ts', 'check', '--search', '--lang=zz', '--help'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(result.stderr).not.toContain('unsupported language');

    const separate = spawnSync(process.execPath, ['--import=tsx', 'src/cli.ts', 'check', '--search', '--lang', 'ko', '--help'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANGUAGE: '', LANG: 'en_US.UTF-8' },
    });
    expect(separate.stdout).toContain('Check code registry');
    expect(separate.stdout).not.toContain('코드 레지스트리');

    const executed = spawnSync(process.execPath, ['--import=tsx', 'src/cli.ts', 'check', '--search', '--lang=ko'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANGUAGE: '', LANG: 'en_US.UTF-8' },
    });
    expect(executed.stdout).not.toContain('__cxt_option_value__');
  });

  it('removes terminal controls from unsupported locale diagnostics', () => {
    const result = spawnSync(process.execPath, ['--import=tsx', 'src/cli.ts', '--lang', '\u001b]8;;https://evil.invalid\u0007zz', '--help'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('\u001b');
    expect(result.stderr).not.toContain('\u0007');
  });

  it('selects the first supported locale from a LANGUAGE preference list', () => {
    const previous = { lcAll: process.env.LC_ALL, language: process.env.LANGUAGE, lang: process.env.LANG };
    delete process.env.LC_ALL;
    process.env.LANGUAGE = 'fr:ko:en';
    process.env.LANG = 'en_US.UTF-8';
    expect(detectLocale()).toBe('ko');
    if (previous.lcAll === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previous.lcAll;
    if (previous.language === undefined) delete process.env.LANGUAGE; else process.env.LANGUAGE = previous.language;
    if (previous.lang === undefined) delete process.env.LANG; else process.env.LANG = previous.lang;
  });

  it('does not confuse unsupported locale prefixes with Korean', () => {
    const previous = { lcAll: process.env.LC_ALL, language: process.env.LANGUAGE };
    process.env.LC_ALL = 'kok_IN.UTF-8';
    process.env.LANGUAGE = 'koala:ko';
    expect(detectLocale()).toBe('en');
    delete process.env.LC_ALL;
    expect(detectLocale()).toBe('ko');
    if (previous.lcAll === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previous.lcAll;
    if (previous.language === undefined) delete process.env.LANGUAGE; else process.env.LANGUAGE = previous.language;
  });

  it('recognizes POSIX encoding suffixes in locale environment variables', () => {
    const previous = { lcAll: process.env.LC_ALL, language: process.env.LANGUAGE, lang: process.env.LANG };
    process.env.LC_ALL = 'ko.UTF-8';
    expect(detectLocale()).toBe('ko');
    delete process.env.LC_ALL;
    process.env.LANGUAGE = 'fr:ko.UTF-8:en';
    expect(detectLocale()).toBe('ko');
    delete process.env.LANGUAGE;
    process.env.LANG = 'ko_KR.UTF-8';
    expect(detectLocale()).toBe('ko');
    if (previous.lcAll === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previous.lcAll;
    if (previous.language === undefined) delete process.env.LANGUAGE; else process.env.LANGUAGE = previous.language;
    if (previous.lang === undefined) delete process.env.LANG; else process.env.LANG = previous.lang;
  });
});
