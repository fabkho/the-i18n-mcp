#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

try {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
} catch (error) {
  process.stderr.write(`[the-i18n-mcp] Fatal error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
