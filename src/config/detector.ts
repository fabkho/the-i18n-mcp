import { existsSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, basename, relative } from 'node:path'
import { loadKit } from './nuxt-loader'
import type { I18nConfig, LocaleDefinition, LocaleDir } from './types'
import { loadProjectConfig } from './project-config'
import { log } from '../utils/logger'
import { ConfigError } from '../utils/errors'

/** Nuxt config file names to look for, in priority order. */
const NUXT_CONFIG_FILES = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'] as const

/** Directories to skip during recursive Nuxt app discovery. */
const SKIP_DIRS = new Set([
  'node_modules', '.nuxt', '.output', '.git', 'dist', '.cache',
])

/** Maximum directory depth for monorepo app discovery. */
const MAX_DISCOVERY_DEPTH = 4

/** Cached config instance */
let cachedConfig: I18nConfig | null = null

/**
 * Detect the i18n configuration from a Nuxt project or monorepo root.
 *
 * When `projectDir` is a single Nuxt app, loads it directly (backwards compatible).
 * When `projectDir` is a monorepo root containing multiple Nuxt apps with i18n,
 * discovers all apps, loads each independently, and merges into a unified config.
 */
export async function detectI18nConfig(projectDir: string): Promise<I18nConfig> {
  if (cachedConfig && cachedConfig.rootDir === projectDir) {
    log.debug('Using cached i18n config')
    return cachedConfig
  }

  log.info(`Detecting i18n config from: ${projectDir}`)

  // Check if projectDir itself is a Nuxt app
  const isNuxtApp = findNuxtConfig(projectDir) !== null

  if (isNuxtApp) {
    // Single-app path: load directly (backwards compatible)
    const config = await loadSingleApp(projectDir, projectDir)
    cachedConfig = config
    log.info(`Detected ${config.locales.length} locales, ${config.localeDirs.length} locale directories`)
    return config
  }

  // Monorepo path: discover all Nuxt apps with i18n under projectDir
  const appDirs = await discoverNuxtApps(projectDir)
  if (appDirs.length === 0) {
    throw new ConfigError(
      `No Nuxt apps with i18n configuration found under ${projectDir}. `
      + 'Make sure your Nuxt apps have a nuxt.config.ts with i18n configured.',
    )
  }

  log.info(`Discovered ${appDirs.length} Nuxt app(s) with i18n: ${appDirs.map(d => relative(projectDir, d) || '.').join(', ')}`)

  const config = await loadAndMergeApps(appDirs, projectDir)
  cachedConfig = config
  log.info(`Detected ${config.locales.length} locales, ${config.localeDirs.length} locale directories from ${appDirs.length} app(s)`)
  return config
}

/**
 * Clear the cached config. Used by the reload_config tool.
 */
export function clearConfigCache(): void {
  cachedConfig = null
  log.debug('Config cache cleared')
}

/**
 * Get the currently cached config without triggering detection.
 * Returns null if no config has been detected yet.
 * Used by MCP resources which can't pass a projectDir parameter.
 */
export function getCachedConfig(): I18nConfig | null {
  return cachedConfig
}

/**
 * Find a nuxt.config file in the given directory.
 * Returns the filename if found, null otherwise.
 */
function findNuxtConfig(dir: string): string | null {
  for (const name of NUXT_CONFIG_FILES) {
    if (existsSync(resolve(dir, name))) {
      return name
    }
  }
  return null
}

/**
 * Check if a nuxt.config file likely contains i18n configuration.
 * Uses a quick regex scan — fast enough for discovery without loading Nuxt.
 */
async function hasI18nConfig(configPath: string): Promise<boolean> {
  try {
    const content = await readFile(configPath, 'utf-8')
    // Look for i18n property in defineNuxtConfig or module reference
    return /\bi18n\b/.test(content)
  }
  catch {
    return false
  }
}

/**
 * Discover all Nuxt apps with i18n configuration under a root directory.
 * Scans recursively up to MAX_DISCOVERY_DEPTH levels deep,
 * skipping common non-project directories.
 *
 * Returns absolute paths to directories that:
 * 1. Contain a nuxt.config.{ts,js,mjs} file
 * 2. The config file references i18n
 */
