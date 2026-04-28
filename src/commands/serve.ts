import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'serve',
    description: 'Start MCP server on stdio transport',
  },
  args: {},
  async run() {
    const { createServer } = await import('../server.js')
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
    const server = createServer()
    const transport = new StdioServerTransport()
    await server.connect(transport)
    // Server runs until process exits
  },
})
