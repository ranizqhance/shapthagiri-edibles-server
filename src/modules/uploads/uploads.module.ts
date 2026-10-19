import { Controller, Module, Post, Req, UploadedFile, UseInterceptors, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import { FileInterceptor } from "@nestjs/platform-express";
import multer from "multer";
import { Request } from "express";
import { resolveUploadOrUrl } from "@/common/utils/upload-resolver.util";
import { UploadInvalidTypeException } from "./uploads.errors";
import { Throttle } from "@nestjs/throttler";

/**
 * The whole string must be one of these types.
 *
 * The anchors have to sit outside the alternation: written as
 * `/^image\/(png|jpe?g|webp)|video\/(mp4|webm)|application\/pdf$/` the `^` binds
 * only to the first branch and the `$` only to the last, so "notvideo/mp4x"
 * passed the filter.
 */
const ALLOWED = /^(?:image\/(?:png|jpe?g|webp)|video\/(?:mp4|webm)|application\/pdf)$/;

/**
 * The only prefixes an upload may be written to.
 *
 * `?folder=` went straight into the S3 object key with no validation at all —
 * no allowlist, no `../` strip, no length bound — so any authenticated user
 * chose where their bytes landed in the bucket, including prefixes the
 * bucket policy treats differently from product images.
 *
 * Anything unrecognised falls back to `general` rather than erroring, so an
 * older client passing a folder we have since retired keeps working.
 */
// `invoices` is deliberately NOT here: it is written by the server only, never
// by an upload, and nothing should be able to drop a file into it.
const UPLOAD_FOLDERS = new Set(["products", "documents", "disputes", "returns", "reviews", "general"]);

function resolveFolder(requested?: string): string {
  const folder = (requested ?? "").trim().toLowerCase();
  return UPLOAD_FOLDERS.has(folder) ? folder : "general";
}

@ApiTags("Uploads")
@ApiBearerAuth()
@Controller("uploads")
export class UploadsController {
  // 10 MB per file straight into the bucket, from any authenticated account —
  // a storage and egress bill with no ceiling before this.
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @Post()
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary", description: "EITHER upload a file..." },
        url:  { type: "string", description: "...OR pass a URL — never both, never neither" },
      },
    },
  })
  @UseInterceptors(FileInterceptor("file", {
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED.test(file.mimetype)) return cb(new UploadInvalidTypeException() as any, false);
      cb(null, true);
    },
  }))
  async upload(@Req() req: Request, @UploadedFile() _file: Express.Multer.File, @Query("folder") folder?: string) {
    const url = await resolveUploadOrUrl(req, "url", resolveFolder(folder));
    return { url };
  }
}

@Module({ controllers: [UploadsController] })
export class UploadsModule {}
