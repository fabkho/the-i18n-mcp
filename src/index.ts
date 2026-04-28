#!/usr/bin/env node

/**
 * Smart entrypoint: routes to CLI or MCP server mode.
 *
 * - MCP mode: when no subcommand is given (backward compat for MCP clients)
 *   or when `serve` is explicitly passed
 * - CLI mode: when any other subcommand argument is passed (e.g., `the-i18n-mcp detect`)
 */

const args = process.argv.slice(2)
const command = args.find(a => !a.startsWith('-'))

// Known CLI commands (anything other than 'serve' or no command)
const CLI_COMMANDS = new Set([
  'detect', 'list-dirs', 'get', 'add', 'update', 'missing', 'empty',
  'search', 'remove', 'rename', 'translate', 'orphans', 'scan',
  'cleanup', 'scaffold',
])

const wantsHelp = args.includes('--help') || args.includes('-h')

if (command && CLI_COMMANDS.has(command)) {
  // CLI mode
  import('./cli.js').then(m => m.runCli())
} else if (command === 'serve' || (!command && !wantsHelp)) {
  // MCP server mode — default when no command (backward compat) or explicit `serve`
  import('./server.js').then(async ({ createServer }) => {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
    const { log } = await import('./utils/logger.js')

    log.info('Starting the-i18n-mcp server...')
    const server = createServer()
    const transport = new StdioServerTransport()
    await server.connect(transport)
    log.info('the-i18n-mcp server running on stdio')
  }).catch((error) => {
    process.stderr.write(`Fatal error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
} else {
  // --help with no command, or unknown command → CLI help
  import('./cli.js').then(m => m.runCli())
}
