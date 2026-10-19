import { Request } from "express";
import { storageProvider } from "@/common/providers/storage.provider";
import { BadRequestException } from "@/common/errors/http";

/**
 * Resolves an upload field that accepts EITHER an uploaded file (multipart) OR a URL
 * in the JSON body — never both, never neither. Returns a single string URL.
 *
 * Use when models keep a single column for the resource (e.g. `url`, `avatarUrl`,
 * `imageUrl`, `photoUrl`, `signatureUrl`).
 *
 * @param req       Express request (after multer.single(fieldName))
 * @param fieldName JSON body key whose value is the URL alternative (e.g. "url", "avatarUrl")
 */
export async function resolveUploadOrUrl(req: Request, fieldName = "url", folder = "general"): Promise<string> {
  const file = (req as any).file as Express.Multer.File | undefined;
  const url: string | undefined = req.body?.[fieldName];

  const hasFile = !!file;
  const hasUrl = typeof url === "string" && url.trim().length > 0;

  if (hasFile && hasUrl) {
    throw new BadRequestException(
      "BAD_REQUEST",
      `Provide either '${fieldName}' (URL) or upload a file — not both`,
      [{ field: fieldName, code: "MUTUALLY_EXCLUSIVE", message: "Cannot supply both URL and file" }]
    );
  }
  if (!hasFile && !hasUrl) {
    throw new BadRequestException(
      "BAD_REQUEST",
      `Provide either '${fieldName}' (URL) or upload a file`,
      [{ field: fieldName, code: "REQUIRED", message: "URL or file required" }]
    );
  }

  if (hasFile) return storageProvider.saveBuffer(file!.buffer, file!.originalname, folder);
  return url!.trim();
}
