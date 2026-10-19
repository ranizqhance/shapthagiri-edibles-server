import { AppException } from "../app.exception";
import { ErrorCode } from "../error-codes";

export class IntegrationException extends AppException {
  constructor(code: ErrorCode = "INT_GATEWAY_ERROR", msg?: string, details?: Record<string, unknown>, cause?: Error) {
    super(code, msg, [], { ...details, cause: cause?.message }, false);
  }
}
export class DatabaseException extends IntegrationException { constructor(cause?: Error) { super("INT_DB_ERROR", undefined, undefined, cause); } }
export class GeocodingException extends IntegrationException { constructor(cause?: Error) { super("INT_GEOCODING_FAILED", undefined, undefined, cause); } }
export class SmsProviderException extends IntegrationException { constructor(cause?: Error) { super("INT_SMS_FAILED", undefined, undefined, cause); } }
/** Phone OTP is not verifiable right now — the customer should use email. */
export class OtpPhoneUnavailableException extends IntegrationException { constructor(cause?: Error) { super("OTP_PHONE_UNAVAILABLE", undefined, undefined, cause); } }
export class EmailProviderException extends IntegrationException { constructor(cause?: Error) { super("INT_EMAIL_FAILED", undefined, undefined, cause); } }
export class StorageException extends IntegrationException { constructor(cause?: Error) { super("INT_STORAGE_FAILED", undefined, undefined, cause); } }
