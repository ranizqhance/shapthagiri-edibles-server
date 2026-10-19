import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { Request, Response } from "express";
import { translateError } from "../errors/translators";
import { ErrorResponseDto } from "@/common/dto/error-response.dto";
import { isProd } from "@/config/env";
import { AppException, FieldError } from "@/common/errors/app.exception";
import { UnprocessableEntityException } from "@/common/errors/http";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();

    let exc: AppException;

    if (exception instanceof HttpException) {
      const r: any = exception.getResponse();
      // ValidationPipe returns { message: ..., error, statusCode }. main.ts's
      // exceptionFactory makes `message` an array of { field, message } so the
      // failing property survives; plain strings are still handled for any
      // HttpException thrown with a bare string[] body.
      if (Array.isArray(r?.message)) {
        const fields: FieldError[] = (r.message as any[]).map((m) =>
          typeof m === "string"
            ? { field: "body", code: "VALIDATION", message: m }
            : { field: m.field ?? "body", code: "VALIDATION", message: m.message },
        );
        exc = new UnprocessableEntityException("VALIDATION_FAILED", undefined, fields);
      } else {
        exc = translateError(exception);
      }
    } else {
      exc = translateError(exception);
    }

    const isServerError = exc.statusCode >= 500;
    const body: ErrorResponseDto = {
      success: false,
      statusCode: exc.statusCode,
      errorCode: exc.errorCode,
      message: exc.message,
      errors: exc.fieldErrors,
      details: isProd ? undefined : exc.details,
      path: req.originalUrl,
      method: req.method,
      correlationId: (req as any).id ?? "",
      timestamp: new Date().toISOString(),
    };

    const meta = { correlationId: body.correlationId, route: `${req.method} ${req.originalUrl}`, statusCode: exc.statusCode, errorCode: exc.errorCode };
    if (isServerError) {
      this.logger.error(`${exc.message} ${JSON.stringify(meta)}`, (exc as Error).stack);
      if (exc.details) {
        console.error("Original underlying exception details:", exc.details);
      }
    } else {
      this.logger.warn(`${exc.message} ${JSON.stringify(meta)}`);
    }

    res.status(exc.statusCode).json(body);
  }
}
