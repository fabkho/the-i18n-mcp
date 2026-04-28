// Public API — re-export everything the MCP package (and other consumers) need

// Core operations
export {
  detectConfig,
  listLocaleDirs,
  getTranslations,
  addTranslations,
  updateTranslations,
  getMissingTranslations,
  findEmptyTranslations,
  searchTranslations,
  removeTranslations,
  renameTranslationKey,
  translateMissing,
  findOrphanKeysOp,
  scanCodeUsageOp,
  cleanupUnusedTranslations,
  scaffoldLocaleFiles,
  findLocaleImpl,
  // Shared helpers re-exported for tests and MCP
  computeProgressTotal,
  computeMaxTokens,
  resolveSamplingPreferences,
  validateReportPath,
  buildTranslationSystemPrompt,
  buildTranslationUserMessage,
  extractJsonFromResponse,
  DEFAULT_SAMPLING_PREFERENCES,
} from './core/operations.js'

// Core types
export * from './core/types.js'

// Config
export { detectI18nConfig, getCachedConfig, clearConfigCache } from './config/detector.js'
export type { I18nConfig, LocaleDefinition, LocaleDir, ProjectConfig } from './config/types.js'

// IO
export { readLocaleData } from './io/locale-data.js'

// Errors
export { ToolError, ConfigError, FileIOError } from './utils/errors.js'
