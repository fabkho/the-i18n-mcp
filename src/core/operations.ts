/**
 * Core i18n operations — pure async functions with no MCP dependency.
 *
 * Each function accepts plain parameters and returns plain objects.
 * Errors are thrown (ToolError etc.) rather than returned as isError responses.
 */

import { resolve } from 'node:path'
import { readdir } from 'node:fs/promises'

import { detectI18nConfig, clearConfigCache } from '../config/detector.js'
import type { I18nConfig, LocaleDefinition, LocaleDir, ProjectConfig } from '../config/types.js'
import type { LocaleFileFormat } from '../adapters/types.js'
import { writeReportFile } from '../io/json-writer.js'
import { readLocaleData, mutateLocaleData, resolveLocaleEntries } from '../io/locale-data.js'
import {
  getNestedValue,
  setNestedValue,
  hasNestedKey,
  getLeafKeys,
  removeNestedValue,
  renameNestedKey,
  validateTranslationValue,
} from '../io/key-operations.js'
import { scanSourceFiles, toRelativePath, findOrphanKeysForConfig } from '../scanner/code-scanner.js'
import { getPatternSet } from '../scanner/patterns.js'
import { log } from '../utils/logger.js'
import { ToolError } from '../utils/errors.js'
import { scaffoldLocale } from '../tools/scaffold-locale.js'

import type {
  LocaleDirInfo,
  MutationResult,
  SearchMatch,
  SamplingFn,
  ProgressFn,
  SamplingPreferences,
  TranslateMissingLocaleResult,
  AddTranslationsResult,
  UpdateTranslationsResult,
} from './types.js'

// ─── Constants ──────────────────────────────────────────────────

export const DEFAULT_SAMPLING_PREFERENCES: SamplingPreferences = {
  hints: [{ name: 'flash' }, { name: 'haiku' }, { name: 'gpt-4o-mini' }],
  costPriority: 0.8,
  speedPriority: 0.9,
  intelligencePriority: 0.3,
}

const DEFAULT_REPORT_DIR = '.i18n-reports'

// ─── Shared helpers (exported for reuse) ────────────────────────

export function resolveSamplingPreferences(projectConfig?: ProjectConfig): SamplingPreferences {
  const userPrefs = projectConfig?.samplingPreferences
  if (!userPrefs) return DEFAULT_SAMPLING_PREFERENCES
  return {
    hints: userPrefs.hints?.map(name => ({ name })) ?? DEFAULT_SAMPLING_PREFERENCES.hints,
    costPriority: userPrefs.costPriority ?? DEFAULT_SAMPLING_PREFERENCES.costPriority,
    speedPriority: userPrefs.speedPriority ?? DEFAULT_SAMPLING_PREFERENCES.speedPriority,
    intelligencePriority: userPrefs.intelligencePriority ?? DEFAULT_SAMPLING_PREFERENCES.intelligencePriority,
  }
}

/**
 * Compute maxTokens for a sampling request based on batch key count.
 * Scales linearly (40 tokens per key + 512 base) capped at 16384.
 */
export function computeMaxTokens(batchKeyCount: number): number {
  return Math.min(16384, batchKeyCount * 40 + 512)
}

/**
 * Compute the total number of progress steps for translate_missing.
 */
export function computeProgressTotal(missingKeyCounts: number[], maxBatch: number): number {
  return missingKeyCounts.reduce((sum, count) => {
    if (count <= 0) return sum
    return sum + Math.ceil(count / maxBatch) + 2
  }, 0)
}

export function validateReportPath(baseDir: string, absPath: string): void {
  const normalizedBase = resolve(baseDir)
  const normalizedPath = resolve(absPath)
  if (normalizedPath !== normalizedBase && !normalizedPath.startsWith(normalizedBase + '/')) {
    throw new ToolError(
      `Report path "${absPath}" resolves outside the project directory. Path must stay within "${normalizedBase}".`,
      'INVALID_REPORT_PATH',
    )
  }
}

export function resolveReportFilePath(
  config: I18nConfig,
  dir: string,
  toolName: string,
): string | undefined {
  const reportOutput = config.projectConfig?.reportOutput
  if (!reportOutput) return undefined
  const relDir = reportOutput === true ? DEFAULT_REPORT_DIR : reportOutput
  const absPath = resolve(dir, relDir, `${toolName}.json`)
  validateReportPath(dir, absPath)
  return absPath
}

export function resolveOrphanIgnorePatterns(
  config: I18nConfig,
  layer: string | undefined,
): string[] | undefined {
  if (!layer || !config.projectConfig?.orphanScan) return undefined
  const layerConfig = config.projectConfig.orphanScan[layer]
  if (!layerConfig?.ignorePatterns?.length) return undefined
  return layerConfig.ignorePatterns
}

/**
 * Look up a locale directory by layer name and throw LAYER_NOT_FOUND with fuzzy
 * matching hints if the name is not found.
 */
export function findLayerOrThrow(config: I18nConfig, layer: string): LocaleDir {
  const localeDir = config.localeDirs.find(d => d.layer === layer)
  if (!localeDir) {
    const available = config.localeDirs.map(d => d.layer).join(', ')
    const layerRule = config.projectConfig?.layerRules?.find(r => r.layer === layer)
    const fuzzyHint = layerRule
      ? ` Note: "${layer}" matches a layerRules entry in .i18n-mcp.json but is not an internal layer name.`
      : ''
    throw new ToolError(
      `Layer not found: "${layer}". Available: ${available}.${fuzzyHint} Use list_locale_dirs to see all layers.`,
      'LAYER_NOT_FOUND',
    )
  }
  return localeDir
}

export function findLocaleImpl(config: I18nConfig, localeRef: string) {
  return config.locales.find(
    l => l.code === localeRef || l.file === localeRef || l.language === localeRef,
  )
}

export function findLocaleOrThrow(config: I18nConfig, localeRef: string, _paramName = 'locale'): LocaleDefinition {
  const locale = findLocaleImpl(config, localeRef)
  if (!locale) {
    throw new ToolError(
      `Locale not found: "${localeRef}". Available: ${config.locales.map(l => l.code).join(', ')}. Use one of the available locale codes or file names.`,
      'LOCALE_NOT_FOUND',
    )
  }
  return locale
}

/**
 * Shared logic for add_translations and update_translations.
 */