export async function discoverNuxtApps(rootDir: string): Promise<string[]> {
  const apps: string[] = []
  await scanForApps(rootDir, 0, apps)
  return apps
}

/**
 * Recursive scanner for Nuxt apps.
 * Stops descending into a directory once a nuxt.config is found there
 * (Nuxt layers are resolved by the app itself, not by us).
 */
async function scanForApps(dir: string, depth: number, results: string[]): Promise<void> {
  if (depth > MAX_DISCOVERY_DEPTH) return

  const configFile = findNuxtConfig(dir)
  if (configFile) {
    // Found a Nuxt app — check if it has i18n
    const configPath = resolve(dir, configFile)
    if (await hasI18nConfig(configPath)) {
      results.push(dir)
    }
    // Don't descend further — nested Nuxt apps in subdirs of a Nuxt app
    // are their own entry points, not children of this one.
    // BUT: we still need to find sibling apps, so don't return here.
    // The parent caller handles sibling iteration.
    return
  }

  // No nuxt.config here — scan subdirectories
  let entries: string[]
  try {
    entries = await readdir(dir)
  }
  catch {
    return
  }

  for (const entry of entries) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue
    const childDir = resolve(dir, entry)
    // Quick stat check: only process directories
    try {
      const stat = statSync(childDir)
      if (!stat.isDirectory()) continue
    }
    catch {
      continue
    }
    await scanForApps(childDir, depth + 1, results)
  }
}

/**
 * Load a single Nuxt app's i18n config.
 * This is the original single-app loading path.
 */
