export type DataExpr =
  | { kind: 'undefined' | 'null' | 'unit' | 'uninitialized' | 'exception' }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'non-null'; type: string; sources?: DataExpr[] }
  | { kind: 'unknown'; sources?: DataExpr[] }
  | { kind: 'variable' | 'temporary'; key: string }
  | { kind: 'entity'; target: string }
  | { kind: 'allocation'; id: string; fields: Array<[string, DataExpr]>; open: boolean }
  | { kind: 'member'; object: DataExpr; property: string }
  | { kind: 'unary'; operator: string; value: DataExpr }
  | { kind: 'binary'; operator: string; left: DataExpr; right: DataExpr }
  | { kind: 'call'; callee: DataExpr; arguments: DataExpr[]; receiver?: DataExpr; argumentsKnown?: boolean; target?: string };

export type FlowLocation = { kind: 'variable'; key: string } | { kind: 'member'; object: DataExpr; property: string };
export interface FlowVariable {
  key: string;
  name: string;
  scope: number;
  category: 'local' | 'parameter' | 'external';
  initial: DataExpr;
  captured: boolean;
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
}
export interface DataflowDiagnostic {
  code: 'unsupported-effect' | 'partial-cfg' | 'iteration-budget' | 'state-budget' | 'work-budget';
  message: string;
  node?: number;
}
export interface DataflowFacts {
  parameters?: Array<{ key?: string; name?: string; index: number; receiver: boolean }>;
  variables: FlowVariable[];
  effects: Record<number, NodeEffect>;
  diagnostics: DataflowDiagnostic[];
}