export async function applyTranslations(
  config: I18nConfig,
  layer: string,
  translations: Record<string, Record<string, string>>,
  mode: 'add' | 'update',
  findLocale: (config: I18nConfig, ref: string) => LocaleDefinition | undefined,
  dryRun = false,
): Promise<MutationResult> {
  const applied: string[] = []
  const skipped: string[] = []
  const warnings: string[] = []
  const filesWritten = new Set<string>()
  const preview: Array<{ locale: string; key: string; value: string }> = []

  const byLocale = new Map<LocaleDefinition, Array<{ key: string; value: string }>>()

  for (const [key, localeValues] of Object.entries(translations)) {
    for (const [localeRef, value] of Object.entries(localeValues)) {
      if (mode === 'add') {
        const warning = validateTranslationValue(value)
        if (warning) {
          warnings.push(`${key} (${localeRef}): ${warning}`)
        }
      }
      const locale = findLocale(config, localeRef)
      if (!locale) {
        log.warn(`Locale not found: ${localeRef}, skipping`)
        continue
      }
      if (!byLocale.has(locale)) {
        byLocale.set(locale, [])
      }
      byLocale.get(locale)!.push({ key, value })
    }
  }

  for (const [locale, entries] of byLocale) {
    if (dryRun) {
      const data = await readLocaleData(config, layer, locale)
      for (const { key, value } of entries) {
        const exists = hasNestedKey(data, key)
        if (mode === 'add' && exists) {
          skipped.push(key)
        } else if (mode === 'update' && !exists) {
          skipped.push(key)
        } else {
          applied.push(key)
          preview.push({ locale: locale.code, key, value })
        }
      }
    } else {
      const written = await mutateLocaleData(config, layer, locale, (data) => {
        for (const { key, value } of entries) {
          const exists = hasNestedKey(data, key)
          if (mode === 'add' && exists) {
            skipped.push(key)
          } else if (mode === 'update' && !exists) {
            skipped.push(key)
          } else {
            setNestedValue(data, key, value)
            applied.push(key)
          }
        }
      })
      for (const f of written) filesWritten.add(f)
    }
  }

  const result: MutationResult = {
    applied: [...new Set(applied)],
    skipped: [...new Set(skipped)],
    warnings,
    filesWritten: filesWritten.size,
  }

  if (dryRun) {
    result.preview = preview
  }

  return result
}

// ─── Sampling prompt helpers ────────────────────────────────────

function placeholderInstruction(format?: LocaleFileFormat): string {
  if (format === 'php-array') {
    return 'Preserve all :placeholder parameters exactly as-is.'
  }
  return 'Preserve all {placeholder} parameters and @:linked.message references.'
}

export function buildTranslationSystemPrompt(
  projectConfig: ProjectConfig | undefined,
  targetLocaleCode: string,
  localeFileFormat?: LocaleFileFormat,
): string {
  const parts: string[] = [
    `You are a professional translator for software UI strings. ${placeholderInstruction(localeFileFormat)} Be concise — UI space is limited.`,
  ]

  if (projectConfig?.translationPrompt) {
    parts.push(projectConfig.translationPrompt)
  }

  if (projectConfig?.glossary && Object.keys(projectConfig.glossary).length > 0) {
    const glossaryLines = Object.entries(projectConfig.glossary)
      .map(([term, definition]) => `- ${term} → ${definition}`)
      .join('\n')
    parts.push(`GLOSSARY — use these terms consistently:\n${glossaryLines}`)
  }

  if (projectConfig?.localeNotes?.[targetLocaleCode]) {
    parts.push(`TARGET LOCALE NOTE (${targetLocaleCode}): ${projectConfig.localeNotes[targetLocaleCode]}`)
  }

  if (projectConfig?.examples && projectConfig.examples.length > 0) {
    const exampleLines = projectConfig.examples
      .map((ex) => {
        const pairs = Object.entries(ex)
          .filter(([k]) => k !== 'key' && k !== 'note')
          .map(([locale, val]) => `${locale}: "${val}"`)
          .join(', ')
        const note = ex.note ? ` (${ex.note})` : ''
        return `- ${ex.key}: ${pairs}${note}`
      })
      .join('\n')
    parts.push(`STYLE EXAMPLES:\n${exampleLines}`)
  }

  parts.push('Return ONLY a JSON object mapping keys to translated values. No markdown, no explanation, no code fences.')

  return parts.join('\n\n')
}

export function buildTranslationUserMessage(
  referenceLocaleCode: string,
  targetLocaleCode: string,
  keysAndValues: Record<string, string>,
  localeFileFormat?: LocaleFileFormat,
): string {
  return [
    `Translate the following i18n key-value pairs from ${referenceLocaleCode} to ${targetLocaleCode}.`,
    placeholderInstruction(localeFileFormat),
    '',
    JSON.stringify(keysAndValues),
  ].join('\n')
}

export function extractJsonFromResponse(responseText: string): Record<string, unknown> {
  const trimmed = responseText.trim()

  // Tier 1: direct parse
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {}

  // Tier 2: strip markdown code fences
  if (trimmed.startsWith('```')) {
    const stripped = trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    try {
      return JSON.parse(stripped) as Record<string, unknown>
    } catch {}
  }

  // Tier 3: balanced bracket extraction — find first complete {...}
  const start = trimmed.indexOf('{')
  if (start !== -1) {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\' && inString) {
        escape = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1)
          return JSON.parse(candidate) as Record<string, unknown>
        }
      }
    }
  }

  throw new Error('No valid JSON object found in response')
}

export function buildFallbackContext(
  projectConfig: ProjectConfig | undefined,
  referenceLocaleCode: string,
  targetLocaleCode: string,
  keysAndValues: Record<string, string>,
): Record<string, unknown> {
  const context: Record<string, unknown> = {
    instruction: `Translate these keys from ${referenceLocaleCode} to ${targetLocaleCode}, then call add_translations to write them.`,
    referenceLocale: referenceLocaleCode,
    targetLocale: targetLocaleCode,
    keysToTranslate: keysAndValues,
  }

  if (projectConfig?.translationPrompt) {
    context.translationPrompt = projectConfig.translationPrompt
  }
  if (projectConfig?.glossary && Object.keys(projectConfig.glossary).length > 0) {
    context.glossary = projectConfig.glossary
  }
  if (projectConfig?.localeNotes?.[targetLocaleCode]) {
    context.localeNote = projectConfig.localeNotes[targetLocaleCode]
  }
  if (projectConfig?.examples && projectConfig.examples.length > 0) {
    context.examples = projectConfig.examples
  }

  return context
}

// ─── Operations ─────────────────────────────────────────────────

/**
 * Detect the i18n configuration from the project.
 */
export async function detectConfig(projectDir?: string): Promise<I18nConfig> {
  const dir = projectDir ?? process.cwd()
  clearConfigCache()
  return detectI18nConfig(dir)
}

/**
 * List all i18n locale directories in the project, grouped by layer.
 */
export async function listLocaleDirs(projectDir?: string): Promise<LocaleDirInfo[]> {
  const dir = projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  const results: LocaleDirInfo[] = []

  for (const localeDir of config.localeDirs) {
    if (localeDir.aliasOf) {
      results.push({
        layer: localeDir.layer,
        path: localeDir.path,
        aliasOf: localeDir.aliasOf,
        fileCount: 0,
        topLevelKeys: [],
      })
      continue
    }

    if (config.localeFileFormat === 'php-array') {
      let subDirs: string[] = []
      try { subDirs = await readdir(localeDir.path) } catch {}

      const sampleLocale = config.locales[0]
      let namespaces: string[] = []
      if (sampleLocale) {
        try {
          const entries = await resolveLocaleEntries(config, localeDir.layer, sampleLocale)
          namespaces = entries.map(e => e.namespace).filter((n): n is string => n !== null)
        } catch {}
      }

      results.push({
        layer: localeDir.layer,
        path: localeDir.path,
        fileCount: subDirs.length,
        namespaces,
      })
    } else {
      const files = await readdir(localeDir.path)
      const jsonFiles = files.filter(f => f.endsWith('.json'))

      let topLevelKeys: string[] = []
      if (config.locales.length > 0 && jsonFiles.length > 0) {
        try {
          const sampleLocale = config.locales[0]
          const data = await readLocaleData(config, localeDir.layer, sampleLocale)
          topLevelKeys = Object.keys(data)
        } catch {}
      }

      results.push({
        layer: localeDir.layer,
        path: localeDir.path,
        fileCount: jsonFiles.length,
        topLevelKeys,
      })
    }
  }

  return results
}

