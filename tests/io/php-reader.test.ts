import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPhpLocaleFile, clearPhpFileCache } from '../../src/io/php-reader.js'
import { FileIOError } from '../../src/utils/errors.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'php-reader-test-'))
  clearPhpFileCache()
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('readPhpLocaleFile', () => {
  it('reads a flat PHP array file into Record<string, unknown>', async () => {
    const filePath = join(tempDir, 'auth.php')
    await writeFile(filePath, `<?php

return [
    'failed' => 'These credentials do not match our records.',
    'throttle' => 'Too many login attempts.',
];
`)

    const data = await readPhpLocaleFile(filePath)
    expect(data).toEqual({
      failed: 'These credentials do not match our records.',
      throttle: 'Too many login attempts.',
    })
  })

  it('reads nested PHP arrays into nested objects', async () => {
    const filePath = join(tempDir, 'validation.php')
    await writeFile(filePath, `<?php

return [
    'accepted' => 'The :attribute must be accepted.',
    'custom' => [
        'email' => [
            'required' => 'We need your email address.',
        ],
    ],
];
`)

    const data = await readPhpLocaleFile(filePath)
    expect(data).toEqual({
      accepted: 'The :attribute must be accepted.',
      custom: {
        email: {
          required: 'We need your email address.',
        },
      },
    })
  })

  it('handles :placeholder values and | pluralization', async () => {
    const filePath = join(tempDir, 'messages.php')
    await writeFile(filePath, `<?php

return [
    'welcome' => 'Welcome, :name!',
    'items' => '{0} No items|{1} One item|[2,*] :count items',
];
`)

    const data = await readPhpLocaleFile(filePath)
    expect(data.welcome).toBe('Welcome, :name!')
    expect(data.items).toBe('{0} No items|{1} One item|[2,*] :count items')
  })

  it('returns cached data when file mtime has not changed', async () => {
    const filePath = join(tempDir, 'cached.php')
    await writeFile(filePath, `<?php\nreturn ['a' => '1'];\n`)

    const first = await readPhpLocaleFile(filePath)
    const second = await readPhpLocaleFile(filePath)
    expect(first).toEqual(second)
    expect(first).not.toBe(second) // structuredClone returns different reference
  })

  it('invalidates cache when file mtime changes', async () => {
    const filePath = join(tempDir, 'changing.php')
    await writeFile(filePath, `<?php\nreturn ['key' => 'old'];\n`)

    const first = await readPhpLocaleFile(filePath)
    expect(first.key).toBe('old')

    await writeFile(filePath, `<?php\nreturn ['key' => 'new'];\n`)
    // Ensure mtime actually differs
    const future = new Date(Date.now() + 2000)
    await utimes(filePath, future, future)

    const second = await readPhpLocaleFile(filePath)
    expect(second.key).toBe('new')
  })

  it('throws FileIOError for non-existent file', async () => {
    const filePath = join(tempDir, 'nope.php')
    await expect(readPhpLocaleFile(filePath)).rejects.toThrow(FileIOError)
    await expect(readPhpLocaleFile(filePath)).rejects.toThrow(/File not found/)
  })

  it('throws FileIOError for malformed PHP', async () => {
    const filePath = join(tempDir, 'bad.php')
    await writeFile(filePath, `not php at all, just garbage`)

    await expect(readPhpLocaleFile(filePath)).rejects.toThrow(FileIOError)
    await expect(readPhpLocaleFile(filePath)).rejects.toThrow(/Failed to read PHP locale file/)
  })
})
