import { defineCommand } from 'citty'
import { scaffoldLocaleFiles } from '../core/operations.js'
import { sharedArgs, outputResult, splitList } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'scaffold',
    description: 'Create empty locale files for new languages',
  },
  args: {
    ...sharedArgs,
    locales: {
      type: 'string',
      description: 'Comma-separated locale codes to scaffold',
    },
    layer: {
      type: 'string',
      description: 'Filter to a specific layer',
    },
    dryRun: {
      type: 'boolean',
      description: 'Preview without writing',
      default: false,
    },
  },
  async run({ args }) {
    const locales = splitList(args.locales)
    if (locales && locales.length === 0) {
      throw new Error('No locales provided. Pass comma-separated locale codes via --locales')
    }
    const result = await scaffoldLocaleFiles({
      locales,
      layer: args.layer,
      dryRun: args.dryRun,
      projectDir: args.projectDir,
    })
    outputResult(result, args)
  },
})
