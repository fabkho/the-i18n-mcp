import { defineCommand } from 'citty'
import { listLocaleDirs } from '../core/operations.js'
import { sharedArgs, outputResult } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'list-dirs',
    description: 'List all i18n locale directories, grouped by layer',
  },
  args: {
    ...sharedArgs,
  },
  async run({ args }) {
    const result = await listLocaleDirs(args.projectDir)
    outputResult(result, args)
  },
})
