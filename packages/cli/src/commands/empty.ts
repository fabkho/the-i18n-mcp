import { defineCommand } from 'citty'
import { findEmptyTranslations } from '../core/operations.js'
import { sharedArgs, outputResult } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'empty',
    description: 'Find translation keys with empty string values',
  },
  args: {
    ...sharedArgs,
    layer: {
      type: 'string',
      description: 'Filter to a specific layer',
    },
    locale: {
      type: 'string',
      description: 'Filter to a specific locale',
    },
    outputFile: {
      type: 'string',
      description: 'Write full output to this file path and return only a summary (useful for large outputs)',
    },
  },
  async run({ args }) {
    const result = await findEmptyTranslations({
      layer: args.layer,
      locale: args.locale,
      projectDir: args.projectDir,
      outputFile: args.outputFile,
    })
    outputResult(result, args)
  },
})
