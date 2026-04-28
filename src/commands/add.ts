import { defineCommand } from 'citty'
import { addTranslations } from '../core/operations.js'
import { sharedArgs, outputResult, parseJsonArg } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'add',
    description: 'Add new translation keys (skips keys that already exist)',
  },
  args: {
    ...sharedArgs,
    layer: {
      type: 'string',
      description: 'Layer name',
      required: true,
    },
    translations: {
      type: 'string',
      description: 'JSON: { "key": { "en": "val", "de": "val" } }',
      required: true,
    },
    dryRun: {
      type: 'boolean',
      description: 'Preview changes without writing',
      default: false,
    },
  },
  async run({ args }) {
    const translations = parseJsonArg<Record<string, Record<string, string>>>(
      args.translations,
      'translations',
    )
    const result = await addTranslations({
      layer: args.layer,
      translations,
      dryRun: args.dryRun,
      projectDir: args.projectDir,
    })
    outputResult(result, args)
  },
})