/**
 * Get translation values for given key paths from a specific locale and layer.
 */
export async function getTranslations(opts: {
  layer: string
  locale: string
  keys: string[]
  projectDir?: string
}): Promise<Record<string, Record<string, unknown>>> {
  const { layer, locale, keys } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  const localesToRead = locale === '*'
    ? config.locales
    : (() => {
        const found = findLocaleImpl(config, locale)
        if (!found) {
          throw new ToolError(`Locale not found: "${locale}". Available: ${config.locales.map(l => l.code).join(', ')}. Use one of the available locale codes or file names.`, 'LOCALE_NOT_FOUND')
        }
        return [found]
      })()

  const results: Record<string, Record<string, unknown>> = {}

  for (const loc of localesToRead) {
    try {
      const data = await readLocaleData(config, layer, loc)
      results[loc.code] = Object.fromEntries(
        keys.map(k => [k, getNestedValue(data, k) ?? null]),
      )
    } catch {
      results[loc.code] = Object.fromEntries(keys.map(k => [k, null]))
    }
  }

  return results
}

/**
 * Add new translation keys to the specified layer.
 */
export async function addTranslations(opts: {
  layer: string
  translations: Record<string, Record<string, string>>
  dryRun?: boolean
  projectDir?: string
}): Promise<AddTranslationsResult> {
  const { layer, translations } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  const isDryRun = opts.dryRun ?? false

  const { applied, skipped, warnings, filesWritten, preview } = await applyTranslations(
    config, layer, translations, 'add', findLocaleImpl, isDryRun,
  )

  if (isDryRun) {
    const result: AddTranslationsResult = {
      dryRun: true,
      wouldAdd: preview,
      skipped,
      summary: {
        keysToAdd: applied.length,
        keysSkipped: skipped.length,
        message: 'Call again with dryRun: false to apply these changes.',
      },
    }
    if (skipped.length > 0) {
      result.skippedKeys = skipped
    }
    if (warnings.length > 0) {
      result.warnings = warnings
    }
    return result
  }

  const summary: AddTranslationsResult = {
    added: applied,
    skipped,
    filesWritten,
  }
  if (warnings.length > 0) {
    summary.warnings = warnings
  }

  return summary
}

/**
 * Update existing translation keys in the specified layer.
 */
export async function updateTranslations(opts: {
  layer: string
  translations: Record<string, Record<string, string>>
  dryRun?: boolean
  projectDir?: string
}): Promise<UpdateTranslationsResult> {
  const { layer, translations } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  const isDryRun = opts.dryRun ?? false

  const { applied, skipped, filesWritten, preview } = await applyTranslations(
    config, layer, translations, 'update', findLocaleImpl, isDryRun,
  )

  if (isDryRun) {
    const result: UpdateTranslationsResult = {
      dryRun: true,
      wouldUpdate: preview,
      skipped,
      summary: {
        keysToUpdate: applied.length,
        keysSkipped: skipped.length,
        message: 'Call again with dryRun: false to apply these changes.',
      },
    }
    if (skipped.length > 0) {
      result.skippedKeys = skipped
    }
    return result
  }

  return {
    updated: applied,
    skipped,
    filesWritten,
  }
}

/**
 * Find translation keys that exist in the reference locale but are missing in other locales.
 */
export async function getMissingTranslations(opts: {
  layer?: string
  referenceLocale?: string
  targetLocales?: string[]
  locales?: string[]
  projectDir?: string
}): Promise<Record<string, unknown>> {
  const { layer } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  // Determine reference locale
  const refCode = opts.referenceLocale ?? config.defaultLocale
  const refLocale = findLocaleImpl(config, refCode)
  if (!refLocale) {
    throw new ToolError(`Reference locale not found: "${refCode}". Available: ${config.locales.map(l => l.code).join(', ')}. Pass a valid locale code as referenceLocale, or omit it to use the project default.`, 'REFERENCE_LOCALE_NOT_FOUND')
  }

  // Determine target locales
  const resolvedTargets = opts.targetLocales ?? opts.locales
  const targets = resolvedTargets
    ? resolvedTargets.map((code) => {
        const loc = findLocaleImpl(config, code)
        if (!loc) {
          throw new ToolError(`Target locale not found: "${code}". Available: ${config.locales.map(l => l.code).join(', ')}. Pass valid locale codes in targetLocales.`, 'LOCALE_NOT_FOUND')
        }
        return loc
      })
    : config.locales.filter(l => l.code !== refLocale.code)

  // Determine layers to scan
  const layersToScan = layer
    ? config.localeDirs.filter(d => d.layer === layer)
    : config.localeDirs.filter(d => !d.aliasOf)

  if (layersToScan.length === 0) {
    if (layer) {
      findLayerOrThrow(config, layer)
    }
    throw new ToolError('No locale directories found. Run detect_i18n_config to verify the project setup.', 'LAYER_NOT_FOUND')
  }

  const result: Record<string, Record<string, string[]>> = {}
  let totalMissing = 0

  for (const localeDir of layersToScan) {
    let refData: Record<string, unknown>
    try {
      refData = await readLocaleData(config, localeDir.layer, refLocale)
    } catch {
      continue
    }
    if (Object.keys(refData).length === 0) continue

    const refKeys = getLeafKeys(refData).filter(k => {
      const v = getNestedValue(refData, k)
      return typeof v === 'string' ? v.length > 0 : v !== null && v !== undefined
    })
    if (refKeys.length === 0) continue

    for (const target of targets) {
      let targetData: Record<string, unknown> = {}

      try {
        targetData = await readLocaleData(config, localeDir.layer, target)
      } catch {}

      const missing = refKeys.filter(k => {
        const v = getNestedValue(targetData, k)
        return v === undefined || v === '' || v === null
      })

      if (missing.length > 0) {
        if (!result[target.code]) {
          result[target.code] = {}
        }
        result[target.code][localeDir.layer] = missing
        totalMissing += missing.length
      }
    }
  }

  const output = {
    missing: result,
    summary: {
      referenceLocale: refLocale.code,
      targetLocales: targets.map(t => t.code),
      layersScanned: layersToScan.map(d => d.layer),
      totalMissingKeys: totalMissing,
    },
  }

  const reportPath = resolveReportFilePath(config, dir, 'get_missing_translations')
  if (reportPath) {
    await writeReportFile(reportPath, output, {
      tool: 'get_missing_translations',
      args: { layer, referenceLocale: opts.referenceLocale, targetLocales: opts.targetLocales },
    })
    return { reportFile: reportPath, summary: output.summary }
  }

  return output
}

/**
 * Find translation keys that have empty string values in locale files.
 */
