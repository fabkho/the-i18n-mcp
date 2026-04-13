import { writeFile, readFile, rename, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FileIOError } from '../utils/errors'
import { sortKeysDeep } from './key-operations'
import { clearPhpFileCacheEntry } from './php-reader'

export interface PhpWriteOptions {
  quoteStyle?: 'single' | 'double'
  indent?: string
  sortKeys?: boolean
}

export async function writePhpLocaleFile(
  filePath: string,
  data: Record<string, unknown>,
  options: PhpWriteOptions = {},
): Promise<void> {
  const {
    quoteStyle = 'double',
    indent = '    ',
    sortKeys = true,
  } = options

  try {
    const outputData = sortKeys ? sortKeysDeep(data) : data
    const content = serializePhpArray(outputData, quoteStyle, indent)

    await mkdir(dirname(filePath), { recursive: true })
    const tmpPath = join(dirname(filePath), `.${randomUUID()}.tmp`)

    try {
      await writeFile(tmpPath, content, 'utf-8')
      await rename(tmpPath, filePath)
      clearPhpFileCacheEntry(filePath)
    }
    catch (error) {
      try { await unlink(tmpPath) }
      catch { /* ignore cleanup errors */ }
      throw error
    }
  }
  catch (error) {
    if (error instanceof FileIOError) throw error
    throw new FileIOError(
      `Failed to write PHP locale file: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    )
  }
}

function serializePhpArray(
  data: Record<string, unknown>,
  quoteStyle: 'single' | 'double',
  indent: string,
): string {
  const q = quoteStyle === 'single' ? '\'' : '"'
  const lines: string[] = ['<?php', '', 'return [']

  renderEntries(data, lines, q, indent, 1)

  lines.push('];', '')
  return lines.join('\n')
}

function renderEntries(
  obj: Record<string, unknown>,
  lines: string[],
  q: string,
  indent: string,
  depth: number,
): void {
  const prefix = indent.repeat(depth)
  const entries = Object.entries(obj)

  for (const [key, value] of entries) {
    const escapedKey = escapePhpString(key, q)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${prefix}${q}${escapedKey}${q} => [`)
      renderEntries(value as Record<string, unknown>, lines, q, indent, depth + 1)
      lines.push(`${prefix}],`)
    }
    else {
      const escapedValue = escapePhpString(String(value), q)
      lines.push(`${prefix}${q}${escapedKey}${q} => ${q}${escapedValue}${q},`)
    }
  }
}

function escapePhpString(str: string, quote: string): string {
  if (quote === '\'') {
    return str.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')
  }
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export async function detectPhpFileStyle(filePath: string): Promise<{ quoteStyle: 'single' | 'double'; indent: string }> {
  if (!existsSync(filePath)) {
    return { quoteStyle: 'double', indent: '    ' }
  }

  try {
    const content = await readFile(filePath, 'utf-8')
    return detectPhpStyle(content)
  }
  catch {
    return { quoteStyle: 'double', indent: '    ' }
  }
}

export function detectPhpStyle(content: string): { quoteStyle: 'single' | 'double'; indent: string } {
  const singleCount = (content.match(/'\w+'\s*=>/g) || []).length
  const doubleCount = (content.match(/"\w+"\s*=>/g) || []).length
  const quoteStyle: 'single' | 'double' = singleCount >= doubleCount ? 'single' : 'double'

  const indentMatch = content.match(/^([ \t]+)['"]/m)
  const indent = indentMatch ? indentMatch[1] : '    '

  return { quoteStyle, indent }
}

export async function mutatePhpLocaleFile(
  filePath: string,
  mutate: (data: Record<string, unknown>) => void,
): Promise<void> {
  const { readPhpLocaleFile } = await import('./php-reader.js')
  const data = await readPhpLocaleFile(filePath)
  const rawContent = await readFile(filePath, 'utf-8')
  const { quoteStyle, indent } = detectPhpStyle(rawContent)
  mutate(data)
  await writePhpLocaleFile(filePath, data, { quoteStyle, indent })
}
