import type { ExtractedEntity, ReferenceSet } from '../registry/entityScanner.js';
import type { SymbolFacts } from '../analysis/symbols.js';

export type ParserMode = 'auto' | 'ast' | 'lexical';
export type AstLanguage = 'typescript' | 'python' | 'rust';

export interface FrontendDiagnostic {
  code: 'parser-unavailable' | 'unsupported-language' | 'syntax-error';
  filePath: string;
  message: string;
  line?: number;
  column?: number;
}

export interface FrontendResult {
  engine: 'ast' | 'lexical';
  entities: ExtractedEntity[];
  references: Map<string, ReferenceSet>;
  diagnostics: FrontendDiagnostic[];
  symbols?: SymbolFacts;
}

export interface LanguageFrontend {
  readonly language: AstLanguage;
  extract(content: string, filePath: string): FrontendResult;
}

export class FrontendError extends Error {
  constructor(readonly diagnostic: FrontendDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message}${diagnostic.line ? ` (${diagnostic.line}:${diagnostic.column})` : ''}`);
    this.name = 'FrontendError';
  }
}

export function parserMode(value = process.env.CXT_PARSER ?? 'auto'): ParserMode {
  if (value === 'auto' || value === 'ast' || value === 'lexical') return value;
  throw new Error(`Invalid CXT_PARSER: ${value}; expected auto, ast, or lexical`);
}

export function entityQualifiedName(entity: ExtractedEntity): string {
  return `${entity.filePath}::${entity.scopedName ?? entity.name}`;
}
