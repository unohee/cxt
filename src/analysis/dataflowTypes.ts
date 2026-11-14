import type { ExternalSymbol } from './symbols.js';
import type { ModelSelection } from './libraryModels.js';

export type DataExpr =
  | { kind: 'undefined' | 'null' | 'unit' | 'uninitialized' }
  | { kind: 'exception' | 'rethrow'; type?: string; groupTypes?: string[]; source?: DataExpr }
  | { kind: 'exception-match'; type: string }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'non-null'; type: string; sources?: DataExpr[] }
  | { kind: 'unknown'; sources?: DataExpr[] }
  | { kind: 'variable' | 'temporary'; key: string }
  | { kind: 'entity'; target: string }
  | { kind: 'allocation'; id: string; fields: Array<[string, DataExpr]>; open: boolean; copy?: boolean; typeName?: string }
  | { kind: 'member'; object: DataExpr; property: string }
  | { kind: 'unary'; operator: string; value: DataExpr }
  | { kind: 'binary'; operator: string; left: DataExpr; right: DataExpr }
  | { kind: 'call'; callee: DataExpr; arguments: DataExpr[]; receiver?: DataExpr; argumentsKnown?: boolean; target?: string;
      argumentNames?: Array<string | undefined>; keywordArguments?: boolean[]; external?: ExternalSymbol; model?: ModelSelection };

export type FlowLocation = { kind: 'variable'; key: string } | { kind: 'member'; object: DataExpr; property: string };
export interface FlowVariable {
  key: string;
  name: string;
  scope: number;
  category: 'local' | 'parameter' | 'external';
  initial: DataExpr;
  captured: boolean;
  /** Source type text when the frontend can identify it (used for Rust ownership heuristics). */
  typeName?: string;
  /** Project-level proof that the source type implements Rust `Copy`. */
  copy?: boolean;
}
export interface NodeEffect {
  resultKey: string;
  value: DataExpr;
  writes: Array<{ target: FlowLocation; value: DataExpr }>;
  deletes: string[];
  /** 알 수 없는 호출의 외부 효과. summary/model 없이 pure라고 가정하지 않는다. */
  mayCall: boolean;
  mayMutateLocals?: boolean;
  guard?: DataExpr;
  /** Rust pattern binding borrowed the scrutinee instead of consuming it. */
  borrowedPattern?: boolean;
}
export interface DataflowDiagnostic {
  code: 'unsupported-effect' | 'partial-cfg' | 'iteration-budget' | 'state-budget' | 'work-budget';
  message: string;
  node?: number;
}
export interface DataflowFacts {
  parameters?: Array<{ key?: string; name?: string; index: number; receiver: boolean; typeName?: string; copy?: boolean }>;
  /** Statically proven local Python exception class parents. */
  exceptionParents?: Record<string, string[]>;
  variables: FlowVariable[];
  effects: Record<number, NodeEffect>;
  diagnostics: DataflowDiagnostic[];
}
