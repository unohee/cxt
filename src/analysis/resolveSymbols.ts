import { posix } from 'node:path';
import type { CallSite, ExternalSymbol, ResolvedCallSite, ResolutionReason, SymbolEntity, SymbolFacts, SymbolValue } from './symbols.js';

type Target =
  | { kind: 'external'; external: ExternalSymbol; reason: ResolutionReason }
  | { kind: 'external-instance'; external: ExternalSymbol; reason: ResolutionReason }
  | { kind: 'entity'; facts: SymbolFacts; entity: SymbolEntity; reason: ResolutionReason; isAbstract?: boolean }
  | { kind: 'module'; facts: SymbolFacts; scope: number; reason: ResolutionReason }
  | { kind: 'instance'; facts: SymbolFacts; entity: SymbolEntity; reason: ResolutionReason; isAbstract?: boolean }
  | { kind: 'union'; targets: Target[] }
  | { kind: 'intersection'; targets: Target[] }
  | { kind: 'failure'; reason: ResolutionReason };
const failure = (reason: ResolutionReason): Target => ({ kind: 'failure', reason });

export interface SymbolResolution {
  calls: ResolvedCallSite[];
  bases: Array<{ source: string; target: string; type: 'extends' | 'implements' }>;
}
export interface SymbolResolutionOptions {
  /** TypeScript path aliases after tsconfig parsing; paths remain project-relative. */
  typescriptPaths?: Record<string, string[]>;
  typescriptBaseUrl?: string;
  /** Workspace package name to project-relative source root. */
  typescriptPackageRoots?: Record<string, string>;
  /** Explicit package export specifier to project-relative source targets. */
  typescriptPackageMappings?: Record<string, string[]>;
  /** Pattern export mappings such as `@pkg/features/*` -> `src/features/*.ts`. */
  typescriptPackagePatterns?: Array<{ pattern: string; targets: string[] }>;
  /** Packages with an `exports` field; non-mapped subpaths are private. */
  typescriptRestrictedPackages?: string[];
}

