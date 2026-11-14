import type { ModelReference, ResourceContract } from './libraryModels.js';

export interface SummaryParameter {
  key: string;
  name: string;
  index: number;
  receiver: boolean;
}
export interface FunctionSummary {
  owner: string;
  filePath: string;
  completeness: 'complete' | 'partial';
  reasons: string[];
  parameters: SummaryParameter[];
  returnAtoms: string[];
  returnParameters: string[];
  mayReturn: boolean;
  mayThrow: boolean;
  throwParameters: string[];
  effects: { heap: boolean; bindings: string[]; parameters: string[]; unknown: boolean };
  /** Explicit API lifecycle contract; absent means resource state is unknown. */
  resource?: ResourceContract;
  /** A wrapper summary may return a fresh resource created inside the callee. */
  returnsResource?: { source: 'fresh'; enter?: 'same' | 'unknown' } | { source: 'parameter'; parameter: number; enter?: 'same' | 'unknown' };
  /** A wrapper summary may return the exact value of one formal parameter. */
  returnsParameter?: number;
  /** A wrapper summary may release one of its formal resource parameters. */
  releasesResource?: { parameter: number };
  /** Explicit ownership contract for formal parameters consumed by the callee. */
  movesParameters?: number[];
  /** Explicit ownership contract for formal parameters borrowed by the callee. */
  borrowsParameters?: number[];
  /** Formal parameters registered as callbacks by this function. */
  callbackParameters?: Array<number | 'last'>;
  /** Explicit callback invocation input mapping for modeled schedulers. */
  callbackInvocations?: Array<{ callbackParameter: number | 'last'; argumentParameters: number[]; variadicArgumentFrom?: number; variadicArgumentParameters?: number[]; taintArgumentPositions?: number[] }>;
  /** Explicit model source/sink labels; no name-based taint inference. */
  taintSource?: boolean;
  taintSinkParameters?: number[];
  /** Explicit model inputs whose taint is preserved on the return value. */
  taintReturnParameters?: number[];
  /** Explicit model contract preserving taint from variadic arguments. */
  taintReturnVariadic?: boolean;
  /** Explicit model inputs whose taint is removed by a sanitizer. */
  taintSanitizesParameters?: number[];
  component: number;
  iterations: number;
  models?: ModelReference[];
}
