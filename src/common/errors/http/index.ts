import { AppException, FieldError } from "../app.exception";
import { ErrorCode } from "../error-codes";

export class BadRequestException extends AppException {
  constructor(code: ErrorCode = "BAD_REQUEST", msg?: string, fields: FieldError[] = [], details?: Record<string, unknown>) {
    super(code, msg, fields, details);
  }
}
export class UnauthorizedException extends AppException {
  constructor(code: ErrorCode = "UNAUTHORIZED", msg?: string) { super(code, msg); }
}
export class ForbiddenException extends AppException {
  constructor(code: ErrorCode = "FORBIDDEN", msg?: string) { super(code, msg); }
}
export class NotFoundException extends AppException {
  constructor(code: ErrorCode = "NOT_FOUND", msg?: string) { super(code, msg); }
}
export class ConflictException extends AppException {
  constructor(code: ErrorCode = "CONFLICT", msg?: string, details?: Record<string, unknown>) {
    super(code, msg, [], details);
  }
}
export class UnprocessableEntityException extends AppException {
  constructor(code: ErrorCode = "VALIDATION_FAILED", msg?: string, fields: FieldError[] = []) {
    super(code, msg, fields);
  }
}
export class TooManyRequestsException extends AppException {
  constructor(code: ErrorCode = "RATE_LIMITED", msg?: string) { super(code, msg); }
}
/** 413 — the upload exceeded the size the endpoint accepts. */
export class PayloadTooLargeException extends AppException {
  constructor(code: ErrorCode = "UPLOAD_TOO_LARGE", msg?: string) { super(code, msg); }
}
export class InternalServerErrorException extends AppException {
  constructor(code: ErrorCode = "INTERNAL_ERROR", msg?: string, details?: Record<string, unknown>, cause?: Error) {
    super(code, msg, [], { ...details, cause: cause?.message }, false);
  }
}
