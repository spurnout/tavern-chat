import pino, { type Logger } from 'pino';

export function createLogger(env: string): Logger {
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
