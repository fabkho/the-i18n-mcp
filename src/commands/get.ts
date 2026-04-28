import { defineCommand } from 'citty'
import { getTranslations } from '../core/operations.js'
import { sharedArgs, outputResult, splitList } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'get',
    description: 'Get translation values for specific keys',
  },
  args: {
    ...sharedArgs,
    layer: {
      type: 'string',
      description: 'Layer name',
      required: true,
    },
    locale: {
      type: 'string',
      description: 'Locale code, or "*" for all',
      required: true,
    },
    keys: {
      type: 'string',
      description: 'Comma-separated key paths',
      required: true,
    },
  },
  async run({ args }) {
    const keys = splitList(args.keys) ?? []
    const result = await getTranslations({
      layer: args.layer,
      locale: args.locale,
      keys,
      projectDir: args.projectDir,
    })
    outputResult(result, args)
  },
})
