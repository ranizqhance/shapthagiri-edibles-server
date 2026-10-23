import path from "node:path";
import { env } from "@/config/env";
import { StorageException } from "@/common/errors/integration";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import { logger } from "@/common/utils/logger";

/**
 * Object storage — S3 only.
 *
 * There is deliberately no local-disk fallback: writing uploads onto the app
 * server produces files that survive no redeploy, exist on only one instance
 * behind a load balancer, and silently diverge from what the database records.
 * If S3 is not configured we fail loudly at upload time rather than writing
 * somewhere that looks fine in development and loses data in production.
 */
/** MP4 brands we accept (major brand at bytes 8-12 of the ftyp box). */
const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash", "MSNV"]);

/** Upload prefixes whose objects the API may delete. Not `invoices/`. */
const DELETABLE_PREFIXES = ["products", "categories", "avatars", "documents", "disputes", "returns", "reviews", "general"];

/** Our bucket's public host, e.g. "my-bucket.s3.us-east-1.amazonaws.com"; null when S3 is not configured. */
export function mediaHost(): string | null {
  return env.AWS_S3_BUCKET && env.AWS_REGION ? `${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com` : null;
}

/**
 * Is this a URL of a file we store? https on our bucket's host only. With S3
 * unconfigured (local development) any https URL passes — nothing is stored
 * then anyway.
 */
export function isOwnMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = mediaHost();
    return host ? u.host === host : true;
  } catch {
    return false;
  }
}

export class StorageProvider {
  private s3Client?: S3Client;

  constructor() {
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION && env.AWS_S3_BUCKET) {
      this.s3Client = new S3Client({
        // Nothing bounded these calls: a stalled connection held the upload
        // request (and its 10 MB buffer) open indefinitely.
        requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000 },
        region: env.AWS_REGION,
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
      });
    } else {
      logger.error(
        "S3 is not configured (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION / AWS_S3_BUCKET) — uploads will be rejected"
      );
    }
  }

  /**
   * The content type, decided by the file's own bytes.
   *
   * This used to read the extension off the client-supplied filename, which
   * meant the browser was told whatever the uploader wanted. Two of the types
   * it would emit — `image/svg+xml` and `image/gif` — are not even in the
   * upload allowlist, and SVG is a scripting format: declaring the multipart
   * part as `image/png` while naming the file `x.svg` got attacker-authored
   * markup stored under `Content-Type: image/svg+xml` and served from the
   * bucket origin. That is stored XSS, and nothing about the filename check
   * could catch it.
   *
   * Magic bytes instead, with no third-party dependency: these four
   * signatures are the entire set this system stores.
   */
  private sniffContentType(buffer: Buffer): string | null {
    const startsWith = (...bytes: number[]) =>
      bytes.every((b, i) => buffer[i] === b);

    if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
    if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
    if (startsWith(0x25, 0x50, 0x44, 0x46)) return "application/pdf";           // %PDF
    if (buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
        buffer.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
    // ISO-BMFF ("....ftyp<brand>") is a family, not a format: AVIF, HEIC and
    // other containers share it. Only real MP4 brands are video/mp4 — an AVIF
    // used to be stored as video/mp4 because the box name alone matched.
    if (buffer.subarray(4, 8).toString("latin1") === "ftyp") {
      return MP4_BRANDS.has(buffer.subarray(8, 12).toString("latin1")) ? "video/mp4" : null;
    }
    // EBML is Matroska's header too; WebM declares its DocType early on.
    if (startsWith(0x1a, 0x45, 0xdf, 0xa3)) {
      return buffer.subarray(0, 64).includes("webm") ? "video/webm" : null;
    }

    return null;
  }

  /** The extension that matches a sniffed type — never the client's. */
  private extensionFor(contentType: string): string {
    switch (contentType) {
      case "image/jpeg": return ".jpg";
      case "image/png": return ".png";
      case "image/webp": return ".webp";
      case "application/pdf": return ".pdf";
      case "video/mp4": return ".mp4";
      case "video/webm": return ".webm";
      default: return "";
    }
  }

  async saveBuffer(buffer: Buffer, originalName: string, folder = "general"): Promise<string> {
    if (!this.s3Client) {
      throw new StorageException(
        new Error("Object storage is not configured — refusing to store the upload locally")
      );
    }
    /*
     * Reject anything we cannot positively identify. Refusing an unknown file
     * is cheaper than serving one under a type we guessed.
     */
    const contentType = this.sniffContentType(buffer);
    if (!contentType) {
      throw new StorageException(
        new Error("Unrecognised file contents — only JPEG, PNG, WebP, PDF, MP4 and WebM are accepted"),
      );
    }

    try {
      // Extension derived from the sniffed type, so the key, the stored
      // Content-Type and the actual bytes can never disagree.
      const uniqueName = `${uuidv4()}${this.extensionFor(contentType)}`;
      const objectKey = folder ? `${folder}/${uniqueName}` : uniqueName;

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: env.AWS_S3_BUCKET,
          Key: objectKey,
          Body: buffer,
          ContentType: contentType,
          /**
           * Uploads carried no cache header at all, so every S3-hosted image
           * was re-fetched on every page view — measured against a same-origin
           * file it was 2.5x the bytes and roughly double the time to first
           * byte, purely because nothing could cache it.
           *
           * `immutable` is unconditionally safe here in a way it is not for
           * ordinary static files: the key is a fresh UUID per upload, so an
           * object is never replaced in place. Changing a product photo writes
           * a new key and updates the database row.
           */
          CacheControl: "public, max-age=31536000, immutable",
        })
      );
      return `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${objectKey}`;
    } catch (e) {
      throw new StorageException(e as Error);
    }
  }

  async deleteFile(url: string): Promise<void> {
    try {
      if (!url || !this.s3Client) return;
      // Only objects of OUR bucket, under an upload prefix. Any S3-looking URL
      // used to pass (".s3." + "amazonaws.com"), and the key was taken from its
      // path and deleted from our bucket — so a client-supplied media URL
      // could delete any object, archived invoices included.
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.host !== mediaHost()) return;
      const key = decodeURIComponent(parsed.pathname.substring(1));
      if (!DELETABLE_PREFIXES.some((p) => key.startsWith(`${p}/`))) return;
      await this.s3Client.send(
        new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key })
      );
    } catch (e) {
      // Logged, not thrown: a failed cleanup must not roll back the business
      // operation that triggered it.
      logger.warn(`Failed to delete object: ${url}`, { error: (e as Error).message });
    }
  }
}

export const storageProvider = new StorageProvider();
