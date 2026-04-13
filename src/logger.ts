/**
 * Minimal structured logger that writes to STDERR.
 *
 * Why stderr? The stdio MCP transport uses STDOUT for JSON-RPC framing.
 * Any `console.log` or process.stdout.write in the server would corrupt
 * the protocol stream. All diagnostic output MUST go to stderr.
 */

type LogFields = Record<string, unknown>;

function write(level: 'info' | 'warn' | 'error', event: string, fields?: LogFields): void {
  const entry = {
    level,
    time: new Date().toISOString(),
    event,
    ...fields,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  info: (event: string, fields?: LogFields) => write('info', event, fields),
  warn: (event: string, fields?: LogFields) => write('warn', event, fields),
  error: (event: string, fields?: LogFields) => write('error', event, fields),
};