async function loadSingleApp(appDir: string, discoveryRoot: string): Promise<I18nConfig> {
  const kit = await loadKit(appDir)

  let nuxt: Awaited<ReturnType<typeof kit.loadNuxt>>

  try {
    nuxt = await kit.loadNuxt({
      cwd: appDir,
      dotenv: { cwd: appDir },
      overrides: {
        logLevel: 'silent' as const,
        vite: { clearScreen: false },
      },
    })
  }
  catch (_error) {
    // Retry with ready:false to skip full module initialization while keeping config intact
    log.warn(`Initial loadNuxt failed for ${appDir}, retrying with ready:false...`)
    try {
      nuxt = await kit.loadNuxt({
        cwd: appDir,
        dotenv: { cwd: appDir },
        ready: false,
        overrides: {
          logLevel: 'silent' as const,
          vite: { clearScreen: false },
        },
      })
    }
    catch (retryError) {
      throw new ConfigError(
        `Failed to load Nuxt config from ${appDir}: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
      )
    }
  }

  try {
    return await extractI18nConfig(nuxt as unknown as { options: Record<string, unknown> }, appDir, discoveryRoot)
  }
  finally {
    await nuxt.close()
  }
}

/**
 * Load multiple Nuxt apps and merge their configs into a single I18nConfig.
 * Each app is loaded independently via loadNuxt, then locale dirs and locales
 * are merged with deduplication.
 */
async function loadAndMergeApps(appDirs: string[], discoveryRoot: string): Promise<I18nConfig> {
  // Load project config from the discovery root (shared across all apps)
  const projectConfig = await loadProjectConfig(discoveryRoot)

  const allLocaleDirs: LocaleDir[] = []
  const allLocales: LocaleDefinition[] = []
  const allLayerRootDirs: string[] = []
  const seenLocalePaths = new Map<string, string>() // path -> layer name (for alias detection)
  const seenLocaleCodes = new Set<string>()
  let defaultLocale = 'en'
  let fallbackLocale: Record<string, string[]> = { default: ['en'] }

  // Load each app sequentially (loadNuxt can be resource-intensive)
  for (const appDir of appDirs) {
    log.info(`Loading Nuxt app: ${relative(discoveryRoot, appDir) || '.'}`)
    let appConfig: I18nConfig
    try {
      appConfig = await loadSingleApp(appDir, discoveryRoot)
    }
    catch (error) {
      log.warn(`Failed to load app at ${appDir}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    // Use the first app's default/fallback locale as the merged config's
    if (allLocaleDirs.length === 0) {
      defaultLocale = appConfig.defaultLocale
      fallbackLocale = appConfig.fallbackLocale
    }

    // Merge locale dirs with deduplication
    for (const dir of appConfig.localeDirs) {
      const existingLayer = seenLocalePaths.get(dir.path)
      if (existingLayer) {
        // Same physical path already registered — add as alias if different layer name
        if (dir.layer !== existingLayer) {
          allLocaleDirs.push({
            ...dir,
            aliasOf: existingLayer,
          })
          log.debug(`Layer '${dir.layer}' is alias of '${existingLayer}' (same path: ${dir.path})`)
        }
        continue
      }
      seenLocalePaths.set(dir.path, dir.layer)
      allLocaleDirs.push(dir)
    }

    // Merge locales (deduplicate by code)
    for (const locale of appConfig.locales) {
      if (!seenLocaleCodes.has(locale.code)) {
        seenLocaleCodes.add(locale.code)
        allLocales.push(locale)
      }
    }

    // Merge layer root dirs
    for (const rootDir of appConfig.layerRootDirs) {
      if (!allLayerRootDirs.includes(rootDir)) {
        allLayerRootDirs.push(rootDir)
      }
    }
  }

  if (allLocaleDirs.length === 0) {
    throw new ConfigError(
      `No locale directories found in any Nuxt app under ${discoveryRoot}. `
      + 'Make sure your Nuxt apps have i18n/locales/ directories with JSON files.',
    )
  }

  return {
    rootDir: discoveryRoot,
    defaultLocale,
    fallbackLocale,
    locales: allLocales,
    localeDirs: allLocaleDirs,
    layerRootDirs: allLayerRootDirs,
    projectConfig: projectConfig ?? undefined,
  }
}

/**
 * Extract i18n config from a loaded Nuxt instance.
 */
async function extractI18nConfig(
  nuxt: { options: Record<string, unknown> },
  appDir: string,
  discoveryRoot: string,
): Promise<I18nConfig> {
  // Load project config independently of Nuxt config
  const projectConfig = await loadProjectConfig(appDir)

  const nuxtOptions = nuxt.options as Record<string, unknown>
  const i18nOptions = nuxtOptions.i18n as Record<string, unknown> | undefined
  const layers = (nuxtOptions._layers ?? []) as Array<{
    config: {
      rootDir: string
      i18n?: Record<string, unknown>
    }
  }>

  if (!i18nOptions) {
    throw new ConfigError(
      `No i18n configuration found in nuxt.config at ${appDir}. Make sure @nuxtjs/i18n is configured.`,
    )
  }

  // Extract default locale
  const defaultLocale = (i18nOptions.defaultLocale as string) ?? 'en'
  log.debug(`Default locale: ${defaultLocale}`)

  // Extract locales
  const rawLocales = (i18nOptions.locales ?? []) as Array<Record<string, unknown>>
  const locales: LocaleDefinition[] = rawLocales
    .filter(l => typeof l === 'object' && l !== null)
    .map(l => ({
      code: String(l.code ?? ''),
      language: String(l.language ?? l.iso ?? ''),
      file: String(l.file ?? ''),
      name: l.name ? String(l.name) : undefined,
    }))
    .filter(l => l.code && l.file)

  if (locales.length === 0) {
    throw new ConfigError(
      'No locales found in i18n configuration. Make sure locales are defined with code and file properties.',
    )
  }

  // Extract fallback locale
  const fallbackLocale = extractFallbackLocale(i18nOptions)

  // Discover locale directories from layers
  const localeDirs = await discoverLocaleDirs(layers, i18nOptions, discoveryRoot)

  const layerRootDirs = [...new Set(layers.map(l => l.config.rootDir))]
  if (layerRootDirs.length === 0) {
    layerRootDirs.push(appDir)
  }

  return {
    rootDir: appDir,
    defaultLocale,
    fallbackLocale,
    locales,
    localeDirs,
    layerRootDirs,
    projectConfig: projectConfig ?? undefined,
  }
}

/**
 * Extract the fallback locale chain.
 * Tries to read from the i18n options or the i18n.config.ts file.
 */
function extractFallbackLocale(
  i18nOptions: Record<string, unknown>,
): Record<string, string[]> {
  // Check if fallbackLocale is directly in options
  const fallback = i18nOptions.fallbackLocale
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
    // Convert to our format — ensure values are string arrays
    const result: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(fallback as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        result[key] = value.map(String)
      }
      else if (typeof value === 'string') {
        result[key] = [value]
      }
    }
    return result
  }

  // Default fallback
  const defaultLocale = (i18nOptions.defaultLocale as string) ?? 'en'
  return { default: [defaultLocale] }
}

