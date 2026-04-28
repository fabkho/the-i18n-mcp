/**
 * CLI entry point — maps subcommands to core operations.
 *
 * No external dependencies: uses only process.argv parsing.
 * Output is JSON by default; use --pretty for human-readable formatting.
 */

import {
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
} from './core/operations.js'

// ─── Arg parsing ────────────────────────────────────────────────

interface ParsedArgs {
  command: string | undefined
  flags: Record<string, string | boolean>
  positional: string[]
}

function parseArgs(argv: string[]): ParsedArgs {
  // Skip node + script path
  const args = argv.slice(2)
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  let command: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
      } else {
        const next = args[i + 1]
        if (next !== undefined && (!next.startsWith('-') || /^-\d/.test(next))) {
          flags[arg.slice(2)] = next
          i++
        } else {
          flags[arg.slice(2)] = true
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const next = args[i + 1]
      if (next !== undefined && (!next.startsWith('-') || /^-\d/.test(next))) {
        flags[arg.slice(1)] = next
        i++
      } else {
        flags[arg.slice(1)] = true
      }
    } else if (command === undefined) {
      command = arg
    } else {
      positional.push(arg)
    }
  }

  return { command, flags, positional }
}

function flag(flags: Record<string, string | boolean>, ...names: string[]): string | undefined {
  for (const name of names) {
    const val = flags[name]
    if (typeof val === 'string') return val
  }
  return undefined
}

function flagBool(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  for (const name of names) {
    if (flags[name] === true || flags[name] === 'true') return true
  }
  return false
}

function requireFlag(flags: Record<string, string | boolean>, name: string, alias?: string): string {
  const val = flag(flags, name, ...(alias ? [alias] : []))
  if (val === undefined) {
    throw new Error(`Missing required option: --${name}`)
  }
  return val
}

function splitList(val: string | undefined): string[] | undefined {
  if (!val) return undefined
  return val.split(',').map(s => s.trim()).filter(Boolean)
}

// ─── Output ─────────────────────────────────────────────────────

function printJson(data: unknown, pretty: boolean): void {
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  process.stdout.write(json + '\n')
}

function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`)
}

// ─── Help text ──────────────────────────────────────────────────

const MAIN_HELP = `
Usage: the-i18n-mcp <command> [options]

Commands:
  detect       Detect i18n configuration
  list-dirs    List locale directories
  get          Get translation values
  add          Add new translations
  update       Update existing translations
  missing      Find missing translations
  empty        Find empty translation values
  search       Search translations
  remove       Remove translation keys
  rename       Rename a translation key
  translate    Translate missing keys (returns fallback contexts)
  orphans      Find orphan keys not used in code
  scan         Scan code for translation key usage
  cleanup      Remove unused translations
  scaffold     Create empty locale files for new languages
  serve        Start MCP server on stdio

Global options:
  -d, --project-dir <dir>  Project directory (default: cwd)
  --dry-run                Dry run where applicable
  --pretty                 Pretty-print JSON output
  -h, --help               Show help
`.trim()

const COMMAND_HELP: Record<string, string> = {
  detect: `
Usage: the-i18n-mcp detect [options]

Detect the i18n configuration from the project.

Options:
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  'list-dirs': `
Usage: the-i18n-mcp list-dirs [options]

List all i18n locale directories, grouped by layer.

Options:
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  get: `
Usage: the-i18n-mcp get --layer <layer> --locale <locale> --keys <a,b,c>

Get translation values for specific keys.

Options:
  --layer <name>           Layer name (required)
  --locale <code>          Locale code, or "*" for all (required)
  --keys <a,b,c>           Comma-separated key paths (required)
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  add: `
Usage: the-i18n-mcp add --layer <layer> --translations '{...}'

Add new translation keys. Skips keys that already exist.

Options:
  --layer <name>               Layer name (required)
  --translations <json>        JSON: { "key": { "en": "val", "de": "val" } } (required)
  --dry-run                    Preview changes without writing
  -d, --project-dir <dir>      Project directory (default: cwd)
  --pretty                     Pretty-print JSON output
`.trim(),

  update: `
Usage: the-i18n-mcp update --layer <layer> --translations '{...}'

Update existing translation keys. Skips keys that don't exist.

Options:
  --layer <name>               Layer name (required)
  --translations <json>        JSON: { "key": { "en": "val", "de": "val" } } (required)
  --dry-run                    Preview changes without writing
  -d, --project-dir <dir>      Project directory (default: cwd)
  --pretty                     Pretty-print JSON output
`.trim(),

  missing: `
Usage: the-i18n-mcp missing [options]

Find translation keys missing in target locales.

Options:
  --layer <name>           Filter to specific layer
  --ref <locale>           Reference locale (default: project default)
  --targets <de,fr>        Comma-separated target locales (default: all except ref)
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  empty: `
Usage: the-i18n-mcp empty [options]

