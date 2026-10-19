import { HttpException, HttpStatus } from "@nestjs/common";
import { ValidationError as ClassValidatorError } from "class-validator";
import { BaseError, UniqueConstraintError, ValidationError as SeqValidationError, ForeignKeyConstraintError } from "sequelize";
import { JsonWebTokenError, TokenExpiredError } from "jsonwebtoken";
import { ThrottlerException } from "@nestjs/throttler";
import { AppException, FieldError } from "../app.exception";
import {
  UnprocessableEntityException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  BadRequestException,
  TooManyRequestsException,
  PayloadTooLargeException,
  InternalServerErrorException,
} from "../http";
import { DatabaseException } from "../integration";

function flattenValidationErrors(errors: ClassValidatorError[], parent = ""): FieldError[] {
  const out: FieldError[] = [];
  for (const err of errors) {
    const path = parent ? `${parent}.${err.property}` : err.property;
    if (err.constraints) {
      for (const [code, message] of Object.entries(err.constraints)) {
        out.push({ field: path, code: code.toUpperCase(), message, received: err.value });
      }
    }
    if (err.children?.length) out.push(...flattenValidationErrors(err.children, path));
  }
  return out;
}

export function translateError(err: unknown): AppException {
  if (err instanceof AppException) return err;

  // Multer rejects an oversized file before the handler runs, and its error is
  // a plain Error with a `code`. Untranslated it surfaced as an opaque 500, so
  // someone uploading a large phone photo was told nothing useful.
  // Nest's FileInterceptor catches multer's error and rethrows its own
  // BadRequestException carrying only multer's message, so the size limit
  // arrives here as a 400 with the string below rather than a LIMIT_ code.
  // Matching it is narrow, but the alternative is telling someone their 12 MB
  // photo was a "bad request".
  if (err instanceof HttpException) {
    const resp = err.getResponse() as any;
    const msg = typeof resp === "string" ? resp : resp?.message;
    if (msg === "File too large") {
      return new PayloadTooLargeException("UPLOAD_TOO_LARGE", "That file is larger than the 10 MB limit.");
    }
  }

  const multerCode = (err as any)?.code;
  if (typeof multerCode === "string" && multerCode.startsWith("LIMIT_")) {
    if (multerCode === "LIMIT_FILE_SIZE") {
      return new PayloadTooLargeException("UPLOAD_TOO_LARGE", "That file is larger than the 10 MB limit.");
    }
    return new BadRequestException("BAD_REQUEST", (err as Error).message || "Upload rejected");
  }

  // class-validator array
  if (Array.isArray(err) && err.length && err[0] instanceof ClassValidatorError) {
    return new UnprocessableEntityException("VALIDATION_FAILED", undefined, flattenValidationErrors(err as ClassValidatorError[]));
  }

  // Sequelize
  if (err instanceof UniqueConstraintError) {
    return new ConflictException("CONFLICT", "Duplicate value violates a unique constraint", {
      fields: err.fields,
    });
  }
  if (err instanceof SeqValidationError) {
    const fields: FieldError[] = err.errors.map((e) => ({
      field: e.path ?? "unknown",
      code: (e.validatorKey ?? "INVALID").toUpperCase(),
      message: e.message,
      received: e.value,
    }));
    return new UnprocessableEntityException("VALIDATION_FAILED", undefined, fields);
  }
  if (err instanceof ForeignKeyConstraintError) {
    return new BadRequestException("BAD_REQUEST", "Related resource does not exist");
  }
  if (err instanceof BaseError) {
    return new DatabaseException(err);
  }

  // Rate limiting. ThrottlerException is a plain Nest HttpException, so without
  // this it fell through to the unknown branch and every throttled request came
  // back as a 500 — indistinguishable from a server fault, and impossible for a
  // client to back off from.
  if (err instanceof ThrottlerException) {
    return new TooManyRequestsException("RATE_LIMITED", "Too many requests. Please wait a moment and try again.");
  }

  // JWT
  if (err instanceof TokenExpiredError) return new UnauthorizedException("AUTH_TOKEN_EXPIRED");
  if (err instanceof JsonWebTokenError) return new UnauthorizedException("AUTH_TOKEN_INVALID");

  // Raw NestJS HttpExceptions — the framework's own (an unmatched route throws
  // NotFoundException) and any thrown from @nestjs/common rather than our
  // ../http wrappers. Without this they reached the unknown branch below and
  // every one of them was reported as a 500: a mistyped URL answered
  // "Something went wrong on our end", which hides real server faults in the
  // logs and tells the client to retry something that will never succeed.
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const raw: any = err.getResponse();
    const msg = typeof raw === "string" ? raw : raw?.message;
    const text = Array.isArray(msg) ? msg.join(", ") : msg;
    switch (status) {
      case HttpStatus.BAD_REQUEST:        return new BadRequestException("BAD_REQUEST", text);
      case HttpStatus.UNAUTHORIZED:       return new UnauthorizedException("UNAUTHORIZED", text);
      case HttpStatus.FORBIDDEN:          return new ForbiddenException("FORBIDDEN", text);
      case HttpStatus.NOT_FOUND:          return new NotFoundException("NOT_FOUND", text);
      case HttpStatus.CONFLICT:           return new ConflictException("CONFLICT", text);
      case HttpStatus.TOO_MANY_REQUESTS:  return new TooManyRequestsException("RATE_LIMITED", text);
      default:
        if (status < 500) return new BadRequestException("BAD_REQUEST", text);
        return new InternalServerErrorException("INTERNAL_ERROR", undefined, undefined, err);
    }
  }

  // Unknown
  const e = err instanceof Error ? err : new Error(String(err));
  console.error("Unknown error caught in translateError:", e);
  return new InternalServerErrorException("INTERNAL_ERROR", undefined, undefined, e);
}
