import { BRAND } from "@/common/brand";

/**
 * The frame every transactional email is sent in: wordmark band with the
 * tagline, the message on white, and a contact footer. Inline styles only —
 * email clients strip <style>.
 */
export function brandedEmail(inner: string): string {
  return `
      <div style="background:${BRAND.surface};padding:24px 12px;font-family:Arial,sans-serif">
        <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid ${BRAND.border};border-radius:14px;overflow:hidden;color:${BRAND.ink}">
          <div style="background:${BRAND.primary};padding:16px 24px;border-bottom:3px solid ${BRAND.amber}">
            <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:3px;font-family:Georgia,'Times New Roman',serif">${BRAND.wordmark}</div>
            <div style="color:${BRAND.onPrimary};font-size:12px;font-style:italic;margin-top:2px">${BRAND.tagline}</div>
          </div>
          <div style="padding:24px;line-height:1.55">${inner}</div>
          <div style="background:${BRAND.surface};border-top:1px solid ${BRAND.border};padding:12px 24px;font-size:11px;color:${BRAND.muted};text-align:center">
            ${BRAND.legalName} &middot; ${BRAND.addressLine}<br/>${BRAND.email} &middot; ${BRAND.phone}
          </div>
        </div>
      </div>`;
}

/** Escapes text for interpolation into the HTML above. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * A plain-text notification (title + body) in the branded frame. Line breaks
 * in the body become <br/>; everything is escaped.
 */
export function brandedTextEmail(title: string, body: string): string {
  const paragraphs = escapeHtml(body)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return brandedEmail(`<h2 style="color:${BRAND.primaryDark};margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2>${paragraphs}`);
}
