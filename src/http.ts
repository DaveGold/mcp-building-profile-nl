#!/usr/bin/env node
/**
 * Optional streamable-HTTP entrypoint.
 *
 * ⚠️  This transport has NO AUTHENTICATION. It binds to 127.0.0.1 by default.
 *     Do NOT expose it on a public interface — anyone who can reach the port
 *     can make unlimited requests against your EP-Online API key.
 *
 * Use this when you want to run the server as a long-lived background process
 * (for example, to share a single EP-Online quota across multiple agents on
 * the same machine) instead of the default stdio transport.
 *
 * Start: `PORT=3000 node dist/http.js`
 */

import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { logger } from './logger.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      // Stateless: one fresh McpServer + transport pair per request.
      // Simple and scales fine for a single-user local setup.
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('http.handler_error', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.listen(PORT, HOST, () => {
    logger.info('server.started', { transport: 'http', host: HOST, port: PORT });
    process.stderr.write(
      `\nmcp-building-profile-nl listening on http://${HOST}:${PORT}/mcp\n` +
        `⚠️  No auth — keep this bound to localhost.\n\n`
    );
  });
}

main().catch((error) => {
  logger.error('server.fatal', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
