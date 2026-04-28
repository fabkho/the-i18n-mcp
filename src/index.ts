#!/usr/bin/env node

/**
 * Smart entrypoint: routes to CLI (citty) or MCP server mode.
 *
 * - MCP mode: when no subcommand is given (backward compat for MCP clients)
 * - CLI mode: when any argument is present (citty handles all commands including `serve`)
 */

const args = process.argv.slice(2)

if (args.length === 0) {
  // No arguments at all → MCP server mode (backward compat)
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
  // Any arguments → CLI mode (citty handles subcommands, --help, errors)
  import('./cli.js').then(m => m.runCli())
}
