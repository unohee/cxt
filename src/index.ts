// ============================================
// ctx - Public API
// Created: 2026-04-11
// Purpose: 코드 엔티티 레지스트리 퍼블릭 API
// ============================================

// Store
export {
  SqliteRegistryStore,
  getRegistryStore,
  closeRegistryStore,
} from './registry/sqliteStore.js';
export type { RegisterEntityInput, UpdateEntityInput } from './registry/sqliteStore.js';

// Types
export type {
  EntityKind, EntityStatus, RiskLevel,
  WarningSeverity, WarningCategory, RelationType,
  EntityEventType, EntityTag, EntityWarning, EntityRelation,
  EntityEvent, CodeEntity, CodeEntityFilter,
  FileBrief, RegistryStats,
} from './registry/schema.js';

// Scanner
export { scanRepository, extractEntities, extractFile } from './registry/entityScanner.js';
export type { ScanResult, ExtractedEntity, Language } from './registry/entityScanner.js';
export type { LanguageFrontend, FrontendResult, FrontendDiagnostic, ParserMode } from './frontend/types.js';

// Symbol resolution
export { resolveSymbols } from './analysis/resolveSymbols.js';
export type { SymbolResolution } from './analysis/resolveSymbols.js';
export type { SymbolFacts, SymbolValue, CallSite, ResolvedCallSite, ResolutionReason } from './analysis/symbols.js';
export { reachableNodes, buildBasicBlocks } from './analysis/cfg.js';
export type { ControlFlowGraph, CfgNode, CfgEdge, CfgDiagnostic, SourceSpan, BasicBlock } from './analysis/cfg.js';
export { analyzeDataflow } from './analysis/dataflow.js';
export { analyzeSummaries } from './analysis/summaries.js';
export type { SummaryAnalysis } from './analysis/summaries.js';
export type { FunctionSummary, SummaryParameter } from './analysis/summaryTypes.js';
export { parameterImpact } from './analysis/parameterImpact.js';
export type { ParameterImpact, ImpactStep } from './analysis/parameterImpact.js';
export type { DataflowResult, AbstractValue, FlowDefinition, FlowUse } from './analysis/dataflow.js';
export { LibraryModelCatalog, loadLibraryModels, modelPackSchema, modelConfigSchema, standardModelPack } from './analysis/libraryModels.js';
export type { LibraryModel, ModelPack, ModelConfig, ModelManifest, ModelReference, ModelApplication } from './analysis/libraryModels.js';
export type { DataflowFacts, DataflowDiagnostic, DataExpr, NodeEffect, FlowVariable, FlowLocation } from './analysis/dataflowTypes.js';

// BS Detector
export { scanRepository as scanBs, scanFile as scanFileForBs, scanFileContent, aggregateResults } from './registry/bsDetector.js';
export { analyzeFileContent, scanLegacyFileContent } from './registry/bsDetector.js';
export { toSarif } from './analysis/sarif.js';
export { analysisOutcome, bsOutcome, scanOutcome, fingerprintFindings } from './analysis/report.js';
export { builtInRules, builtInRulePack, rulePackSchema, ruleConfigSchema } from './analysis/rulePack.js';
export type { BsIssue, BsScanResult, BsSeverity } from './registry/bsDetector.js';

// Ignore Rules
export { buildIgnoreConfig, shouldSkipDir, BUILTIN_SKIP_DIRS } from './registry/ignoreRules.js';
export type { IgnoreConfig } from './registry/ignoreRules.js';

// i18n
export { setLocale, getLocale, detectLocale, t } from './i18n.js';
export type { Locale } from './i18n.js';
