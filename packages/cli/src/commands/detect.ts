import { defineCommand } from 'citty'
import { detectConfig } from '../core/operations.js'
import { sharedArgs, outputResult } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'detect',
    description: 'Detect i18n configuration from the project',
  },
  args: {
    ...sharedArgs,
  },
  async run({ args }) {
    const result = await detectConfig(args.projectDir)
    outputResult(result, args)
  },
})
