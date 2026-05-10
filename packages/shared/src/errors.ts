export const ErrorCodes = {
  // Generic
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',

  // Auth
  UNAUTHORIZED: 'UNAUTHORIZED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_TOKEN: 'INVALID_TOKEN',
  EXPIRED_TOKEN: 'EXPIRED_TOKEN',
  INVALID_INVITE: 'INVALID_INVITE',
  REGISTRATION_DISABLED: 'REGISTRATION_DISABLED',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  EMAIL_TAKEN: 'EMAIL_TAKEN',

  // Servers / channels
  CHANNEL_HIDDEN: 'CHANNEL_HIDDEN',
  WRONG_CHANNEL_TYPE: 'WRONG_CHANNEL_TYPE',
  MEMBER_TIMED_OUT: 'MEMBER_TIMED_OUT',

  // Uploads / media
  UPLOAD_BLOCKED: 'UPLOAD_BLOCKED',
  UPLOAD_QUARANTINED: 'UPLOAD_QUARANTINED',
  UPLOAD_NOT_READY: 'UPLOAD_NOT_READY',
  SCANNER_UNAVAILABLE: 'SCANNER_UNAVAILABLE',

  // Tabletop
  INVALID_DICE_NOTATION: 'INVALID_DICE_NOTATION',
  CAMPAIGN_LOCKED: 'CAMPAIGN_LOCKED',

  // Moderation
  CONTENT_HELD: 'CONTENT_HELD',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',

  // Voice
  VOICE_UNAVAILABLE: 'VOICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ApiErrorBody {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export interface ApiSuccessBody<T> {
  ok: true;
  data: T;
}

export type ApiResponse<T> = ApiSuccessBody<T> | ApiErrorBody;

export class TavernError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = 'TavernError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON(): ApiErrorBody {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }

  static unauthorized(message = 'Authentication required'): TavernError {
    return new TavernError(ErrorCodes.UNAUTHORIZED, message, 401);
  }

  static forbidden(message = 'You do not have permission'): TavernError {
    return new TavernError(ErrorCodes.PERMISSION_DENIED, message, 403);
  }

  static notFound(message = 'Not found'): TavernError {
    return new TavernError(ErrorCodes.NOT_FOUND, message, 404);
  }

  static conflict(code: ErrorCode, message: string): TavernError {
    return new TavernError(code, message, 409);
  }

  static validation(message = 'Invalid input', details?: unknown): TavernError {
    return new TavernError(ErrorCodes.VALIDATION_ERROR, message, 400, details);
  }

  static rateLimited(message = 'Too many requests'): TavernError {
    return new TavernError(ErrorCodes.RATE_LIMITED, message, 429);
  }

  static internal(message = 'Internal server error'): TavernError {
    return new TavernError(ErrorCodes.INTERNAL_ERROR, message, 500);
  }
}
