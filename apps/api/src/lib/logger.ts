import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Pino is structurally compatible with FastifyBaseLogger but its concrete
 * `Logger` type adds members (notably `msgPrefix`) that FastifyBaseLogger
 * doesn't declare. Narrowing the return type here lets `loggerInstance` be
 * assigned cleanly without an `as any` cast at the call site.
 */
export function createLogger(env: string): FastifyBaseLogger {
  if (env === 'production') {
    return pino({ level: process.env.LOG_LEVEL ?? 'info' });
  }
  return pino({
    level: process.env.LOG_LEVEL ?? 'debug',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
    },
  });
}
