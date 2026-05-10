import type { ApiSuccessBody, ApiErrorBody, ErrorCode } from '@tavern/shared';

export function ok<T>(data: T): ApiSuccessBody<T> {
  return { ok: true, data };
}

export function fail(code: ErrorCode, message: string, details?: unknown): ApiErrorBody {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
}