/**
 * Discover locale directories from Nuxt layers.
 * Replicates the @nuxtjs/i18n langDir resolution logic.
 */
async function discoverLocaleDirs(
  layers: Array<{ config: { rootDir: string; i18n?: Record<string, unknown> } }>,
  i18nOptions: Record<string, unknown>,
  discoveryRoot: string,
): Promise<LocaleDir[]> {
  const dirs: LocaleDir[] = []
  const resolvedPaths = new Map<string, string>() // path -> layer name (for alias detection)

  for (const layer of layers) {
    const layerRootDir = layer.config.rootDir
    const layerName = deriveLayerName(layerRootDir, discoveryRoot)
    const layerI18n = layer.config.i18n ?? i18nOptions

    // Resolve langDir: default is 'locales' relative to '<layerRoot>/i18n/'
    const langDir = (layerI18n.langDir as string) ?? 'locales'
    const restructureDir = (layerI18n.restructureDir as string) ?? 'i18n'
    const resolvedDir = resolve(layerRootDir, restructureDir, langDir)

    if (!existsSync(resolvedDir)) {
      log.debug(`Locale dir not found for layer '${layerName}': ${resolvedDir}`)
      continue
    }

    // Check if this resolved path is an alias to another layer's dir
    const existingLayer = resolvedPaths.get(resolvedDir)
    if (existingLayer) {
      dirs.push({
        path: resolvedDir,
        layer: layerName,
        layerRootDir,
        aliasOf: existingLayer,
      })
      log.debug(`Layer '${layerName}' is alias of '${existingLayer}'`)
      continue
    }

    // Verify the directory contains JSON files
    const files = await readdir(resolvedDir)
    const jsonFiles = files.filter(f => f.endsWith('.json'))
    if (jsonFiles.length === 0) {
      log.debug(`No JSON files in locale dir for layer '${layerName}': ${resolvedDir}`)
      continue
    }

    resolvedPaths.set(resolvedDir, layerName)
    dirs.push({
      path: resolvedDir,
      layer: layerName,
      layerRootDir,
    })

    log.debug(`Found locale dir for layer '${layerName}': ${resolvedDir} (${jsonFiles.length} files)`)
  }

  if (dirs.length === 0) {
    throw new ConfigError(
      'No locale directories found. Make sure your Nuxt layers have i18n/locales/ directories with JSON files.',
    )
  }

  return dirs
}

/**
 * Derive a human-friendly layer name from its root directory.
 * Uses the discovery root as the reference point for naming, so layer names
 * are consistent whether loaded from a single app or a monorepo root.
 *
 * Examples (discoveryRoot = '/workspace/monorepo'):
 *   '/workspace/monorepo'            → 'root'
 *   '/workspace/monorepo/app-admin'  → 'app-admin'
 *   '/workspace/monorepo/apps/shop'  → 'shop'
 *   '/outside/shared-lib'            → 'shared-lib'
 */
function deriveLayerName(layerRootDir: string, discoveryRoot: string): string {
  const rel = relative(discoveryRoot, layerRootDir)
  if (rel === '' || rel === '.') {
    return 'root'
  }
  // For paths outside the discovery root (e.g., extended from node_modules),
  // fall back to basename
  return basename(layerRootDir)
}
