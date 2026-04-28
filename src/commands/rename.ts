import { defineCommand } from 'citty'
import { renameTranslationKey } from '../core/operations.js'
import { sharedArgs, outputResult } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'rename',
    description: 'Rename/move a translation key across all locale files',
  },
  args: {
    ...sharedArgs,
    layer: {
      type: 'string',
      description: 'Layer name',
      required: true,
    },
    oldKey: {
      type: 'string',
      description: 'Current key path',
      required: true,
    },
    newKey: {
      type: 'string',
      description: 'New key path',
      required: true,
    },
    dryRun: {
      type: 'boolean',
      description: 'Preview changes without writing',
      default: false,
    },
  },
  async run({ args }) {
    const result = await renameTranslationKey({
      layer: args.layer,
      oldKey: args.oldKey,
      newKey: args.newKey,
      dryRun: args.dryRun,
      projectDir: args.projectDir,
    })
    outputResult(result, args)
  },
})
