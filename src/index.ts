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
export { scanRepository, extractEntities } from './registry/entityScanner.js';
export type { ScanResult, ExtractedEntity } from './registry/entityScanner.js';

// BS Detector
export { scanRepository as scanBs, scanFile as scanFileForBs, scanFileContent, aggregateResults } from './registry/bsDetector.js';
export type { BsIssue, BsScanResult, BsSeverity } from './registry/bsDetector.js';

// Ignore Rules
export { buildIgnoreConfig, shouldSkipDir, BUILTIN_SKIP_DIRS } from './registry/ignoreRules.js';
export type { IgnoreConfig } from './registry/ignoreRules.js';

// i18n
export { setLocale, getLocale, detectLocale, t } from './i18n.js';
export type { Locale } from './i18n.js';
