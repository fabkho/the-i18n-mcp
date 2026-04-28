import { createRequire } from 'node:module'
import { defineCommand, runCommand } from 'citty'
import { consola } from 'consola'
import { commands } from './commands/index.js'

const require = createRequire(import.meta.url)
const { version, description } = require('../package.json') as { version: string; description: string }

const main = defineCommand({
  meta: {
    name: 'the-i18n-mcp',
    version,
    description,
  },
  subCommands: commands,
})

export async function runCli(): Promise<void> {
  const rawArgs = process.argv.slice(2)

  try {
    // Check for --help / --version before running
    if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
      // Let citty handle help display
      const { runMain } = await import('citty')
      await runMain(main)
      return
    }

    if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
      process.stdout.write(version + '\n')
      return
    }

    await runCommand(main, { rawArgs })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    consola.error(message)
    if (rawArgs.includes('--debug') && error instanceof Error && error.stack) {
      consola.error(error.stack)
    }
    process.exitCode = 1
  }
}
