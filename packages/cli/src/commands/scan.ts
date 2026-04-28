import { defineCommand } from 'citty'
import { scanCodeUsageOp } from '../core/operations.js'
import { sharedArgs, outputResult, splitList } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'scan',
    description: 'Scan source code for translation key usage',
  },
  args: {
    ...sharedArgs,
    keys: {
      type: 'string',
      description: 'Comma-separated keys to report on (default: all)',
    },
  },
  async run({ args }) {
    const result = await scanCodeUsageOp({
      keys: splitList(args.keys),
      projectDir: args.projectDir,
    })
    outputResult(result, args)
  },
})
