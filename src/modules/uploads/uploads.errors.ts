import { AppException } from "@/common/errors/app.exception";

export class UploadTooLargeException extends AppException { constructor() { super("UPLOAD_TOO_LARGE"); } }
export class UploadInvalidTypeException extends AppException { constructor() { super("UPLOAD_INVALID_TYPE"); } }
