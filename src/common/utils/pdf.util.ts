import { Logger } from "@nestjs/common";
import { withRenderSlot } from "./render-gate.util";

const logger = new Logger("Pdf");

/**
 * Chromium launch flags.
 *
 * `--no-sandbox` is here deliberately, and this is the second time these flags
 * have been changed, so the reasoning is worth writing down properly.
 *
 * It was removed on the grounds that invoices render customer-supplied text.
 * That broke production: the API container runs `USER node` (see Dockerfile)
 * with the distro Chromium, and Chromium's setuid sandbox cannot start as an
 * unprivileged user without `SYS_ADMIN`, so every invoice returned a 500. The
 * previous comment here told the reader to grant that capability instead —
 * which is poor advice. `--cap-add=SYS_ADMIN` hands the container broad
 * privileges on the host to buy a sandbox *inside* a boundary that already
 * exists. That trade is a net loss.
 *
 * What actually protects this path:
 *   - every value interpolated into the invoice is HTML-escaped
 *     (`OrdersService.esc`), and image URLs are scheme-checked (`safeImg`);
 *   - request interception below blocks `file://` and every non-HTTPS fetch,
 *     so a page cannot read local files or reach internal addresses;
 *   - the API runs in its own container, which is the isolation boundary;
 *   - `withRenderSlot` bounds how many browsers exist at once.
 *
 * Set `PDF_SANDBOX=1` to keep Chromium's own sandbox where the host is
 * configured for it (rootless Docker, or a seccomp profile permitting
 * unprivileged user namespaces).
 */
function launchArgs(): string[] {
  const base = ["--disable-dev-shm-usage"];
  if (process.env.PDF_SANDBOX === "1") return base;
  return [...base, "--no-sandbox", "--disable-setuid-sandbox"];
}

/**
 * Which URLs a rendered document may fetch.
 *
 * These documents are self-contained: text, inline CSS, and product images
 * from our own storage over HTTPS. Everything else is refused, so a
 * `file:///etc/passwd` or an internal address pasted into an address line is
 * neither a local-file read nor an SSRF with the result baked into a PDF the
 * attacker then downloads.
 *
 * `about:blank` has to be allowed: `setContent` navigates there first, and
 * aborting that navigation leaves the call hanging until its timeout.
 *
 * HTTPS on its own is not enough, which is why the host is checked too:
 * `https://localhost` and `https://169.254.169.254` are both HTTPS. The
 * invoice renderer blocked `https://localhost` before these three launch
 * sites were merged; this keeps that and names the rest of the range.
 */
const BLOCKED_RENDER_HOSTS =
  /^(localhost|0\.0\.0\.0|\[?::1\]?|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

export function isAllowedResource(url: string): boolean {
  if (url === "about:blank" || url.startsWith("data:")) return true;
  if (!url.startsWith("https://")) return false;
  try {
    return !BLOCKED_RENDER_HOSTS.test(new URL(url).hostname);
  } catch {
    // An unparseable URL is not something a document needs.
    return false;
  }
}

export interface PdfOptions {
  /** Page margins. Statements use 20px; the invoice supplies its own CSS. */
  margin?: { top: string; bottom: string; left: string; right: string };
}

/**
 * Render HTML to a PDF via headless Chrome.
 *
 * The ONE implementation. There were three: this file, a byte-for-byte private
 * copy in `finance.module.ts`, and a third inline in `OrdersService`. Changing
 * the flags in one silently left the others alone, which is precisely how a
 * launch-flag change reached production on one path and not the others.
 *
 * Callers must pass HTML that is already escaped. This function cannot tell
 * the difference and does not try.
 */
export async function htmlToPdf(html: string, label = "pdf", opts: PdfOptions = {}): Promise<Buffer> {
  return withRenderSlot(label, async () => {
    const puppeteerMod: any = await import("puppeteer");
    const puppeteer = puppeteerMod.default ?? puppeteerMod;

    const browser = await puppeteer.launch({ headless: true, args: launchArgs() });
    try {
      const page = await browser.newPage();

      await page.setRequestInterception(true);
      page.on("request", (req: any) =>
        isAllowedResource(req.url()) ? req.continue() : req.abort(),
      );

      /*
       * Bounded, but with real headroom.
       *
       * A whole invoice render takes 8-10s on a developer machine, most of it
       * browser start-up plus fetching the product image from S3. A container
       * under load is slower than that, so the original 10s on `setContent`
       * was close enough to the measured time to fail on a bad day — trading
       * one outage for an intermittent one. The job of these timeouts is to
       * stop an indefinite hang holding a Chromium process and an Express
       * worker, not to be tight.
       */
      await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        ...(opts.margin ? { margin: opts.margin } : {}),
        timeout: 30_000,
      });
      return Buffer.from(pdf);
    } catch (e) {
      // Named explicitly: a bare 500 on an invoice gives nobody anything to go on.
      logger.error(`${label} render failed: ${(e as Error).message}`);
      throw e;
    } finally {
      await browser.close();
    }
  });
}
