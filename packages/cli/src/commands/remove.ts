import { defineCommand } from 'citty'
import { removeTranslations } from '../core/operations.js'
import { sharedArgs, outputResult, splitList } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove translation keys from all locale files in a layer',
  },
  args: {
    ...sharedArgs,
    layer: {
      type: 'string',
      description: 'Layer name',
      required: true,
    },
    keys: {
      type: 'string',
      description: 'Comma-separated key paths to remove',
      required: true,
    },
    dryRun: {
      type: 'boolean',
      description: 'Preview changes without writing',
      default: false,
    },
  },
  async run({ args }) {
    const keys = splitList(args.keys) ?? []
    if (keys.length === 0) {
      throw new Error('No keys provided. Pass comma-separated key paths via --keys')
    }
    const result = await removeTranslations({
      layer: args.layer,
      keys,
      dryRun: args.dryRun,
      projectDir: args.projectDir,
    })
    outputResult(result, args)
  },
})