export async function findEmptyTranslations(opts: {
  layer?: string
  locale?: string
  projectDir?: string
}): Promise<Record<string, unknown>> {
  const { layer, locale } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  // Determine locales to check
  const localesToCheck = locale
    ? (() => {
        const loc = findLocaleImpl(config, locale)
        if (!loc) {
          throw new ToolError(
            `Locale not found: "${locale}". Available: ${config.locales.map(l => l.code).join(', ')}`,
            'LOCALE_NOT_FOUND',
          )
        }
        return [loc]
      })()
    : config.locales

  // Determine layers to scan
  const layersToScan = layer
    ? config.localeDirs.filter(d => d.layer === layer)
    : config.localeDirs.filter(d => !d.aliasOf)

  if (layersToScan.length === 0) {
    if (layer) {
      findLayerOrThrow(config, layer)
    }
    throw new ToolError('No locale directories found.', 'LAYER_NOT_FOUND')
  }

  const emptyKeys: Record<string, Record<string, string[]>> = {}
  let totalEmpty = 0

  for (const localeDir of layersToScan) {
    for (const loc of localesToCheck) {
      let data: Record<string, unknown>
      try {
        data = await readLocaleData(config, localeDir.layer, loc)
      } catch {
        continue
      }
      if (Object.keys(data).length === 0) continue

      const leafKeys = getLeafKeys(data)
      const empty = leafKeys.filter(k => getNestedValue(data, k) === '')

      if (empty.length > 0) {
        if (!emptyKeys[loc.code]) emptyKeys[loc.code] = {}
        emptyKeys[loc.code][localeDir.layer] = empty
        totalEmpty += empty.length
      }
    }
  }

  const output = {
    emptyKeys,
    summary: {
      totalEmpty,
      localesChecked: localesToCheck.map(l => l.code),
      layersChecked: layersToScan.map(d => d.layer),
    },
  }

  const reportPath = resolveReportFilePath(config, dir, 'find_empty_translations')
  if (reportPath) {
    await writeReportFile(reportPath, output, {
      tool: 'find_empty_translations',
      args: { layer, locale },
    })
    return { reportFile: reportPath, summary: output.summary }
  }

  return output
}

/**
 * Search translation files by key pattern or value substring.
 */
export async function searchTranslations(opts: {
  query: string
  searchIn?: 'keys' | 'values' | 'both'
  layer?: string
  locale?: string
  projectDir?: string
}): Promise<{ matches: SearchMatch[]; totalMatches: number }> {
  const { query, layer, locale } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  const mode = opts.searchIn ?? 'both'
  const queryLower = query.toLowerCase()

  // Determine layers to search
  const layersToSearch = layer
    ? config.localeDirs.filter(d => d.layer === layer)
    : config.localeDirs.filter(d => !d.aliasOf)

  if (layersToSearch.length === 0) {
    if (layer) {
      findLayerOrThrow(config, layer)
    }
    throw new ToolError('No locale directories found. Run detect_i18n_config to verify the project setup.', 'LAYER_NOT_FOUND')
  }

  // Determine locales to search
  const localesToSearch = locale
    ? (() => {
        const found = findLocaleImpl(config, locale)
        if (!found) {
          throw new ToolError(`Locale not found: "${locale}". Available: ${config.locales.map(l => l.code).join(', ')}. Use one of the available locale codes or file names.`, 'LOCALE_NOT_FOUND')
        }
        return [found]
      })()
    : config.locales

  const matches: SearchMatch[] = []

  for (const localeDir of layersToSearch) {
    for (const loc of localesToSearch) {
      let data: Record<string, unknown>
      try {
        data = await readLocaleData(config, localeDir.layer, loc)
      } catch {
        continue
      }
      if (Object.keys(data).length === 0) continue

      const leafKeys = getLeafKeys(data)

      for (const key of leafKeys) {
        const value = getNestedValue(data, key)
        const valueStr = typeof value === 'string' ? value : JSON.stringify(value)

        const keyMatch = mode === 'keys' || mode === 'both'
          ? key.toLowerCase().includes(queryLower)
          : false
        const valueMatch = mode === 'values' || mode === 'both'
          ? valueStr.toLowerCase().includes(queryLower)
          : false

        if (keyMatch || valueMatch) {
          matches.push({
            layer: localeDir.layer,
            locale: loc.code,
            key,
            value,
          })
        }
      }
    }
  }

  return { matches, totalMatches: matches.length }
}

/**
 * Remove one or more translation keys from ALL locale files in the specified layer.
 */
export async function removeTranslations(opts: {
  layer: string
  keys: string[]
  dryRun?: boolean
  projectDir?: string
}): Promise<Record<string, unknown>> {
  const { layer, keys } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  const isDryRun = opts.dryRun ?? false

  const localeDir = findLayerOrThrow(config, layer)
  if (localeDir.aliasOf) {
    throw new ToolError(`Layer "${layer}" is an alias of "${localeDir.aliasOf}". Modify the source layer "${localeDir.aliasOf}" instead.`, 'LAYER_IS_ALIAS')
  }

  const preview: Array<{ locale: string; key: string; oldValue: unknown }> = []
  const removed: string[] = []
  const notFound: string[] = []
  const filesWritten = new Set<string>()

  for (const locale of config.locales) {
    let data: Record<string, unknown>
    try {
      data = await readLocaleData(config, layer, locale)
    } catch {
      continue
    }
    if (Object.keys(data).length === 0) continue

    if (isDryRun) {
      for (const key of keys) {
        const value = getNestedValue(data, key)
        if (value !== undefined) {
          preview.push({ locale: locale.code, key, oldValue: value })
        }
      }
    } else {
      const written = await mutateLocaleData(config, layer, locale, (fileData) => {
        for (const key of keys) {
          if (removeNestedValue(fileData, key)) {
            removed.push(`${locale.code}:${key}`)
          } else {
            notFound.push(`${locale.code}:${key}`)
          }
        }
      })
      for (const f of written) filesWritten.add(f)
    }
  }

  if (isDryRun) {
    return {
      dryRun: true,
      wouldRemove: preview,
      summary: {
        keysFound: preview.length,
        message: 'Call again with dryRun: false to apply these changes.',
      },
    }
  }

  const uniqueRemoved = [...new Set(removed.map(r => r.split(':')[1]))]
  return {
    removed: uniqueRemoved,
    removedPerLocale: removed,
    notFound: [...new Set(notFound)],
    filesWritten: filesWritten.size,
  }
}

/**
 * Rename/move a translation key across ALL locale files in a layer.
 */
