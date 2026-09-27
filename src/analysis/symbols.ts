import type { AstLanguage } from '../frontend/types.js';
import type { EntityKind } from '../registry/schema.js';

export type SymbolValue =
  | { kind: 'name'; name: string }
  | { kind: 'entity'; qualifiedName: string }
  | { kind: 'member'; object: SymbolValue; name: string }
  | { kind: 'instance'; type: SymbolValue }
  | { kind: 'invoke'; callee: SymbolValue }
  | { kind: 'import'; module: string; name: string }
  | { kind: 'unknown'; reason: string };

export interface SymbolScope {
  id: number;
  parent: number | null;
  kind: 'module' | 'class' | 'function' | 'block';
  startOffset: number;
  endOffset: number;
  owner?: string;
  receiver?: SymbolValue;
  redirects?: Record<string, number>;
}

export interface SymbolBinding {
  name: string;
  scope: number;
  value: SymbolValue;
  offset: number;
  hoisted: boolean;
  isParameter?: boolean;
}

export interface SymbolEntity {
  qualifiedName: string;
  name: string;
  kind: EntityKind;
  scope: number;
  bodyScope?: number;
  hasBody: boolean;
  returnType?: SymbolValue;
}

export interface CallSite {
  filePath: string;
  caller?: string;
  scope: number;
  callee: SymbolValue;
  expression: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  offset: number;
}

export interface SymbolFacts {
  filePath: string;
  language: AstLanguage;
  scopes: SymbolScope[];
  bindings: SymbolBinding[];
  entities: SymbolEntity[];
  exports: Array<{ name: string; value: SymbolValue; scope: number }>;
  starExports: string[];
  calls: CallSite[];
  bases: Array<{ entity: string; type: SymbolValue; scope: number }>;
  implementations: Array<{ type: SymbolValue; scope: number; parentScope: number }>;
}

export type ResolutionReason = 'lexical-binding' | 'import' | 'alias' | 'receiver-type'
  | 'unbound-name' | 'external-module' | 'missing-module' | 'ambiguous-binding'
  | 'dynamic-call' | 'unknown-receiver' | 'alias-cycle' | 'uninitialized-binding'
  | 'reassigned-binding' | 'missing-export' | 'unsupported-call';

export interface ResolvedCallSite extends CallSite {
  target?: string;
  resolution: 'resolved' | 'unresolved' | 'external';
  reason: ResolutionReason;
  confidence: number;
}