Find translation keys with empty string values.

Options:
  --layer <name>           Filter to specific layer
  --locale <code>          Filter to specific locale
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  search: `
Usage: the-i18n-mcp search --query "text" [options]

Search translation files by key or value.

Options:
  --query <text>           Search query (required)
  --in <keys|values|both>  Where to search (default: both)
  --layer <name>           Filter to specific layer
  --locale <code>          Filter to specific locale
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  remove: `
Usage: the-i18n-mcp remove --layer <layer> --keys <a,b,c>

Remove translation keys from all locale files in a layer.

Options:
  --layer <name>           Layer name (required)
  --keys <a,b,c>           Comma-separated key paths (required)
  --dry-run                Preview changes without writing
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  rename: `
Usage: the-i18n-mcp rename --layer <layer> --old-key <key> --new-key <key>

Rename/move a translation key across all locale files.

Options:
  --layer <name>           Layer name (required)
  --old-key <key>          Current key path (required)
  --new-key <key>          New key path (required)
  --dry-run                Preview changes without writing
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  translate: `
Usage: the-i18n-mcp translate --layer <layer> [options]

Find missing translations and return fallback contexts for translation.
Does not use LLM sampling — returns context objects for external translation.

Options:
  --layer <name>           Layer name (required)
  --ref <locale>           Reference locale (default: project default)
  --targets <de,fr>        Comma-separated target locales (default: all except ref)
  --keys <a,b,c>           Only translate specific keys
  --batch-size <n>         Batch size (default: 50)
  --dry-run                Preview what would be translated
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  orphans: `
Usage: the-i18n-mcp orphans [options]

Find translation keys not referenced in source code.

Options:
  --layer <name>           Filter to specific layer
  --locale <code>          Locale to check (default: project default)
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  scan: `
Usage: the-i18n-mcp scan [options]

Scan source code for translation key usage.

Options:
  --keys <a,b,c>           Only report on specific keys
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  cleanup: `
Usage: the-i18n-mcp cleanup [options]

Find and remove translation keys not referenced in source code.

Options:
  --layer <name>           Filter to specific layer
  --locale <code>          Locale to check (default: project default)
  --dry-run                Preview without removing (default: true)
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  scaffold: `
Usage: the-i18n-mcp scaffold [options]

Create empty locale files for new languages.

Options:
  --locales <sv,ja>        Comma-separated locale codes to scaffold
  --layer <name>           Filter to specific layer
  --dry-run                Preview without writing
  -d, --project-dir <dir>  Project directory (default: cwd)
  --pretty                 Pretty-print JSON output
`.trim(),

  serve: `
Usage: the-i18n-mcp serve

