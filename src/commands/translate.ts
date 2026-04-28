import { defineCommand } from 'citty'
import { translateMissing } from '../core/operations.js'
import { sharedArgs, outputResult, splitList } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'translate',
    description: 'Find missing translations and return fallback contexts for translation',
  },
  args: {
    ...sharedArgs,
    layer: {
      type: 'string',
      description: 'Layer name',
      required: true,
    },
    ref: {
      type: 'string',
      description: 'Reference locale (default: project default)',
    },
    targets: {
      type: 'string',
      description: 'Comma-separated target locales (default: all except ref)',
    },
    keys: {
      type: 'string',
      description: 'Comma-separated keys to translate (default: all missing)',
    },
    batchSize: {
      type: 'string',
      description: 'Batch size (default: 50)',
    },
    dryRun: {
      type: 'boolean',
      description: 'Preview what would be translated',
      default: false,
    },
  },
  async run({ args }) {
    const batchSize = args.batchSize ? parseInt(args.batchSize, 10) : undefined
    const result = await translateMissing({
      layer: args.layer,
      referenceLocale: args.ref,
      targetLocales: splitList(args.targets),
      keys: splitList(args.keys),
      batchSize,
      dryRun: args.dryRun,
      projectDir: args.projectDir,
      // No samplingFn — CLI always returns fallback contexts
    })
    outputResult(result, args)
  },
})
