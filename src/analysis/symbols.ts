import type { AstLanguage } from '../frontend/types.js';
import type { EntityKind } from '../registry/schema.js';

export type SymbolValue =
  | { kind: 'name'; name: string }
  | { kind: 'entity'; qualifiedName: string }
  | { kind: 'member'; object: SymbolValue; name: string }
  | { kind: 'instance'; type: SymbolValue }
  | { kind: 'invoke'; callee: SymbolValue }
  | { kind: 'union'; types: SymbolValue[] }
  | { kind: 'intersection'; types: SymbolValue[] }
  | { kind: 'type'; name: string }
  | { kind: 'generic'; name: string; args: SymbolValue[] }
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
  /** JS object/class members do not introduce lexical names in initializers. */
  memberOnly?: boolean;
  redirects?: Record<string, number>;
  /** Rust generic type parameter bounds, e.g. `T: Read + Send`. */
  genericBounds?: Record<string, string[]>;
  /** TypeScript union constraints, e.g. `T extends A | B`. */
  genericUnionBounds?: Record<string, string[]>;
  parameters?: Array<{ index: number; name?: string; receiver: boolean; typeName?: string; copy?: boolean }>;
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

export interface ConditionalTypeFact {
  left: string;
  right: string;
  parameter?: string;
  /** Supported simple `Container<infer U>` pattern and the inferred U name. */
  infer?: { container: string; parameter: string };
  /** Multiple direct `infer` arguments in one generic container. */
  inferences?: Array<{ container: string; parameter: string; index: number }>;
  /** Nested generic infer paths, e.g. Pair<infer A, Box<infer B>>. */
  inferencePatterns?: Array<{ path: number[]; containers: string[]; parameter: string }>;
  whenTrue: SymbolValue;
  whenFalse: SymbolValue;
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
  /** Flow-sensitive member writes used to avoid stale receiver dispatch. */
  memberWrites?: Array<{ object: string; property: string; offset: number; scope: number }>;
  bases: Array<{ entity: string; type: SymbolValue; scope: number }>;
  implementations: Array<{ type: SymbolValue; trait?: SymbolValue; scope: number; parentScope: number }>;
  /** Flow-sensitive type refinements whose positive branch covers the span. */
  narrowings?: Array<{ name: string; type: SymbolValue; scope: number; startOffset: number; endOffset: number }>;
  /** TypeScript negative branch refinements, such as `else` after `x instanceof A`. */
  exclusions?: Array<{ name: string; type: SymbolValue; scope: number; startOffset: number; endOffset: number }>;
  /** Literal discriminants declared by TypeScript interfaces or object type aliases. */
  discriminants?: Record<string, Record<string, string>>;
  /** Discriminant comparisons retained for cross-file type resolution. */
  discriminantChecks?: Array<{ name: string; property: string; values: string[]; matches: boolean; scope: number; startOffset: number; endOffset: number }>;
  /** TypeScript `"property" in value` branch checks for union member narrowing. */
  propertyChecks?: Array<{ name: string; property: string; matches: boolean; scope: number; startOffset: number; endOffset: number }>;
  /** Rust `impl Copy for T` and `#[derive(Copy)]` declarations found in this file. */
  copyTypes?: string[];
  /** Conservative TypeScript conditional type aliases with identity checks. */
  conditionalTypes?: Record<string, ConditionalTypeFact>;
}

export type ResolutionReason = 'lexical-binding' | 'import' | 'alias' | 'receiver-type'
  | 'unbound-name' | 'external-module' | 'missing-module' | 'ambiguous-binding'
  | 'dynamic-call' | 'unknown-receiver' | 'alias-cycle' | 'uninitialized-binding'
  | 'reassigned-binding' | 'missing-export' | 'unsupported-call';

export interface ResolvedCallSite extends CallSite {
  target?: string;
  external?: ExternalSymbol;
  resolution: 'resolved' | 'unresolved' | 'external';
  reason: ResolutionReason;
  confidence: number;
}

/** import 경로에서 얻은 식별자이며, 실제 설치/버전 확인을 뜻하지 않는다. */
export interface ExternalSymbol {
  language: AstLanguage;
  module: string;
  symbol: string;
}
