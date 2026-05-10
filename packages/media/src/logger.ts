/**
 * Minimal structural Logger interface so packages/media doesn't depend on pino.
 * Both api and worker pass their pino logger in — pino's instance shape
 * satisfies this.
 */

export interface Logger {
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  debug?(obj: object, msg?: string): void;
}
