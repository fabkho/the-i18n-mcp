import { describe, expect, it, afterAll } from 'vitest'
import { appAdminDir, registerDetectorMock } from '../fixtures/mock-detector.js'

registerDetectorMock()

const {
  clearConfigCache,
} = await import('../../src/config/detector.js')
const {
  translateKey,
  translateMissing,
  validatePlaceholders,
} = await import('../../src/core/operations.js')

afterAll(() => {
  clearConfigCache()
})

describe('translate_key', () => {
  it('dry-runs source-based translation for all target locales', async () => {
    const result = await translateKey({
      projectDir: appAdminDir,
      layer: 'root',
      key: 'admin.users.export',
      sourceLocale: 'en-US',
      sourceValue: 'Export {count} users',
      targetLocales: 'all',
      dryRun: true,
      includePreview: true,
    })

    expect(result.dryRun).toBe(true)
    expect(result.sourceLocale).toMatchObject({ code: 'en', language: 'en-US', file: 'en-US.json' })
    expect(result.updatedSource).toBe(true)
    expect(result.translated).toEqual(expect.arrayContaining(['de', 'fr', 'es']))
    expect(result.placeholderValidation).toEqual({
      ok: true,
      placeholders: ['{count}'],
      errors: [],
    })
    expect(result.preview).toEqual({ en: 'Export {count} users' })
  })

  it('deduplicates explicit targets and excludes source locale', async () => {
    const result = await translateKey({
      projectDir: appAdminDir,
      layer: 'root',
      key: 'admin.users.export',
      sourceLocale: 'en-US',
      sourceValue: 'Export users',
      targetLocales: ['en-US', 'de-DE', 'de-DE.json', 'fr-FR'],
      dryRun: true,
    })

    expect(result.translated).toEqual(['de', 'fr'])
  })

  it('skips existing targets when overwrite is false', async () => {
    const result = await translateKey({
      projectDir: appAdminDir,
      layer: 'root',
      key: 'admin.dashboard.title',
      sourceLocale: 'en-US',
      targetLocales: ['de-DE', 'fr-FR'],
      overwrite: false,
      dryRun: true,
    })

    expect(result.translated).toEqual([])
    expect(result.skipped).toEqual(['de', 'fr'])
  })
})

describe('placeholder validation', () => {
  it('detects missing and extra placeholders', () => {
    const result = validatePlaceholders(
      'bookingCreator.options.removeSubResource',
      'Remove {subResource}',
      [
        { locale: 'de', value: '{resource} entfernen' },
        { locale: 'fr', value: 'Supprimer {subResource}' },
      ],
    )

    expect(result.ok).toBe(false)
    expect(result.placeholders).toEqual(['{subResource}'])
    expect(result.errors).toEqual([
      {
        locale: 'de',
        key: 'bookingCreator.options.removeSubResource',
        missing: ['{subResource}'],
        extra: ['{resource}'],
      },
    ])
  })
})

describe('translate_missing metadata', () => {
  it('returns locale metadata and per-locale reason', async () => {
    const result = await translateMissing({
      projectDir: appAdminDir,
      layer: 'root',
      referenceLocale: 'de-DE',
      targetLocales: ['es-ES'],
      keys: ['admin.users.list'],
      dryRun: true,
    })

    expect(result.summary.referenceLocale).toMatchObject({ code: 'de', language: 'de-DE', file: 'de-DE.json' })
    expect(result.summary.targetLocales).toEqual([
      expect.objectContaining({ code: 'es', language: 'es-ES', file: 'es-ES.json' }),
    ])
    expect(result.results.es).toMatchObject({
      translated: ['admin.users.list'],
      failed: [],
      samplingUsed: false,
      reason: 'dry-run',
    })
  })
})