/** Project-local binding resolution. Unknown targets are retained as call-site facts. */
export function resolveSymbols(files: SymbolFacts[], options: SymbolResolutionOptions = {}): SymbolResolution {
  const byFile = new Map(files.map(f => [f.filePath, f]));
  const byEntity = new Map<string, { facts: SymbolFacts; entity: SymbolEntity }>();
  for (const facts of files) for (const entity of facts.entities) byEntity.set(entity.qualifiedName, { facts, entity });
  const discriminants = new Map<string, Record<string, string>>();
  for (const facts of files) for (const [qualifiedName, values] of Object.entries(facts.discriminants ?? {})) discriminants.set(qualifiedName, values);

  function moduleTarget(from: SymbolFacts, specifier: string): Target {
    const external = (): Target => ({ kind: 'external', external: { language: from.language, module: specifier, symbol: '' }, reason: 'external-module' });
    let paths: string[];
    const directory = posix.dirname(from.filePath);
    if (from.language === 'typescript') {
      if (options.typescriptPaths && !specifier.startsWith('.')) {
        for (const [pattern, targets] of Object.entries(options.typescriptPaths)) {
          const wildcard = pattern.indexOf('*');
          const prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
          const suffix = wildcard < 0 ? '' : pattern.slice(wildcard + 1);
          if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
          const middle = specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
          const aliasPaths = targets.map(target => target.replaceAll('*', middle));
          const candidates = aliasPaths.flatMap(target => {
            const base = posix.normalize(posix.join(options.typescriptBaseUrl ?? '', target));
            const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
            return /\.(?:[cm]?js|jsx|ts|tsx)$/.test(base)
              ? [`${stem}.ts`, `${stem}.tsx`, base]
              : [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'].map(ext => base + ext)];
          });
          for (const path of candidates) {
            const facts = byFile.get(path);
            if (facts) return { kind: 'module', facts, scope: 0, reason: 'import' };
          }
        }
      }
      if (options.typescriptPackageMappings && !specifier.startsWith('.')) {
        const mappings = options.typescriptPackageMappings[specifier];
        if (mappings) {
          for (const base of mappings) {
            const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
            const candidates = /\.(?:[cm]?js|jsx|ts|tsx)$/.test(base)
              ? [`${stem}.ts`, `${stem}.tsx`, base]
              : [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'].map(ext => base + ext)];
            for (const path of candidates) {
              const facts = byFile.get(posix.normalize(path));
              if (facts) return { kind: 'module', facts, scope: 0, reason: 'import' };
            }
          }
          return failure('missing-module');
        }
      }
      if (options.typescriptPackagePatterns && !specifier.startsWith('.')) {
        for (const mapping of options.typescriptPackagePatterns) {
          const wildcard = mapping.pattern.indexOf('*');
          if (wildcard < 0) continue;
          const prefix = mapping.pattern.slice(0, wildcard);
          const suffix = mapping.pattern.slice(wildcard + 1);
          if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
          const middle = specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
          const candidates = mapping.targets.flatMap(target => {
            const base = target.replaceAll('*', middle);
            const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
            return /\.(?:[cm]?js|jsx|ts|tsx)$/.test(base)
              ? [`${stem}.ts`, `${stem}.tsx`, base]
              : [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'].map(ext => base + ext)];
          });
          for (const path of candidates) {
            const facts = byFile.get(posix.normalize(path));
            if (facts) return { kind: 'module', facts, scope: 0, reason: 'import' };
          }
          return failure('missing-module');
        }
      }
      if (options.typescriptRestrictedPackages?.some(name => specifier === name || specifier.startsWith(`${name}/`))) {
        return failure('missing-module');
      }
      if (options.typescriptPackageRoots && !specifier.startsWith('.')) {
        const packageName = Object.keys(options.typescriptPackageRoots).filter(name => specifier === name || specifier.startsWith(`${name}/`))
          .sort((left, right) => right.length - left.length)[0];
        if (packageName) {
          const subpath = specifier.slice(packageName.length).replace(/^\//, '');
          const base = posix.normalize(posix.join(options.typescriptPackageRoots[packageName], subpath));
          const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
          const candidates = /\.(?:[cm]?js|jsx|ts|tsx)$/.test(base)
            ? [`${stem}.ts`, `${stem}.tsx`, base]
            : [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'].map(ext => base + ext)];
          for (const path of candidates) {
            const facts = byFile.get(path);
            if (facts) return { kind: 'module', facts, scope: 0, reason: 'import' };
          }
        }
      }
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
    const key = (target: Target): string => target.kind === 'failure' ? `failure:${target.reason}`
      : target.kind === 'external' ? `external:${JSON.stringify(target.external)}`
      : target.kind === 'module' ? `module:${target.facts.filePath}#${target.scope}`
        : target.kind === 'external-instance' ? `external-instance:${JSON.stringify(target.external)}`
        : target.kind === 'union' ? `union:${target.targets.map(key).sort().join('|')}`
          : target.kind === 'intersection' ? `intersection:${target.targets.map(key).sort().join('&')}`
            : target.entity.qualifiedName;
    const keys = new Set(usable.map(key));
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
          if (target.kind !== 'failure' && target.kind !== 'union' && target.kind !== 'intersection' && binding.value.kind === 'name') target.reason = 'alias';
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

  function member(target: Target, name: string, seen: Set<string>, objectName?: string, offset = Infinity): Target {
    if (target.kind === 'failure') return target;
    if (target.kind === 'union') return unique(target.targets.map(item => member(item, name, seen, objectName, offset)));
    if (target.kind === 'intersection') {
      const candidates = target.targets.map(item => member(item, name, seen, objectName, offset)).filter(item => item.kind !== 'failure');
      return candidates.length ? unique(candidates) : failure('missing-module');
    }
    if (target.kind === 'external') return { ...target, external: { ...target.external,
      // A default/namespace import is the module object at this boundary;
      // its property callable has the same external symbol as a named import.
      symbol: target.external.symbol === 'default' ? name : [target.external.symbol, name].filter(Boolean).join('.') } };
    if (target.kind === 'external-instance') return { kind: 'external', external: {
      ...target.external, symbol: [target.external.symbol, name].filter(Boolean).join('.') }, reason: 'receiver-type' };
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
    if (objectName && (facts.memberWrites ?? []).some(write => write.object === objectName && write.property === name && write.offset < offset)) {
      return failure('reassigned-binding');
    }
    const key = `member:${entity.qualifiedName}:${name}`;
    if (seen.has(key)) return failure('alias-cycle');
    const next = new Set(seen).add(key);
    const candidates: Target[] = [];
    if (entity.bodyScope !== undefined && facts.bindings.some(b => b.scope === entity.bodyScope && b.name === name)) {
      candidates.push(lookup(facts, entity.bodyScope, name, Infinity, next, true, false));
    }
    if (!target.isAbstract) for (const implementation of facts.implementations) {
      const type = valueTarget(implementation.type, facts, implementation.parentScope, Infinity, next);
      if (type.kind === 'entity' && type.entity.qualifiedName === entity.qualifiedName
        && facts.bindings.some(b => b.scope === implementation.scope && b.name === name)) {
        candidates.push(lookup(facts, implementation.scope, name, Infinity, next, true, false));
      }
    }
    // TypeScript interfaces are erased at runtime, but a statically typed
    // receiver can still be narrowed when the project has exactly one
    // indexed class implementing that interface. Multiple implementations
    // remain ambiguous instead of fabricating a dispatch target.
    if (!target.isAbstract && entity.kind === 'type') {
      for (const baseFacts of files) for (const base of baseFacts.bases) {
        const baseType = valueTarget(base.type, baseFacts, base.scope, Infinity, next);
        if (baseType.kind !== 'entity' || baseType.entity.qualifiedName !== entity.qualifiedName) continue;
        const implementation = byEntity.get(base.entity);
        if (!implementation || implementation.entity.kind !== 'class') continue;
        candidates.push(member({ kind: 'entity', facts: implementation.facts, entity: implementation.entity, reason: 'receiver-type' }, name, next));
      }
    }
    // Python method lookup is dynamic even when the annotation names a base
    // class. If an indexed subclass overrides a concrete base method, retain
    // both possible targets instead of claiming the base implementation is
    // certain. A subclass that merely inherits the method adds no new edge.
    if (!target.isAbstract && facts.language === 'python' && entity.kind === 'class'
      && entity.bodyScope !== undefined && facts.bindings.some(binding => binding.scope === entity.bodyScope && binding.name === name)) {
      for (const baseFacts of files) for (const base of baseFacts.bases) {
        const baseType = valueTarget(base.type, baseFacts, base.scope, Infinity, next);
        if (baseType.kind !== 'entity' || baseType.entity.qualifiedName !== entity.qualifiedName) continue;
        const subclass = byEntity.get(base.entity);
        if (!subclass || subclass.entity.kind !== 'class' || subclass.entity.bodyScope === undefined) continue;
        if (!subclass.facts.bindings.some(binding => binding.scope === subclass.entity.bodyScope && binding.name === name)) continue;
        candidates.push(lookup(subclass.facts, subclass.entity.bodyScope, name, Infinity, next, true, false));
      }
    }
    // Rust trait implementations carry both the concrete type and trait in
    // the AST. Prefer concrete methods over a trait declaration when a
    // unique implementation is indexed; multiple implementations remain
    // ambiguous through `unique`.
    if (!target.isAbstract && entity.kind === 'type') {
      for (const implFacts of files) for (const implementation of implFacts.implementations) {
        if (!implementation.trait) continue;
        const trait = valueTarget(implementation.trait, implFacts, implementation.parentScope, Infinity, next);
        if (trait.kind !== 'entity' || trait.entity.qualifiedName !== entity.qualifiedName) continue;
        if (!implFacts.bindings.some(binding => binding.scope === implementation.scope && binding.name === name)) continue;
        candidates.push(lookup(implFacts, implementation.scope, name, Infinity, next, true, false));
      }
    }
    const concrete = candidates.filter(candidate => candidate.kind === 'entity' && candidate.entity.hasBody);
    if (concrete.length) candidates.splice(0, candidates.length, ...concrete);
    if (candidates.length) { const resolved = unique(candidates); if (resolved.kind !== 'failure' && resolved.kind !== 'union' && resolved.kind !== 'intersection') resolved.reason = 'receiver-type'; return resolved; }
    const inherited = facts.bases.filter(base => base.entity === entity.qualifiedName)
      .map(base => member(valueTarget(base.type, facts, base.scope, Infinity, next), name, next));
    return inherited.length ? unique(inherited) : failure('unknown-receiver');
  }

  function genericBoundTarget(facts: SymbolFacts, scope: number, name: string, seen: Set<string>): Target {
    let current: number | null = scope;
    while (current !== null) {
      const bounds = facts.scopes[current].genericBounds?.[name];
      if (bounds?.length) {
        const resolved = bounds.map(bound => lookup(facts, current!, bound, Infinity, seen));
        if (resolved.some(target => target.kind === 'failure')) return failure('unknown-receiver');
        const targets = resolved.filter((target): target is Extract<Target, { kind: 'entity' }> => target.kind === 'entity');
        if (targets.length !== resolved.length) return failure('unknown-receiver');
        const abstractTargets = targets.map(target => ({ ...target, isAbstract: true, reason: 'receiver-type' as const }));
        if (abstractTargets.length === 1) return abstractTargets[0];
        if (abstractTargets.length > 1) return { kind: 'intersection', targets: abstractTargets };
        return failure('unknown-receiver');
      }
      const unionBounds = facts.scopes[current].genericUnionBounds?.[name];
      if (unionBounds?.length) {
        const resolved = unionBounds.map(bound => lookup(facts, current!, bound, Infinity, seen));
        if (resolved.some(target => target.kind === 'failure')) return failure('unknown-receiver');
        const targets = resolved.filter((target): target is Extract<Target, { kind: 'entity' }> => target.kind === 'entity');
        if (targets.length !== resolved.length) return failure('unknown-receiver');
        return { kind: 'union', targets: targets.map(target => ({ ...target, isAbstract: true, reason: 'receiver-type' as const })) };
      }
      current = facts.scopes[current].parent;
    }
    return failure('unknown-receiver');
  }

  function hasGenericBound(facts: SymbolFacts, scope: number, name: string): boolean {
    let current: number | null = scope;
    while (current !== null) {
      if (facts.scopes[current].genericBounds?.[name]?.length) return true;
      if (facts.scopes[current].genericUnionBounds?.[name]?.length) return true;
      current = facts.scopes[current].parent;
    }
    return false;
  }

  function typeText(value: SymbolValue): string | undefined {
    if (value.kind === 'type' || value.kind === 'name') return value.name;
    if (value.kind === 'entity') return value.qualifiedName.split('::').at(-1);
    return undefined;
  }

  function conditionalTarget(target: Extract<Target, { kind: 'entity' }>, args: SymbolValue[], facts: SymbolFacts, scope: number, seen: Set<string>): Target {
    const fact = target.facts.conditionalTypes?.[target.entity.qualifiedName];
    if (!fact) return target;
    if (fact.parameter && !args.length) return failure('unknown-receiver');
    const argument = args[0];
    // A conditional applied to a union must not silently choose the false arm
    // just because the union itself has no single type name. If every arm
    // selects the same branch, that branch remains sound; mixed branches stay
    // unresolved rather than fabricating a dispatch edge.
    const argumentArms = argument?.kind === 'union' ? argument.types : argument ? [argument] : [];
    const selectedArms = (argumentArms.length ? argumentArms : [undefined]).map(arm => {
      const inferred = fact.infer && arm?.kind === 'generic' && arm.name === fact.infer.container && arm.args.length === 1
        ? arm.args[0] : undefined;
      const inferredValues = fact.inferences && arm?.kind === 'generic'
        && arm.name === fact.inferences[0]?.container
        && arm.args.length === fact.inferences.length
        ? Object.fromEntries(fact.inferences.map(inference => [inference.parameter, arm.args[inference.index]]))
        : undefined;
      const nestedInferredValues = fact.inferencePatterns && arm?.kind === 'generic' ? (() => {
        const values: Record<string, SymbolValue> = {};
        for (const inference of fact.inferencePatterns) {
          let current: SymbolValue | undefined = arm;
          for (let depth = 0; depth < inference.path.length; depth++) {
            const container = inference.containers[depth];
            if (!current || current.kind !== 'generic' || current.name !== container) return undefined;
            current = current.args[inference.path[depth]];
          }
          if (!current || current.kind !== 'generic' && current.kind !== 'name' && current.kind !== 'type') return undefined;
          values[inference.parameter] = current;
        }
        return values;
      })() : undefined;
      const left = inferred || inferredValues || nestedInferredValues ? fact.right : fact.parameter && arm ? typeText(arm) : fact.left;
      return { value: left === fact.right ? fact.whenTrue : fact.whenFalse, inferred, inferredValues: inferredValues ?? nestedInferredValues };
    });
    const selected = selectedArms[0].value;
    if (selectedArms.some(arm => JSON.stringify(arm.value) !== JSON.stringify(selected)
      || JSON.stringify(arm.inferred) !== JSON.stringify(selectedArms[0].inferred)
      || JSON.stringify(arm.inferredValues) !== JSON.stringify(selectedArms[0].inferredValues))) return failure('ambiguous-binding');
    const inferred = selectedArms[0].inferred;
    const inferredValues = selectedArms[0].inferredValues;
    if (inferredValues && selected.kind === 'name' && inferredValues[selected.name])
      return valueTarget(inferredValues[selected.name], facts, scope, Infinity, seen);
    if (fact.infer && inferred && selected.kind === 'name' && selected.name === fact.infer.parameter)
      return valueTarget(inferred, facts, scope, Infinity, seen);
    if (selected.kind === 'name' && selected.name === fact.parameter && args[0]) return valueTarget(args[0], facts, scope, Infinity, seen);
    return valueTarget(selected, target.facts, target.entity.scope, Infinity, seen);
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
      case 'name': {
        const withinBranch = (branchScope: number): boolean => {
          let current: number | null = scope;
          while (current !== null) {
            if (current === branchScope) return true;
            // A refinement cannot cross into a nested function, even when
            // that function's source span is inside the branch.
            if (facts.scopes[current].kind === 'function') return false;
            current = facts.scopes[current].parent;
          }
          return false;
        };
        const narrowing = facts.narrowings?.find(item => item.name === value.name && withinBranch(item.scope)
          && offset >= item.startOffset && offset < item.endOffset);
        if (narrowing) {
          const narrowed = valueTarget(narrowing.type, facts, scope, offset, seen);
          if (narrowed.kind === 'entity') return { ...narrowed, kind: 'instance', reason: 'receiver-type' };
          if (narrowed.kind === 'union') return narrowed;
        }
        const exclusions = facts.exclusions?.filter(item => item.name === value.name && withinBranch(item.scope)
          && offset >= item.startOffset && offset < item.endOffset) ?? [];
        if (exclusions.length) {
          const base = lookup(facts, scope, value.name, -1, seen);
          if (base.kind === 'union') {
            const excludedNames = new Set(exclusions.flatMap(exclusion => {
              const target = valueTarget(exclusion.type, facts, scope, offset, seen);
              return target.kind === 'entity' ? [target.entity.qualifiedName] : [];
            }));
            const selected = base.targets.filter(target => target.kind === 'entity' && !excludedNames.has(target.entity.qualifiedName));
            if (selected.length === 1 && selected[0].kind === 'entity') return { ...selected[0], kind: 'instance', reason: 'receiver-type' };
            if (selected.length > 1) return { kind: 'union', targets: selected };
          }
        }
        const propertyCheck = facts.propertyChecks?.find(item => item.name === value.name && withinBranch(item.scope)
          && offset >= item.startOffset && offset < item.endOffset);
        if (propertyCheck) {
          const base = lookup(facts, scope, value.name, -1, seen);
          if (base.kind === 'union') {
            const hasProperty = (target: Target) => {
              if (!['entity', 'instance'].includes(target.kind)) return false;
              const memberTarget = member(target, propertyCheck.property, new Set(seen));
              return memberTarget.kind !== 'failure';
            };
            const selected = base.targets.filter(target => hasProperty(target) === propertyCheck.matches);
            if (selected.length === 1 && selected[0].kind === 'entity') return { ...selected[0], kind: 'instance', reason: 'receiver-type' };
            if (selected.length > 1) return { kind: 'union', targets: selected };
          }
        }
        const check = facts.discriminantChecks?.find(item => item.name === value.name && withinBranch(item.scope)
          && offset >= item.startOffset && offset < item.endOffset);
        if (check) {
          // Resolve the unrefined union with an offset outside the check span,
          // then filter its concrete arms using discriminants from every file.
          const base = lookup(facts, scope, value.name, -1, seen);
          if (base.kind === 'union') {
            const selected = base.targets.filter(target => target.kind === 'entity'
              && check.values.includes(discriminants.get(target.entity.qualifiedName)?.[check.property] ?? '') === check.matches);
            if (selected.length === 1 && selected[0].kind === 'entity') return { ...selected[0], kind: 'instance', reason: 'receiver-type' };
            if (selected.length > 1) return { kind: 'union', targets: selected };
          }
        }
        const resolved = lookup(facts, scope, value.name, offset, seen);
        return resolved.kind === 'entity' ? conditionalTarget(resolved, [], facts, scope, seen) : resolved;
      }
      case 'type': return failure('unknown-receiver');
      case 'generic': {
        const resolved = lookup(facts, scope, value.name, offset, seen);
        return resolved.kind === 'entity' ? conditionalTarget(resolved, value.args, facts, scope, seen) : resolved;
      }
      case 'member': {
        const target = valueTarget(value.object, facts, scope, offset, seen);
        const objectName = value.object.kind === 'name' ? value.object.name : undefined;
        return member(target, value.name, seen, objectName, offset);
      }
      case 'import': {
        const target = moduleTarget(facts, value.module);
        if (target.kind === 'external' && value.name !== '*') return member(target, value.name, seen);
        if (target.kind !== 'module' || value.name === '*') return target;
        const result = facts.language === 'typescript' ? exportTarget(target.facts, value.name, seen)
          : member(target, value.name, seen);
        if (result.kind !== 'failure' && result.kind !== 'union' && result.kind !== 'intersection') result.reason = 'import';
        return result;
      }
      case 'instance': {
        if (value.type.kind === 'name') {
          const bound = genericBoundTarget(facts, scope, value.type.name, seen);
          if (bound.kind === 'entity') return { ...bound, kind: 'instance' };
          if (bound.kind === 'intersection') return bound;
          if (bound.kind === 'union') return bound;
          if (bound.kind === 'failure' && hasGenericBound(facts, scope, value.type.name)) return bound;
        }
        const type = valueTarget(value.type, facts, scope, offset, seen);
        return type.kind === 'entity' ? { ...type, kind: 'instance', reason: 'receiver-type' }
          : type.kind === 'external' ? { kind: 'external-instance', external: type.external, reason: 'receiver-type' } : type;
      }
      case 'invoke': {
        const callee = valueTarget(value.callee, facts, scope, offset, seen);
        if (callee.kind !== 'entity') return callee.kind === 'failure' ? callee : failure('unknown-receiver');
        if (callee.entity.kind === 'class') return { ...callee, kind: 'instance', reason: 'receiver-type' };
        if (callee.entity.returnType) {
          const type = valueTarget(callee.entity.returnType, callee.facts, callee.entity.bodyScope ?? callee.entity.scope, Infinity, seen);
          if (type.kind === 'entity') return { ...type, kind: 'instance', reason: 'receiver-type' };
          if (type.kind === 'external') return { kind: 'external-instance', external: type.external, reason: 'receiver-type' };
          if (type.kind === 'failure') return type;
        }
        return failure('unknown-receiver');
      }
      case 'union': {
        const targets = value.types.flatMap(item => {
          const target = valueTarget(item, facts, scope, offset, seen);
          return target.kind === 'union' ? target.targets : [target];
        });
        return { kind: 'union', targets };
      }
      case 'intersection': {
        const targets = value.types.flatMap(item => {
          const target = valueTarget(item, facts, scope, offset, seen);
          return target.kind === 'intersection' ? target.targets : [target];
        });
        return { kind: 'intersection', targets };
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
  for (const facts of files) for (const implementation of facts.implementations) {
    if (!implementation.trait) continue;
    const source = valueTarget(implementation.type, facts, implementation.parentScope, Infinity, new Set());
    const target = valueTarget(implementation.trait, facts, implementation.parentScope, Infinity, new Set());
    if (source.kind === 'entity' && target.kind === 'entity') bases.push({ source: source.entity.qualifiedName, target: target.entity.qualifiedName, type: 'implements' });
  }
  return { calls, bases };
}
