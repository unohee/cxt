import { posix } from 'node:path';
import type { CallSite, ExternalSymbol, ResolvedCallSite, ResolutionReason, SymbolEntity, SymbolFacts, SymbolValue } from './symbols.js';

type Target =
  | { kind: 'external'; external: ExternalSymbol; reason: ResolutionReason }
  | { kind: 'entity'; facts: SymbolFacts; entity: SymbolEntity; reason: ResolutionReason }
  | { kind: 'module'; facts: SymbolFacts; scope: number; reason: ResolutionReason }
  | { kind: 'instance'; facts: SymbolFacts; entity: SymbolEntity; reason: ResolutionReason }
  | { kind: 'failure'; reason: ResolutionReason };
const failure = (reason: ResolutionReason): Target => ({ kind: 'failure', reason });

export interface SymbolResolution {
  calls: ResolvedCallSite[];
  bases: Array<{ source: string; target: string; type: 'extends' | 'implements' }>;
}

/** Project-local binding resolution. Unknown targets are retained as call-site facts. */
export function resolveSymbols(files: SymbolFacts[]): SymbolResolution {
  const byFile = new Map(files.map(f => [f.filePath, f]));
  const byEntity = new Map<string, { facts: SymbolFacts; entity: SymbolEntity }>();
  for (const facts of files) for (const entity of facts.entities) byEntity.set(entity.qualifiedName, { facts, entity });

  function moduleTarget(from: SymbolFacts, specifier: string): Target {
    const external = (): Target => ({ kind: 'external', external: { language: from.language, module: specifier, symbol: '' }, reason: 'external-module' });
    let paths: string[];
    const directory = posix.dirname(from.filePath);
    if (from.language === 'typescript') {
      if (!specifier.startsWith('.')) return external();
      const base = posix.normalize(posix.join(directory, specifier));
      if (base === '..' || base.startsWith('../')) return failure('missing-module');
      const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
      paths = /\.(?:[cm]?js|jsx)$/.test(base)
        ? [`${stem}.ts`, `${stem}.tsx`, base]
        : [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'].map(ext => base + ext)];
    } else if (from.language === 'python') {
      const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
      let base = dots ? directory : '';
      for (let level = 1; level < dots; level++) base = posix.dirname(base);
      base = posix.join(base, specifier.slice(dots).replaceAll('.', '/'));
      paths = [`${base}.py`, posix.join(base, '__init__.py')];
      if (!dots) paths.push(posix.join('src', `${base}.py`), posix.join('src', base, '__init__.py'));
    } else {
      const parts = specifier.split('::').filter(Boolean);
      const crateRoot = from.filePath.startsWith('src/') ? 'src' : '';
      const isRoot = ['lib.rs', 'main.rs', 'mod.rs'].includes(posix.basename(from.filePath));
      let base = isRoot ? directory : from.filePath.replace(/\.rs$/, '');
      if (parts[0] === 'crate') { base = crateRoot; parts.shift(); }
      else if (parts[0] === 'self') parts.shift();
      while (parts[0] === 'super') { base = posix.dirname(base); parts.shift(); }
      base = posix.join(base, ...parts);
      paths = [`${base}.rs`, posix.join(base, 'mod.rs')];
      if (!parts.length && base === crateRoot) paths = [posix.join(base, 'lib.rs'), posix.join(base, 'main.rs')];
    }
    for (const path of paths) {
      const facts = byFile.get(posix.normalize(path));
      if (facts) return { kind: 'module', facts, scope: 0, reason: 'import' };
    }
    return from.language === 'typescript' || /^[.]/.test(specifier) || /^(crate|self|super)(::|$)/.test(specifier)
      ? failure('missing-module') : external();
  }

  function exportTarget(facts: SymbolFacts, name: string, seen: Set<string>, scope = 0): Target {
    const key = `export:${facts.filePath}:${scope}:${name}`;
    if (seen.has(key)) return failure('alias-cycle');
    const next = new Set(seen).add(key);
    if (facts.language === 'python') return lookup(facts, scope, name, Infinity, next, true, false);
    const explicit = facts.exports.filter(e => e.name === name && e.scope === scope);
    if (explicit.length) return unique(explicit.map(e => valueTarget(e.value, facts, e.scope, Infinity, next)));
    const candidates = facts.starExports.map(specifier => {
      const target = moduleTarget(facts, specifier);
      return target.kind === 'module' ? exportTarget(target.facts, name, next, target.scope) : target.kind === 'external' ? member(target, name, next) : target;
    }).filter(t => t.kind !== 'failure' || !['missing-export', 'unbound-name', 'alias-cycle'].includes(t.reason));
    return candidates.length ? unique(candidates) : failure('missing-export');
  }

  function unique(targets: Target[]): Target {
    const usable = targets.filter(t => t.kind !== 'failure');
    const keys = new Set(usable.map(t => t.kind === 'external' ? JSON.stringify(t.external) : t.kind === 'module' ? `${t.facts.filePath}#${t.scope}` : t.entity.qualifiedName));
    if (keys.size > 1) return failure('ambiguous-binding');
    // An unknown candidate can name a different target. Dropping it would turn
    // partial knowledge (for example an external star export) into an exact edge.
    if (usable.length && targets.some(t => t.kind === 'failure')) return failure('ambiguous-binding');
    return usable[0] ?? targets[0] ?? failure('unbound-name');
  }

  function lookup(facts: SymbolFacts, scope: number, name: string, offset: number, seen: Set<string>, onlyScope = false, skipClass = true): Target {
    const origin = scope;
    const functionScope = (index: number): number => {
      while (facts.scopes[index].parent !== null && facts.scopes[index].kind !== 'function') index = facts.scopes[index].parent!;
      return index;
    };
    while (true) {
      const frame = facts.scopes[scope];
      if (frame.redirects?.[name] !== undefined) return lookup(facts, frame.redirects[name], name, offset, seen, true, false);
      const found = skipClass && (frame.memberOnly || scope !== origin && frame.kind === 'class') ? [] : facts.bindings.filter(b => b.scope === scope && b.name === name);
      if (found.length) {
        let bindings = found;
        if (bindings.every(b => b.value.kind === 'entity')) {
          const implemented = bindings.filter(b => b.value.kind === 'entity' && byEntity.get(b.value.qualifiedName)?.entity.hasBody);
          if (implemented.length) bindings = implemented;
        } else if (bindings.length > 1) return failure('reassigned-binding');
        // A declaration outside this function may execute before the function is
        // invoked; source ordering alone cannot prove it uninitialized there.
        if (functionScope(scope) === functionScope(origin) && bindings.some(b => !b.hoisted && b.offset > offset)) return failure('uninitialized-binding');
        const result = unique(bindings.map(binding => {
          const key = `binding:${facts.filePath}:${binding.scope}:${binding.name}:${binding.offset}`;
          if (seen.has(key)) return failure('alias-cycle');
          const target = valueTarget(binding.value, facts, binding.scope, binding.offset, new Set(seen).add(key));
          if (target.kind !== 'failure' && binding.value.kind === 'name') target.reason = 'alias';
          return target;
        }));
        return result;
      }
      if (onlyScope || frame.parent === null) break;
      scope = frame.parent;
    }
    if (facts.language === 'rust' && name === 'crate') return moduleTarget(facts, 'crate');
    if (!onlyScope && facts.language !== 'typescript' && facts.starExports.length) {
      const targets = facts.starExports.map(specifier => {
        const target = moduleTarget(facts, specifier);
        return target.kind === 'module' ? exportTarget(target.facts, name, seen) : target.kind === 'external' ? member(target, name, seen) : target;
      });
      return unique(targets);
    }
    return failure('unbound-name');
  }

  function member(target: Target, name: string, seen: Set<string>): Target {
    if (target.kind === 'failure') return target;
    if (target.kind === 'external') return { ...target, external: { ...target.external, symbol: [target.external.symbol, name].filter(Boolean).join('.') } };
    if (target.kind === 'module') {
      const result = exportTarget(target.facts, name, seen, target.scope);
      if (result.kind !== 'failure' || !['missing-export', 'unbound-name'].includes(result.reason)) return result;
      // Python and Rust permit qualified paths through modules without an
      // explicit imported binding in the parent module.
      if (target.facts.language === 'python') {
        const module = posix.basename(target.facts.filePath) === '__init__.py'
          ? `.${name}` : `.${posix.basename(target.facts.filePath, '.py')}.${name}`;
        return moduleTarget(target.facts, module);
      }
      if (target.facts.language === 'rust') return moduleTarget(target.facts, `self::${name}`);
      return result;
    }
    const { facts, entity } = target;
    const key = `member:${entity.qualifiedName}:${name}`;
    if (seen.has(key)) return failure('alias-cycle');
    const next = new Set(seen).add(key);
    const candidates: Target[] = [];
    if (entity.bodyScope !== undefined && facts.bindings.some(b => b.scope === entity.bodyScope && b.name === name)) {
      candidates.push(lookup(facts, entity.bodyScope, name, Infinity, next, true, false));
    }
    for (const implementation of facts.implementations) {
      const type = valueTarget(implementation.type, facts, implementation.parentScope, Infinity, next);
      if (type.kind === 'entity' && type.entity.qualifiedName === entity.qualifiedName
        && facts.bindings.some(b => b.scope === implementation.scope && b.name === name)) {
        candidates.push(lookup(facts, implementation.scope, name, Infinity, next, true, false));
      }
    }
    if (candidates.length) { const resolved = unique(candidates); if (resolved.kind !== 'failure') resolved.reason = 'receiver-type'; return resolved; }
    const inherited = facts.bases.filter(base => base.entity === entity.qualifiedName)
      .map(base => member(valueTarget(base.type, facts, base.scope, Infinity, next), name, next));
    return inherited.length ? unique(inherited) : failure('unknown-receiver');
  }

  function valueTarget(value: SymbolValue, facts: SymbolFacts, scope: number, offset: number, seen: Set<string>): Target {
    if (seen.size > 100) return failure('alias-cycle');
    switch (value.kind) {
      case 'unknown': return failure(value.reason === 'unknown-receiver' ? 'unknown-receiver' : 'dynamic-call');
      case 'entity': {
        const match = byEntity.get(value.qualifiedName);
        if (match?.entity.kind === 'module') {
          if (!match.entity.hasBody) return moduleTarget(match.facts, `self::${match.entity.name}`);
          return { kind: 'module', facts: match.facts, scope: match.entity.bodyScope!, reason: 'lexical-binding' };
        }
        return match ? { kind: 'entity', ...match, reason: 'lexical-binding' } : failure('unbound-name');
      }
      case 'name': return lookup(facts, scope, value.name, offset, seen);
      case 'member': return member(valueTarget(value.object, facts, scope, offset, seen), value.name, seen);
      case 'import': {
        const target = moduleTarget(facts, value.module);
        if (target.kind === 'external' && value.name !== '*') return member(target, value.name, seen);
        if (target.kind !== 'module' || value.name === '*') return target;
        const result = facts.language === 'typescript' ? exportTarget(target.facts, value.name, seen)
          : member(target, value.name, seen);
        if (result.kind !== 'failure') result.reason = 'import';
        return result;
      }
      case 'instance': {
        const type = valueTarget(value.type, facts, scope, offset, seen);
        return type.kind === 'entity' ? { ...type, kind: 'instance', reason: 'receiver-type' } : type.kind === 'external' ? failure('unknown-receiver') : type;
      }
      case 'invoke': {
        const callee = valueTarget(value.callee, facts, scope, offset, seen);
        if (callee.kind !== 'entity') return callee.kind === 'failure' ? callee : failure('unknown-receiver');
        if (callee.entity.kind === 'class') return { ...callee, kind: 'instance', reason: 'receiver-type' };
        if (callee.entity.returnType) {
          const type = valueTarget(callee.entity.returnType, callee.facts, callee.entity.bodyScope ?? callee.entity.scope, Infinity, seen);
          if (type.kind === 'entity') return { ...type, kind: 'instance', reason: 'receiver-type' };
        }
        return failure('unknown-receiver');
      }
    }
  }

  function call(facts: SymbolFacts, site: CallSite): ResolvedCallSite {
    const result = valueTarget(site.callee, facts, site.scope, site.offset, new Set());
    if (result.kind === 'external') return { ...site, external: result.external, resolution: 'external', reason: 'external-module', confidence: 0 };
    if (result.kind === 'entity' && ['function', 'class'].includes(result.entity.kind)) {
      return { ...site, target: result.entity.qualifiedName, resolution: 'resolved', reason: result.reason,
        confidence: result.reason === 'receiver-type' ? 0.9 : 1 };
    }
    const reason = result.kind === 'failure' ? result.reason : 'unsupported-call';
    return { ...site, resolution: reason === 'external-module' ? 'external' : 'unresolved', reason, confidence: 0 };
  }
  const calls = files.flatMap(facts => facts.calls.map(site => call(facts, site)));
  const bases: SymbolResolution['bases'] = [];
  for (const facts of files) for (const base of facts.bases) {
    const target = valueTarget(base.type, facts, base.scope, Infinity, new Set());
    if (target.kind === 'entity') bases.push({ source: base.entity, target: target.entity.qualifiedName,
      type: target.entity.kind === 'type' ? 'implements' : 'extends' });
  }
  return { calls, bases };
}
