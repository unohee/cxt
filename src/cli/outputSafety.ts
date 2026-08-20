import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

/** 저장소에서 읽은 문자열이 터미널 제어 시퀀스를 실행하지 못하게 한다. */
export function escapeTerminal(value: unknown): string {
  return String(value)
    .replace(/[\u001b\u009b]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '�');
}

/** path가 base 자체이거나 그 하위인지 플랫폼 경계 기준으로 확인한다. */
export function isPathWithin(base: string, candidate: string): boolean {
  const rel = relative(resolve(base), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** 레지스트리의 POSIX 상대 경로에 exact/directory-boundary 필터를 적용한다. */
export function pathMatchesDir(filePath: string, dir: string): boolean {
  const normalized = normalizeDirFilter(dir);
  return normalized === undefined || filePath === normalized || filePath.startsWith(`${normalized}/`);
}

/** CLI directory filters are repository-relative; root-like spellings mean no filter. */
export function normalizeDirFilter(dir: string | undefined): string | undefined {
  if (dir === undefined) return undefined;
  const normalized = dir.replace(/\\/g, '/').split('/').reduce<string[]>((parts, part) => {
    if (part === '' || part === '.') return parts;
    if (part === '..') parts.pop();
    else parts.push(part);
    return parts;
  }, []).join('/');
  return normalized || undefined;
}

/** 절대/상대 CLI 경로를 레지스트리의 저장소 상대 POSIX 필터로 변환한다. */
export function resolveProjectDirFilter(projectRoot: string, dir: string | undefined): string | undefined {
  if (dir === undefined) return undefined;
  const resolvedRoot = resolve(projectRoot);
  const resolvedDir = resolve(projectRoot, dir);
  if (!isPathWithin(resolvedRoot, resolvedDir)) {
    throw new Error(`Directory must be inside the project root: ${escapeTerminal(dir)}`);
  }
  // 존재하지 않는 필터도 빈 결과 진단에 사용된다. 가장 가까운 기존 조상을
  // 확인하면 그 경로 앞부분의 심볼릭 링크 탈출은 막으면서 이 동작을 보존한다.
  if (!existsSync(resolvedRoot)) {
    return normalizeDirFilter(relative(resolvedRoot, resolvedDir));
  }
  const realRoot = realpathSync(resolvedRoot);
  let existingAncestor = resolvedDir;
  while (!existsSync(existingAncestor) && existingAncestor !== resolvedRoot) {
    existingAncestor = dirname(existingAncestor);
  }
  const realAncestor = realpathSync(existingAncestor);
  if (!isPathWithin(realRoot, realAncestor)) {
    throw new Error(`Directory symlink must stay inside the project root: ${escapeTerminal(dir)}`);
  }
  const normalized = relative(resolvedRoot, resolvedDir).replace(/\\/g, '/');
  return normalized || undefined;
}
