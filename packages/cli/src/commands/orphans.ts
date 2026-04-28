import { defineCommand } from 'citty'
import { findOrphanKeysOp } from '../core/operations.js'
import { sharedArgs, outputResult } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'orphans',
    description: 'Find translation keys not referenced in source code',
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
  },
  async run({ args }) {
    const result = await findOrphanKeysOp({
      layer: args.layer,
      locale: args.locale,
      projectDir: args.projectDir,
    })
    outputResult(result, args)
  },
})
