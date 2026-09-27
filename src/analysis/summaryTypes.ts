import type { ModelReference } from './libraryModels.js';

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
  component: number;
  iterations: number;
  models?: ModelReference[];
}
