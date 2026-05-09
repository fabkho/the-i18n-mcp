# the-i18n-kit

[![CI](https://github.com/fabkho/the-i18n-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/fabkho/the-i18n-kit/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/the-i18n-mcp?style=flat&colorA=18181b&colorB=4fc08d)](https://github.com/fabkho/the-i18n-kit/blob/main/LICENSE)

Toolkit for managing i18n translation files — read, write, search, rename, and remove translation keys across all locales and layers. Supports Nuxt, Laravel, and any project with JSON or PHP locale files.

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| [**the-i18n-cli**](./packages/cli) | [![npm](https://img.shields.io/npm/v/the-i18n-cli?style=flat&colorA=18181b&colorB=4fc08d)](https://npmjs.com/package/the-i18n-cli) | CLI and core library — globally installable |
| [**the-i18n-mcp**](./packages/mcp) | [![npm](https://img.shields.io/npm/v/the-i18n-mcp?style=flat&colorA=18181b&colorB=4fc08d)](https://npmjs.com/package/the-i18n-mcp) | MCP server for AI agents |

### CLI

```bash
npm install -g the-i18n-cli

the-i18n-cli detect                    # Auto-detect project config
the-i18n-cli missing                   # Find missing translations
the-i18n-cli search --query "save"     # Search keys and values
the-i18n-cli cleanup                   # Find orphan keys (dry-run by default)
```

→ [Full CLI documentation](./packages/cli/README.md)

### MCP Server

Add to your MCP host (VS Code, Cursor, Claude Desktop, Zed):

```json
{
  "servers": {
    "the-i18n-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["the-i18n-mcp@latest"]
    }
  }
}
```

→ [Full MCP documentation](./packages/mcp/README.md)

## Supported Frameworks

| Framework | Locale Format | Auto-Detection |
|-----------|--------------|----------------|
| **Nuxt** (v3+) | JSON | `nuxt.config.ts` with `@nuxtjs/i18n` |
| **Laravel** (9+) | PHP arrays | `artisan`, `composer.json`, `lang/` |
| **Generic** | JSON or PHP | `localeDirs` + `defaultLocale` in `.i18n-mcp.json` |

## Using with Any Framework (Generic Adapter)

For projects that aren't Nuxt or Laravel, create a `.i18n-mcp.json` at your project root with a minimal config pointing to your locale files:

```json
{
  "defaultLocale": "en",
  "localeDirs": ["src/locales"],
  "locales": ["en", "de", "fr", "es"]
}
```

That's it. All tools (search, missing, translate, rename, remove) work immediately.

| Field | Required | Description |
|-------|----------|-------------|
| `defaultLocale` | ✅ | Your reference locale — the source of truth for key completeness |
| `localeDirs` | ✅ | Paths to directories containing locale files (relative to project root) |
| `locales` | ❌ | Explicit list of locale codes. If omitted, auto-discovered from filenames on disk |

`localeDirs` supports both flat and layered setups:

```json
// Flat: all locale files in one directory
"localeDirs": ["src/i18n"]

// Layered: multiple directories with named layers
"localeDirs": [
  { "path": "src/i18n/common", "layer": "common" },
  { "path": "src/i18n/dashboard", "layer": "dashboard" }
]
```

**When to set `locales` explicitly:**
- Your filenames don't match locale codes (e.g., `translations_de.json` instead of `de.json`)
- You want to limit which locales are managed (e.g., only 4 of 20 locales)
- You're bootstrapping a new project and files don't exist yet

If `locales` is omitted, the tool auto-discovers locale codes from JSON filenames (e.g., `en.json` → `"en"`) or subdirectory names in the locale directories.

> 💡 **Tip:** Let your AI agent generate this config. Ask it to analyze your project structure and create the `.i18n-mcp.json` — it can inspect your locale file layout and produce the right config in seconds.

## Project Config

Drop a `.i18n-mcp.json` at your project root for project-specific context:

```json
{
  "$schema": "node_modules/the-i18n-mcp/schema.json",
  "context": "B2B SaaS booking platform",
  "glossary": {
    "Booking": "Core concept. Dutch: 'Boeking'.",
    "Resource": "A bookable entity (room, desk, person)"
  },
  "translationPrompt": "Professional but approachable tone. Keep translations concise.",
  "localeNotes": {
    "de": "Informal German (du)",
    "de-formal": "Formal German (Sie)"
  }
}
```

<details>
<summary><strong>All config options</strong></summary>

| Field | Purpose |
|-------|---------|
| `framework` | Force framework detection: `"nuxt"`, `"laravel"`, or `"generic"` |
| `context` | Free-form project background for the agent |
| `layerRules` | Rules for which layer a new key belongs to |
| `glossary` | Term dictionary for consistent translations |
| `translationPrompt` | System prompt for all translation requests |
| `localeNotes` | Per-locale instructions (formality, terminology) |
| `examples` | Few-shot translation examples |
| `orphanScan` | Per-layer ignore patterns for orphan detection |
| `reportOutput` | `true` or path for diagnostic report output |
| `samplingPreferences` | Override model preferences for `translate_missing` |
| `localeDirs` | Locale directories for the generic adapter |
| `defaultLocale` | Default locale code (required for generic adapter) |
| `locales` | Explicit list of locale codes |

</details>

## How Orphan Detection Works

The scanner finds translation key references in source code:

**Nuxt/Vue patterns:** `$t('key')`, `t('key')`, `$tc('key')`, `i18n.t('key')`, template literals with `$t`

**Laravel/PHP patterns:** `__('key')`, `trans('key')`, `@lang('key')`, `Lang::get('key')`, `trans_choice('key')`

**Bare string candidates:** Any quoted dot-notation string in source (`'some.key'`, `"some.key"`) is treated as a potential key reference — regardless of whether it's inside a `t()` call. This catches patterns like `{ label: 'common.actions.save', i18n: true }` and non-standard i18n call styles.

**Dynamic key handling:**
- Template literals: `` $t(`status.${val}`) `` → matches all keys under `status.*`
- String concatenation: `t('prefix.' + var)` → matches all keys under `prefix.*` (single-line and multiline forms both detected)
- Keys matched by dynamic patterns are reported as "uncertain" separately and excluded from cleanup

**Scan scope:**
- The scanner always starts from the project root and recurses into all subdirectories
- All layers share the same combined scan results — no per-layer dependency graph needed
- Standard ignore dirs (`node_modules`, `.nuxt`, `.output`, `dist`) are excluded automatically

## Development

```bash
pnpm install        # Install all dependencies
pnpm build          # Build all packages
pnpm test           # Run all tests
pnpm lint           # ESLint across all packages
pnpm typecheck      # TypeScript check all packages
```

Set `DEBUG=1` to enable verbose logging to stderr.

## Roadmap

- [ ] `find_hardcoded_strings` — detect user-facing strings not wrapped in translation calls
- [ ] `move_translations` — move keys between layers
- [ ] Glossary validation — check translations against glossary terms
- [ ] Flat JSON support — `flatJson: true` in vue-i18n config
- [ ] Pluralization support — vue-i18n plural forms and Laravel `trans_choice`

## License

[MIT](./LICENSE)
