import { ERROR_CODES, ErrorCode } from "./error-codes";

export interface FieldError {
  field: string;
  code: string;
  message: string;
  constraint?: Record<string, unknown>;
  received?: unknown;
}

export abstract class AppException extends Error {
  public readonly statusCode: number;
  public readonly errorCode: ErrorCode;
  public readonly fieldErrors: FieldError[];
  public readonly details?: Record<string, unknown>;
  public readonly isOperational: boolean;

  constructor(
    errorCode: ErrorCode,
    messageOverride?: string,
    fieldErrors: FieldError[] = [],
    details?: Record<string, unknown>,
    isOperational = true
  ) {
    const meta = ERROR_CODES[errorCode];
    super(messageOverride ?? meta.message);
    this.name = this.constructor.name;
    this.statusCode = meta.status;
    this.errorCode = errorCode;
    this.fieldErrors = fieldErrors;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace?.(this, this.constructor);
  }
}
