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
  },
  async run({ args }) {
    const result = await findEmptyTranslations({
      layer: args.layer,
      locale: args.locale,
      projectDir: args.projectDir,
    })
    outputResult(result, args)
  },
})