export async function renameTranslationKey(opts: {
  layer: string
  oldKey: string
  newKey: string
  dryRun?: boolean
  projectDir?: string
}): Promise<Record<string, unknown>> {
  const { layer, oldKey, newKey } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  const isDryRun = opts.dryRun ?? false

  if (oldKey === newKey) {
    throw new ToolError(`Old key and new key are the same: "${oldKey}". Provide a different newKey to rename to.`, 'SAME_KEY')
  }

  const localeDir = findLayerOrThrow(config, layer)
  if (localeDir.aliasOf) {
    throw new ToolError(`Layer "${layer}" is an alias of "${localeDir.aliasOf}". Modify the source layer "${localeDir.aliasOf}" instead.`, 'LAYER_IS_ALIAS')
  }

  const preview: Array<{ locale: string; oldKey: string; newKey: string; value: unknown }> = []
  const renamed: string[] = []
  const notFoundArr: string[] = []
  const conflicts: string[] = []
  const filesWritten = new Set<string>()

  for (const locale of config.locales) {
    let data: Record<string, unknown>
    try {
      data = await readLocaleData(config, layer, locale)
    } catch {
      continue
    }
    if (Object.keys(data).length === 0) continue

    const oldValue = getNestedValue(data, oldKey)
    if (oldValue === undefined) {
      notFoundArr.push(locale.code)
      continue
    }

    if (hasNestedKey(data, newKey)) {
      conflicts.push(locale.code)
      continue
    }

    if (isDryRun) {
      preview.push({ locale: locale.code, oldKey, newKey, value: oldValue })
    } else {
      const written = await mutateLocaleData(config, layer, locale, (fileData) => {
        renameNestedKey(fileData, oldKey, newKey)
      })
      renamed.push(locale.code)
      for (const f of written) filesWritten.add(f)
    }
  }

  if (isDryRun) {
    const result: Record<string, unknown> = {
      dryRun: true,
      wouldRename: preview,
      summary: {
        localesAffected: preview.length,
        message: 'Call again with dryRun: false to apply these changes.',
      },
    }
    if (notFoundArr.length > 0) {
      result.notFoundInLocales = notFoundArr
    }
    if (conflicts.length > 0) {
      result.conflictsInLocales = conflicts
      result.summary = {
        ...(result.summary as Record<string, unknown>),
        warning: `New key "${newKey}" already exists in ${conflicts.length} locale(s). These will be skipped.`,
      }
    }
    return result
  }

  const summary: Record<string, unknown> = {
    renamed,
    filesWritten: filesWritten.size,
    oldKey,
    newKey,
  }
  if (notFoundArr.length > 0) {
    summary.notFoundInLocales = notFoundArr
  }
  if (conflicts.length > 0) {
    summary.skippedDueToConflict = conflicts
  }

  return summary
}

/**
 * Find keys missing in target locales and translate them.
 *
 * When samplingFn is provided, uses it to translate via LLM.
 * When samplingFn is absent, returns fallback contexts for the agent.
 */
