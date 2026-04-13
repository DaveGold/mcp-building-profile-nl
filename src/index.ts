#!/usr/bin/env node
/**
 * stdio entrypoint — the default way to run this server.
 *
 * This is what Claude Desktop, Claude Code, VS Code Copilot, and MCP Inspector
 * all expect when launching a local MCP server. The protocol is framed over
 * stdin/stdout; stderr is free for diagnostics.
 *
 * Start: `node dist/index.js` (or `mcp-building-profile-nl` after `npm install`).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('server.started', { transport: 'stdio' });
}

main().catch((error) => {
  logger.error('server.fatal', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