Start the MCP server on stdio transport.
`.trim(),
}

// ─── Command handlers ───────────────────────────────────────────

type CommandHandler = (flags: Record<string, string | boolean>) => Promise<unknown>

function projectDir(flags: Record<string, string | boolean>): string | undefined {
  return flag(flags, 'project-dir', 'd') || undefined
}

const commands: Record<string, CommandHandler> = {
  detect: async (flags) => {
    return detectConfig(projectDir(flags))
  },

  'list-dirs': async (flags) => {
    return listLocaleDirs(projectDir(flags))
  },

  get: async (flags) => {
    const layer = requireFlag(flags, 'layer')
    const locale = requireFlag(flags, 'locale')
    const keysStr = requireFlag(flags, 'keys')
    const keys = keysStr.split(',').map(s => s.trim()).filter(Boolean)
    return getTranslations({ layer, locale, keys, projectDir: projectDir(flags) })
  },

  add: async (flags) => {
    const layer = requireFlag(flags, 'layer')
    const translationsStr = requireFlag(flags, 'translations')
    let translations: Record<string, Record<string, string>>
    try {
      translations = JSON.parse(translationsStr) as Record<string, Record<string, string>>
    } catch (err) {
      throw new Error(`Invalid JSON in --translations: ${err instanceof SyntaxError ? err.message : String(err)}`)
    }
    return addTranslations({
      layer,
      translations,
      dryRun: flagBool(flags, 'dry-run'),
      projectDir: projectDir(flags),
    })
  },

  update: async (flags) => {
    const layer = requireFlag(flags, 'layer')
    const translationsStr = requireFlag(flags, 'translations')
    let translations: Record<string, Record<string, string>>
    try {
      translations = JSON.parse(translationsStr) as Record<string, Record<string, string>>
    } catch (err) {
      throw new Error(`Invalid JSON in --translations: ${err instanceof SyntaxError ? err.message : String(err)}`)
    }
    return updateTranslations({
      layer,
      translations,
      dryRun: flagBool(flags, 'dry-run'),
      projectDir: projectDir(flags),
    })
  },

  missing: async (flags) => {
    return getMissingTranslations({
      layer: flag(flags, 'layer'),
      referenceLocale: flag(flags, 'ref'),
      targetLocales: splitList(flag(flags, 'targets')),
      projectDir: projectDir(flags),
    })
  },

  empty: async (flags) => {
    return findEmptyTranslations({
      layer: flag(flags, 'layer'),
      locale: flag(flags, 'locale'),
      projectDir: projectDir(flags),
    })
  },

  search: async (flags) => {
    const query = requireFlag(flags, 'query')
    const searchIn = flag(flags, 'in') as 'keys' | 'values' | 'both' | undefined
    return searchTranslations({
      query,
      searchIn,
      layer: flag(flags, 'layer'),
      locale: flag(flags, 'locale'),
      projectDir: projectDir(flags),
    })
  },

  remove: async (flags) => {
    const layer = requireFlag(flags, 'layer')
    const keysStr = requireFlag(flags, 'keys')
    const keys = keysStr.split(',').map(s => s.trim()).filter(Boolean)
    return removeTranslations({
      layer,
      keys,
      dryRun: flagBool(flags, 'dry-run'),
      projectDir: projectDir(flags),
    })
  },

  rename: async (flags) => {
    const layer = requireFlag(flags, 'layer')
    const oldKey = requireFlag(flags, 'old-key')
    const newKey = requireFlag(flags, 'new-key')
    return renameTranslationKey({
      layer,
      oldKey,
      newKey,
      dryRun: flagBool(flags, 'dry-run'),
      projectDir: projectDir(flags),
    })
  },

  translate: async (flags) => {
    const layer = requireFlag(flags, 'layer')
    const batchSizeStr = flag(flags, 'batch-size')
    return translateMissing({
      layer,
      referenceLocale: flag(flags, 'ref'),
      targetLocales: splitList(flag(flags, 'targets')),
      keys: splitList(flag(flags, 'keys')),
      batchSize: batchSizeStr ? parseInt(batchSizeStr, 10) : undefined,
      dryRun: flagBool(flags, 'dry-run'),
      projectDir: projectDir(flags),
      // No samplingFn — CLI always returns fallback contexts
    })
  },

  orphans: async (flags) => {
    return findOrphanKeysOp({
      layer: flag(flags, 'layer'),
      locale: flag(flags, 'locale'),
      projectDir: projectDir(flags),
    })
  },

  scan: async (flags) => {
    return scanCodeUsageOp({
      keys: splitList(flag(flags, 'keys')),
      projectDir: projectDir(flags),
    })
  },

  cleanup: async (flags) => {
    // Preserve core default (dryRun=true) when --dry-run is not explicitly passed
    const dryRun = Object.prototype.hasOwnProperty.call(flags, 'dry-run')
      ? flagBool(flags, 'dry-run')
      : undefined
    return cleanupUnusedTranslations({
      layer: flag(flags, 'layer'),
      locale: flag(flags, 'locale'),
      dryRun,
      projectDir: projectDir(flags),
    })
  },

  scaffold: async (flags) => {
    return scaffoldLocaleFiles({
      locales: splitList(flag(flags, 'locales')),
      layer: flag(flags, 'layer'),
      dryRun: flagBool(flags, 'dry-run'),
      projectDir: projectDir(flags),
    })
  },

  serve: async () => {
    const { createServer } = await import('./server.js')
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
    const server = createServer()
    const transport = new StdioServerTransport()
    await server.connect(transport)
    // Server runs until process exits — don't return a result to print
    return undefined
  },
}

// ─── Main ───────────────────────────────────────────────────────

export async function runCli(): Promise<void> {
  const { command, flags } = parseArgs(process.argv)
  const pretty = flagBool(flags, 'pretty')
  const wantsHelp = flagBool(flags, 'help', 'h')

  // No command → show main help
  if (!command) {
    if (wantsHelp) {
      process.stdout.write(MAIN_HELP + '\n')
      return
    }
    process.stdout.write(MAIN_HELP + '\n')
    process.exitCode = 1
    return
  }

  // Help for a specific command
  if (wantsHelp) {
    const helpText = COMMAND_HELP[command]
    if (helpText) {
      process.stdout.write(helpText + '\n')
    } else {
      printError(`Unknown command: ${command}`)
      process.stdout.write(MAIN_HELP + '\n')
      process.exitCode = 1
    }
    return
  }

  // Look up handler
  const handler = commands[command]
  if (!handler) {
    printError(`Unknown command: ${command}`)
    process.stdout.write(MAIN_HELP + '\n')
    process.exitCode = 1
    return
  }

  try {
    const result = await handler(flags)
    if (result !== undefined) {
      printJson(result, pretty)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    printError(message)
    process.exitCode = 1
  }
}