export async function translateMissing(opts: {
  layer: string
  referenceLocale?: string
  targetLocales?: string[]
  locales?: string[]
  keys?: string[]
  batchSize?: number
  dryRun?: boolean
  projectDir?: string
  samplingFn?: SamplingFn
  progressFn?: ProgressFn
  /** Called once after the pre-scan with the computed total number of progress steps. */
  onProgressTotal?: (total: number) => void
}): Promise<Record<string, unknown>> {
  const { layer } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  const isDryRun = opts.dryRun ?? false
  const maxBatch = opts.batchSize ?? 50

  // Validate layer
  const localeDir = findLayerOrThrow(config, layer)
  if (localeDir.aliasOf) {
    throw new ToolError(`Layer "${layer}" is an alias of "${localeDir.aliasOf}". Modify the source layer "${localeDir.aliasOf}" instead.`, 'LAYER_IS_ALIAS')
  }

  // Determine reference locale
  const refCode = opts.referenceLocale ?? config.defaultLocale
  const refLocale = findLocaleImpl(config, refCode)
  if (!refLocale) {
    throw new ToolError(`Reference locale not found: "${refCode}". Available: ${config.locales.map(l => l.code).join(', ')}. Pass a valid locale code as referenceLocale, or omit it to use the project default.`, 'REFERENCE_LOCALE_NOT_FOUND')
  }

  const refData = await readLocaleData(config, layer, refLocale)
  if (Object.keys(refData).length === 0) {
    throw new ToolError(`No locale data found for reference locale "${refCode}" in layer "${layer}". Verify the layer exists and contains data for this locale using list_locale_dirs.`, 'NO_LOCALE_FILE')
  }
  const allRefKeys = getLeafKeys(refData).filter(k => {
    const v = getNestedValue(refData, k)
    return typeof v === 'string' ? v.length > 0 : v !== null && v !== undefined
  })

  const resolvedTargetLocales = opts.targetLocales ?? opts.locales
  const targets = resolvedTargetLocales
    ? resolvedTargetLocales.map((code) => {
        const loc = findLocaleImpl(config, code)
        if (!loc) {
          throw new ToolError(`Target locale not found: "${code}". Available: ${config.locales.map(l => l.code).join(', ')}. Pass valid locale codes in targetLocales.`, 'LOCALE_NOT_FOUND')
        }
        return loc
      })
    : config.locales.filter(l => l.code !== refLocale.code)

  const samplingSupported = !!opts.samplingFn
  const reportProgress = opts.progressFn ?? (async () => {})
  let samplingModelLogged = false

  // Pre-scan: count missing keys per target to compute progressTotal
  if (opts.onProgressTotal) {
    const preScanCounts: number[] = []
    for (const target of targets) {
      let scanData: Record<string, unknown> = {}
      try {
        scanData = await readLocaleData(config, layer, target)
      } catch {}
      const countMissing = (k: string): boolean => {
        const v = getNestedValue(scanData, k)
        return v === undefined || v === '' || v === null
      }
      const count = opts.keys
        ? opts.keys.filter(k => countMissing(k) && allRefKeys.includes(k)).length
        : allRefKeys.filter(k => countMissing(k)).length
      preScanCounts.push(count)
    }
    opts.onProgressTotal(computeProgressTotal(preScanCounts, maxBatch))
  }

  const results: Record<string, TranslateMissingLocaleResult> = {}
  const fallbackContexts: Record<string, Record<string, unknown>> = {}

  for (const target of targets) {
    let targetData: Record<string, unknown> = {}

    try {
      targetData = await readLocaleData(config, layer, target)
    } catch {}

    const isKeyMissing = (k: string): boolean => {
      const v = getNestedValue(targetData, k)
      return v === undefined || v === '' || v === null
    }

    let missingKeys: string[]
    if (opts.keys) {
      missingKeys = opts.keys.filter(k => isKeyMissing(k) && allRefKeys.includes(k))
    } else {
      missingKeys = allRefKeys.filter(k => isKeyMissing(k))
    }

    if (missingKeys.length === 0) {
      results[target.code] = { translated: [], failed: [], samplingUsed: false }
      continue
    }

    await reportProgress(`Starting ${target.code}: ${missingKeys.length} missing keys`)

    // Build key-value pairs from reference
    const keysAndValues: Record<string, string> = {}
    for (const key of missingKeys) {
      const value = getNestedValue(refData, key)
      if (typeof value === 'string') {
        keysAndValues[key] = value
      }
    }

    if (isDryRun) {
      results[target.code] = {
        translated: Object.keys(keysAndValues),
        failed: [],
        samplingUsed: samplingSupported,
      }
      await reportProgress(`Complete ${target.code} (dry run)`)
      continue
    }

    if (samplingSupported && opts.samplingFn) {
      const translated: string[] = []
      const failed: string[] = []
      const keyEntries = Object.entries(keysAndValues)
      const allTranslations: Record<string, string> = {}

      for (let i = 0; i < keyEntries.length; i += maxBatch) {
        const batchNum = Math.floor(i / maxBatch) + 1
        const batch = Object.fromEntries(keyEntries.slice(i, i + maxBatch))
        const totalBatches = Math.ceil(keyEntries.length / maxBatch)
        let batchTranslations: Record<string, string> | null = null

        const systemPrompt = buildTranslationSystemPrompt(config.projectConfig, target.language || target.code, config.localeFileFormat)
        const userMessage = buildTranslationUserMessage(
          refLocale.language || refLocale.code,
          target.language || target.code,
          batch,
          config.localeFileFormat,
        )

        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) {
            const delayMs = 2000 * Math.pow(2, attempt - 1)
            await new Promise(r => setTimeout(r, delayMs))
          }
          try {
            const samplingResult = await opts.samplingFn({
              systemPrompt,
              userMessage,
              maxTokens: computeMaxTokens(Object.keys(batch).length),
              preferences: resolveSamplingPreferences(config.projectConfig),
            })

            if (!samplingModelLogged) {
              log.info(`Sampling model: ${samplingResult.model}`)
              samplingModelLogged = true
            }

            const parsed = extractJsonFromResponse(samplingResult.text)
            const batchKeys = new Set(Object.keys(batch))
            batchTranslations = {} as Record<string, string>
            for (const [key, value] of Object.entries(parsed)) {
              if (batchKeys.has(key) && typeof value === 'string') {
                batchTranslations[key] = value
              }
            }
            break
          } catch (error) {
            if (attempt === 0) {
              log.warn(`Sampling failed for batch ${batchNum} in ${target.code}, retrying: ${error instanceof Error ? error.message : String(error)}`)
            } else {
              log.warn(`Sampling retry failed for batch ${batchNum} in ${target.code}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }

        if (batchTranslations !== null) {
          for (const [key, value] of Object.entries(batchTranslations)) {
            if (typeof value === 'string') {
              allTranslations[key] = value
              translated.push(key)
            }
          }
        } else {
          failed.push(...Object.keys(batch))
        }

        await reportProgress(`${target.code}: batch ${batchNum}/${totalBatches}`)
      }

      if (Object.keys(allTranslations).length > 0) {
        try {
          await mutateLocaleData(config, layer, target, (data) => {
            for (const [key, value] of Object.entries(allTranslations)) {
              setNestedValue(data, key, value)
            }
          })
        } catch (error) {
          log.warn(`Failed to write translations for ${target.code}: ${error instanceof Error ? error.message : String(error)}`)
          results[target.code] = { translated: [], failed: [...Object.keys(keysAndValues)], samplingUsed: true, writeError: error instanceof Error ? error.message : String(error) }
          continue
        }
      }

      results[target.code] = { translated, failed, samplingUsed: true }
    } else {
      // Fallback: return context for agent to translate inline
      fallbackContexts[target.code] = buildFallbackContext(
        config.projectConfig,
        refLocale.language || refLocale.code,
        target.language || target.code,
        keysAndValues,
      )
      results[target.code] = {
        translated: [],
        failed: Object.keys(keysAndValues),
        samplingUsed: false,
      }
    }

    await reportProgress(`Complete ${target.code}`)
  }

  const totalTranslated = Object.values(results).reduce((sum, r) => sum + r.translated.length, 0)
  const totalFailed = Object.values(results).reduce((sum, r) => sum + r.failed.length, 0)

  const output: Record<string, unknown> = {
    results,
    summary: {
      samplingSupported,
      totalTranslated,
      totalFailed,
      layer,
      referenceLocale: refLocale.code,
      targetLocales: targets.map(t => t.code),
      dryRun: isDryRun,
    },
  }

  if (Object.keys(fallbackContexts).length > 0) {
    output.fallbackContexts = fallbackContexts
    output.summary = {
      ...(output.summary as Record<string, unknown>),
      message: 'Sampling not supported by this host. Use the fallbackContexts to translate inline, then call add_translations to write the results.',
    }
  }

  return output
}

/**
 * Find translation keys that exist in locale files but are not referenced in source code.
 */
export async function findOrphanKeysOp(opts: {
  layer?: string
  locale?: string
  scanDirs?: string[]
  excludeDirs?: string[]
  projectDir?: string
}): Promise<Record<string, unknown>> {
  const { layer, locale, scanDirs, excludeDirs } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  const localeCode = locale ?? config.defaultLocale
  const localeDef = findLocaleImpl(config, localeCode)
  if (!localeDef) {
    throw new ToolError(
      `Locale not found: "${localeCode}". Available: ${config.locales.map(l => l.code).join(', ')}`,
      'LOCALE_NOT_FOUND',
    )
  }

  const layersToCheck = layer
    ? config.localeDirs.filter(d => d.layer === layer)
    : config.localeDirs.filter(d => !d.aliasOf)

  if (layersToCheck.length === 0) {
    if (layer) {
      findLayerOrThrow(config, layer)
    }
    throw new ToolError('No locale directories found.', 'LAYER_NOT_FOUND')
  }

  if (layer && layersToCheck[0]?.aliasOf) {
    throw new ToolError(
      `Layer "${layer}" is an alias of "${layersToCheck[0].aliasOf}". Use the target layer instead.`,
      'LAYER_IS_ALIAS',
    )
  }

  const keysByLayer = new Map<string, { keys: string[]; localeDir: LocaleDir }>()
  for (const ld of layersToCheck) {
    let data: Record<string, unknown>
    try {
      data = await readLocaleData(config, ld.layer, localeDef)
    } catch {
      continue
    }
    if (Object.keys(data).length === 0) continue
    keysByLayer.set(ld.layer, { keys: getLeafKeys(data), localeDir: ld })
  }

  const totalKeys = [...keysByLayer.values()].reduce((sum, v) => sum + v.keys.length, 0)
  if (totalKeys === 0) {
    const emptyOutput = { orphanKeys: {} as Record<string, string[]>, summary: { totalKeys: 0, orphanCount: 0, filesScanned: 0, message: 'No translation keys found in locale files.' } }
    const reportPath = resolveReportFilePath(config, dir, 'find_orphan_keys')
    if (reportPath) {
      await writeReportFile(reportPath, emptyOutput, {
        tool: 'find_orphan_keys',
        args: { layer, locale, scanDirs, excludeDirs },
      })
      return { reportFile: reportPath, summary: emptyOutput.summary }
    }
    return emptyOutput
  }

  const orphanResult = await findOrphanKeysForConfig({
    keysByLayer,
    apps: config.apps,
    scanDirs: scanDirs || undefined,
    excludeDirs: excludeDirs || undefined,
    resolveIgnorePatterns: (layerName) => resolveOrphanIgnorePatterns(config, layerName),
    patterns: getPatternSet(config.localeFileFormat),
  })

  const byLayer = orphanResult.orphansByLayer
  const allOrphanKeys: Array<{ key: string; layer: string }> = []
  for (const [layerName, keys] of Object.entries(byLayer)) {
    for (const key of keys) allOrphanKeys.push({ key, layer: layerName })
  }
  allOrphanKeys.sort((a, b) => a.layer.localeCompare(b.layer) || a.key.localeCompare(b.key))
  const sortedByLayer: Record<string, string[]> = {}
  for (const { key, layer: keyLayer } of allOrphanKeys) {
    if (!sortedByLayer[keyLayer]) sortedByLayer[keyLayer] = []
    sortedByLayer[keyLayer].push(key)
  }

  const output: Record<string, unknown> = {
    orphanKeys: sortedByLayer,
    uncertainKeys: orphanResult.uncertainCount > 0 ? orphanResult.uncertainByLayer : undefined,
    summary: {
      totalKeys,
      orphanCount: orphanResult.orphanCount,
      uncertainCount: orphanResult.uncertainCount,
      dynamicMatchedCount: orphanResult.dynamicMatchedCount,
      ignoredCount: orphanResult.ignoredCount,
      usedCount: totalKeys - orphanResult.orphanCount - orphanResult.uncertainCount,
      filesScanned: orphanResult.totalFilesScanned,
      layersChecked: layersToCheck.map(d => d.layer),
      dirsScanned: orphanResult.dirsScanned,
      locale: localeCode,
    },
    dynamicKeyWarning: orphanResult.allDynamicKeys.length > 0
      ? `${orphanResult.allDynamicKeys.length} dynamic key reference(s) found (template literals with interpolation). Some "orphan" keys may actually be used via dynamic keys. Review before removing. Note: string concatenation patterns (e.g. 'prefix.' + var) are not detected — use template literals for full coverage.`
      : undefined,
    dynamicKeys: orphanResult.allDynamicKeys.length > 0
      ? orphanResult.allDynamicKeys.map(dk => ({
          expression: dk.expression,
          file: toRelativePath(dk.file, dir),
          line: dk.line,
        }))
      : undefined,
    unresolvedKeyWarnings: orphanResult.unresolvedKeyWarnings.length > 0
      ? orphanResult.unresolvedKeyWarnings.map(w => ({
          expression: w.expression,
          file: toRelativePath(w.file, dir),
          line: w.line,
          callee: w.callee,
          suggestedIgnorePattern: w.suggestedIgnorePattern,
        }))
      : undefined,
  }

  const reportPath = resolveReportFilePath(config, dir, 'find_orphan_keys')
  if (reportPath) {
    await writeReportFile(reportPath, output, {
      tool: 'find_orphan_keys',
      args: { layer, locale, scanDirs, excludeDirs },
    })
    return { reportFile: reportPath, summary: output.summary }
  }

  return output
}

/**
 * Scan Vue/TS source files to find where translation keys are referenced.
 */
export async function scanCodeUsageOp(opts: {
  keys?: string[]
  scanDirs?: string[]
  excludeDirs?: string[]
  projectDir?: string
}): Promise<Record<string, unknown>> {
  const { keys, scanDirs, excludeDirs } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  const dirsToScan = scanDirs ?? config.layerRootDirs

  const allUsages: Array<{ key: string; file: string; line: number; callee: string }> = []
  const allDynamicKeys: Array<{ expression: string; file: string; line: number; callee: string }> = []
  let totalFilesScanned = 0

  for (const scanDir of dirsToScan) {
    const result = await scanSourceFiles(scanDir, excludeDirs, getPatternSet(config.localeFileFormat))
    totalFilesScanned += result.filesScanned
    allUsages.push(...result.usages)
    allDynamicKeys.push(...result.dynamicKeys)
  }

  const filteredUsages = keys
    ? allUsages.filter(u => keys.includes(u.key))
    : allUsages

  const byKey: Record<string, Array<{ file: string; line: number; callee: string }>> = {}
  for (const usage of filteredUsages) {
    if (!byKey[usage.key]) byKey[usage.key] = []
    byKey[usage.key].push({
      file: toRelativePath(usage.file, dir),
      line: usage.line,
      callee: usage.callee,
    })
  }

  const sortedByKey: Record<string, Array<{ file: string; line: number; callee: string }>> = {}
  for (const key of Object.keys(byKey).sort()) {
    sortedByKey[key] = byKey[key]
  }

  const notFound = keys
    ? keys.filter(k => !byKey[k])
    : []

  const output: Record<string, unknown> = {
    usages: sortedByKey,
    summary: {
      uniqueKeysFound: Object.keys(sortedByKey).length,
      totalReferences: filteredUsages.length,
      filesScanned: totalFilesScanned,
      dirsScanned: dirsToScan,
    },
  }

  if (notFound.length > 0) {
    output.notFoundInCode = notFound
  }

  if (allDynamicKeys.length > 0) {
    output.dynamicKeys = allDynamicKeys.map(dk => ({
      expression: dk.expression,
      file: toRelativePath(dk.file, dir),
      line: dk.line,
    }))
  }

  const reportPath = resolveReportFilePath(config, dir, 'scan_code_usage')
  if (reportPath) {
    await writeReportFile(reportPath, output, {
      tool: 'scan_code_usage',
      args: { keys, scanDirs, excludeDirs },
    })
    return { reportFile: reportPath, summary: output.summary }
  }

  return output
}

/**
 * Find translation keys not referenced in source code and remove them.
 */
export async function cleanupUnusedTranslations(opts: {
  layer?: string
  locale?: string
  scanDirs?: string[]
  excludeDirs?: string[]
  dryRun?: boolean
  projectDir?: string
}): Promise<Record<string, unknown>> {
  const { layer, locale, scanDirs, excludeDirs } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  const isDryRun = opts.dryRun ?? true

  const localeCode = locale ?? config.defaultLocale
  const localeDef = findLocaleImpl(config, localeCode)
  if (!localeDef) {
    throw new ToolError(
      `Locale not found: "${localeCode}". Available: ${config.locales.map(l => l.code).join(', ')}`,
      'LOCALE_NOT_FOUND',
    )
  }

  const layersToCheck = layer
    ? config.localeDirs.filter(d => d.layer === layer)
    : config.localeDirs.filter(d => !d.aliasOf)

  if (layersToCheck.length === 0) {
    if (layer) {
      findLayerOrThrow(config, layer)
    }
    throw new ToolError('No locale directories found.', 'LAYER_NOT_FOUND')
  }

  if (layer && layersToCheck[0]?.aliasOf) {
    throw new ToolError(
      `Layer "${layer}" is an alias of "${layersToCheck[0].aliasOf}". Use the target layer instead.`,
      'LAYER_IS_ALIAS',
    )
  }

  const keysByLayer = new Map<string, { keys: string[]; localeDir: LocaleDir }>()
  for (const ld of layersToCheck) {
    let data: Record<string, unknown>
    try {
      data = await readLocaleData(config, ld.layer, localeDef)
    } catch {
      continue
    }
    if (Object.keys(data).length === 0) continue
    keysByLayer.set(ld.layer, { keys: getLeafKeys(data), localeDir: ld })
  }

  const totalKeys = [...keysByLayer.values()].reduce((sum, v) => sum + v.keys.length, 0)
  if (totalKeys === 0) {
    const emptyOutput = { orphanKeys: {}, removed: {}, summary: { totalKeys: 0, orphanCount: 0, message: 'No translation keys found.' } }
    const emptyReportPath = resolveReportFilePath(config, dir, 'cleanup_unused_translations')
    if (emptyReportPath) {
      await writeReportFile(emptyReportPath, emptyOutput, {
        tool: 'cleanup_unused_translations',
        args: { layer, locale, scanDirs, excludeDirs, dryRun: opts.dryRun },
      })
      return { reportFile: emptyReportPath, summary: emptyOutput.summary }
    }
    return emptyOutput
  }

  const orphanResult = await findOrphanKeysForConfig({
    keysByLayer,
    apps: config.apps,
    scanDirs: scanDirs || undefined,
    excludeDirs: excludeDirs || undefined,
    resolveIgnorePatterns: (layerName) => resolveOrphanIgnorePatterns(config, layerName),
    patterns: getPatternSet(config.localeFileFormat),
  })
  const orphansByLayer = orphanResult.orphansByLayer
  const orphanCount = orphanResult.orphanCount
  const totalFilesScanned = orphanResult.totalFilesScanned
  const dynamicMatchedCount = orphanResult.dynamicMatchedCount
  const ignoredCount = orphanResult.ignoredCount
  const allDynamicKeys = orphanResult.allDynamicKeys.map(dk => ({
    expression: dk.expression,
    file: toRelativePath(dk.file, dir),
    line: dk.line,
  }))

  if (orphanCount === 0) {
    const messageParts: string[] = ['No orphan keys found.']
    if (dynamicMatchedCount > 0) messageParts.push(`${dynamicMatchedCount} key(s) were excluded by dynamic pattern matching.`)
    if (ignoredCount > 0) messageParts.push(`${ignoredCount} key(s) were excluded by ignore patterns.`)
    if (orphanResult.uncertainCount > 0) messageParts.push(`${orphanResult.uncertainCount} uncertain key(s) were excluded because they overlap with dynamic translation patterns.`)
    if (dynamicMatchedCount === 0 && ignoredCount === 0 && orphanResult.uncertainCount === 0) messageParts.push('All translation keys are referenced in code.')
    const zeroOutput: Record<string, unknown> = {
      orphanKeys: {},
      uncertainKeys: orphanResult.uncertainCount > 0 ? orphanResult.uncertainByLayer : undefined,
      summary: { totalKeys, orphanCount: 0, uncertainCount: orphanResult.uncertainCount, dynamicMatchedCount, ignoredCount, filesScanned: totalFilesScanned, message: messageParts.join(' ') },
    }
    const zeroReportPath = resolveReportFilePath(config, dir, 'cleanup_unused_translations')
    if (zeroReportPath) {
      await writeReportFile(zeroReportPath, zeroOutput, {
        tool: 'cleanup_unused_translations',
        args: { layer, locale, scanDirs, excludeDirs, dryRun: opts.dryRun },
      })
      return { reportFile: zeroReportPath, summary: zeroOutput.summary }
    }
    return zeroOutput
  }

  // Dry run — just report
  if (isDryRun) {
    const output: Record<string, unknown> = {
      orphanKeys: orphansByLayer,
      uncertainKeys: orphanResult.uncertainCount > 0 ? orphanResult.uncertainByLayer : undefined,
      summary: {
        dryRun: true,
        totalKeys,
        orphanCount,
        uncertainCount: orphanResult.uncertainCount,
        dynamicMatchedCount,
        ignoredCount,
        usedCount: totalKeys - orphanCount - orphanResult.uncertainCount,
        filesScanned: totalFilesScanned,
        message: `Found ${orphanCount} orphan key(s) safe to remove.${orphanResult.uncertainCount > 0 ? ` ${orphanResult.uncertainCount} uncertain key(s) excluded (overlap with dynamic translation patterns).` : ''} ${dynamicMatchedCount > 0 ? `${dynamicMatchedCount} key(s) matched dynamic patterns and were excluded. ` : ''}${ignoredCount > 0 ? `${ignoredCount} key(s) matched ignore patterns and were excluded. ` : ''}Call again with dryRun: false to remove them.`,
      },
    }
    if (allDynamicKeys.length > 0) {
      output.dynamicKeyWarning = `${allDynamicKeys.length} dynamic key reference(s) found. Some "orphan" keys may be used via dynamic keys. Review before removing. Note: string concatenation patterns (e.g. 'prefix.' + var) are not detected — use template literals for full coverage.`
      output.dynamicKeys = allDynamicKeys
    }
    if (orphanResult.unresolvedKeyWarnings.length > 0) {
      output.unresolvedKeyWarnings = orphanResult.unresolvedKeyWarnings.map(w => ({
        expression: w.expression,
        file: toRelativePath(w.file, dir),
        line: w.line,
        callee: w.callee,
        suggestedIgnorePattern: w.suggestedIgnorePattern,
      }))
    }
    const dryRunReportPath = resolveReportFilePath(config, dir, 'cleanup_unused_translations')
    if (dryRunReportPath) {
      await writeReportFile(dryRunReportPath, output, {
        tool: 'cleanup_unused_translations',
        args: { layer, locale, scanDirs, excludeDirs, dryRun: opts.dryRun },
      })
      return { reportFile: dryRunReportPath, summary: output.summary }
    }
    return output
  }

  // Actual removal
  const removedByLayer: Record<string, string[]> = {}
  let totalFilesWritten = 0

  for (const [layerName, orphans] of Object.entries(orphansByLayer)) {
    const ld = config.localeDirs.find(d => d.layer === layerName)!
    if (ld.aliasOf) continue

    for (const localeDef2 of config.locales) {
      try {
        const written = await mutateLocaleData(config, layerName, localeDef2, (fileData) => {
          for (const key of orphans) {
            removeNestedValue(fileData, key)
          }
        })
        totalFilesWritten += written.size
      } catch {
        continue
      }
    }

    removedByLayer[layerName] = orphans
  }

  const removalOutput: Record<string, unknown> = {
    removed: removedByLayer,
    uncertainKeys: orphanResult.uncertainCount > 0 ? orphanResult.uncertainByLayer : undefined,
    summary: {
      dryRun: false,
      totalKeys,
      removedCount: orphanCount,
      uncertainCount: orphanResult.uncertainCount,
      dynamicMatchedCount,
      ignoredCount,
      remainingCount: totalKeys - orphanCount,
      filesWritten: totalFilesWritten,
      filesScanned: totalFilesScanned,
    },
  }

  const removalReportPath = resolveReportFilePath(config, dir, 'cleanup_unused_translations')
  if (removalReportPath) {
    await writeReportFile(removalReportPath, removalOutput, {
      tool: 'cleanup_unused_translations',
      args: { layer, locale, scanDirs, excludeDirs, dryRun: opts.dryRun },
    })
    return { reportFile: removalReportPath, summary: removalOutput.summary }
  }

  return removalOutput
}

/**
 * Create empty locale files for new languages.
 */
export async function scaffoldLocaleFiles(opts: {
  locales?: string[]
  layer?: string
  dryRun?: boolean
  projectDir?: string
}): Promise<Record<string, unknown>> {
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  const result = await scaffoldLocale(config, { locales: opts.locales, layer: opts.layer, dryRun: opts.dryRun })

  return {
    created: result.created.map(f => ({
      locale: f.locale,
      layer: f.layer,
      file: toRelativePath(f.file, config.rootDir),
      keys: f.keys,
      ...(f.namespace ? { namespace: f.namespace } : {}),
    })),
    skipped: result.skipped.map(f => ({
      locale: f.locale,
      layer: f.layer,
      file: toRelativePath(f.file, config.rootDir),
      keys: f.keys,
      ...(f.namespace ? { namespace: f.namespace } : {}),
    })),
    dryRun: opts.dryRun ?? false,
  }
}
