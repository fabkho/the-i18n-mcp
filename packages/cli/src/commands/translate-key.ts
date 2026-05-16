import { defineCommand } from 'citty'
import { translateKey } from '../core/operations.js'
import { sharedArgs, outputResult, splitList } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'translate-key',
    description: 'Translate one key from a source locale into target locales',
  },
  args: {
    ...sharedArgs,
    layer: {
      type: 'string',
      description: 'Layer name',
      required: true,
    },
    key: {
      type: 'string',
      description: 'Dot-separated translation key',
      required: true,
    },
    sourceLocale: {
      type: 'string',
      description: 'Source locale code/language/file',
      required: true,
    },
    sourceValue: {
      type: 'string',
      description: 'Optional source value to write before translating',
    },
    targets: {
      type: 'string',
      description: 'Comma-separated target locales, or "all"/omitted for all except source',
    },
    overwrite: {
      type: 'boolean',
      description: 'Overwrite existing target translations (default true)',
      default: true,
    },
    dryRun: {
      type: 'boolean',
      description: 'Preview without writing or sampling',
      default: false,
    },
    includePreview: {
      type: 'boolean',
      description: 'Include translated values in output',
      default: false,
    },
  },
  async run({ args }) {
    const targetLocales = args.targets === 'all'
      ? 'all'
      : splitList(args.targets)

    const result = await translateKey({
      layer: args.layer,
      key: args.key,
      sourceLocale: args.sourceLocale,
      sourceValue: args.sourceValue,
      targetLocales,
      overwrite: args.overwrite,
      dryRun: args.dryRun,
      includePreview: args.includePreview,
      projectDir: args.projectDir,
      // No samplingFn — CLI returns fallback context unless dry-run/no-op.
    })
    outputResult(result, args)
  },
})
