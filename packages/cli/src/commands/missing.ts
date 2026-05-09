import { defineCommand } from 'citty'
import { getMissingTranslations } from '../core/operations.js'
import { sharedArgs, outputResult, splitList } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'missing',
    description: 'Find translation keys missing in target locales',
  },
  args: {
    ...sharedArgs,
    layer: {
      type: 'string',
      description: 'Filter to a specific layer',
    },
    ref: {
      type: 'string',
      description: 'Reference locale (default: project default)',
    },
    targets: {
      type: 'string',
      description: 'Comma-separated target locales (default: all except ref)',
    },
    outputFile: {
      type: 'string',
      description: 'Write full output to this file path and return only a summary (useful for large outputs)',
    },
  },
  async run({ args }) {
    const result = await getMissingTranslations({
      layer: args.layer,
      referenceLocale: args.ref,
      targetLocales: splitList(args.targets),
      projectDir: args.projectDir,
      outputFile: args.outputFile,
    })
    outputResult(result, args)
  },
})
