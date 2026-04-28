import { defineCommand } from 'citty'
import { cleanupUnusedTranslations } from '../core/operations.js'
import { sharedArgs, outputResult } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'cleanup',
    description: 'Find and remove translation keys not referenced in source code',
  },
  args: {
    ...sharedArgs,
    layer: {
      type: 'string',
      description: 'Filter to a specific layer',
    },
    locale: {
      type: 'string',
      description: 'Locale to check (default: project default)',
    },
    dryRun: {
      type: 'boolean',
      description: 'Preview without removing (default: true)',
      default: true,
    },
  },
  async run({ args }) {
    const result = await cleanupUnusedTranslations({
      layer: args.layer,
      locale: args.locale,
      dryRun: args.dryRun,
      projectDir: args.projectDir,
    })
    outputResult(result, args)
  },
})
