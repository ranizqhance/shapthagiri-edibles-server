/**
 * Presentation helpers for scheduled finance reports: email validation, CSV export,
 * and the branded email body + printable (PDF) HTML. No hardcoded business
 * data — every value is passed in by the caller from the live report.
 */

/** Shreshtam palette (maroon + mango/gold on warm cream). */
const BRAND = {
  name: "Shreshtam",
  wordmark: "SHRESHTAM",
  tagline: "The Taste of Valluvanad",
  primary: "#871604",
  primaryDark: "#6C1203",
  accent: "#F49C44",
  gold: "#C8A165",
  surface: "#FBF6EE",
  ink: "#2B1D17",
  muted: "#6E5C50",
  border: "#EADFCC",
};

export interface ReportSummaryItem { label: string; value: string }
export interface ReportTable { columns: string[]; rows: (string | number)[][] }

const escapeHtml = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/* ───────────────── email address validation ───────────────── */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Dedupe (case-insensitive), split valid vs invalid. Order preserved. */
export function normalizeRecipients(input: unknown): { valid: string[]; invalid: string[] } {
  const list = Array.isArray(input) ? input : typeof input === "string" ? String(input).split(",") : [];
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of list) {
    const e = String(raw ?? "").trim();
    if (!e) continue;
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (EMAIL_RE.test(e) ? valid : invalid).push(e);
  }
  return { valid, invalid };
}

/* ───────────────── schedule → cron ───────────────── */

export interface ScheduleSpec {
  frequency: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
  /** "HH:MM" 24h. Defaults to 09:00. */
  time?: string;
  /** 0=Sun … 6=Sat (weekly). */
  weekday?: number;
  /** 1–31 day of month (monthly / quarterly / yearly). */
  monthDay?: number;
  /** 1–12 month (yearly). */
  month?: number;
}

const clamp = (n: number, lo: number, hi: number, dflt: number) =>
  Number.isFinite(n) && n >= lo && n <= hi ? Math.trunc(n) : dflt;

/**
 * Builds a standard 5-field cron (`min hour dom mon dow`) from a business-friendly
 * schedule, so admins never touch cron syntax. Quarterly = the 1st month of each
 * quarter (Jan/Apr/Jul/Oct). Throws on an unknown frequency.
 */
export function cronFromSchedule(spec: ScheduleSpec): string {
  const [hhRaw, mmRaw] = String(spec.time ?? "09:00").split(":");
  const hour = clamp(Number(hhRaw), 0, 23, 9);
  const min = clamp(Number(mmRaw), 0, 59, 0);
  const dom = clamp(Number(spec.monthDay), 1, 31, 1);
  const dow = clamp(Number(spec.weekday), 0, 6, 1);
  const mon = clamp(Number(spec.month), 1, 12, 1);

  switch (spec.frequency) {
    case "daily": return `${min} ${hour} * * *`;
    case "weekly": return `${min} ${hour} * * ${dow}`;
    case "monthly": return `${min} ${hour} ${dom} * *`;
    case "quarterly": return `${min} ${hour} ${dom} 1,4,7,10 *`;
    case "yearly": return `${min} ${hour} ${dom} ${mon} *`;
    default: throw new Error(`Unsupported frequency: ${(spec as any).frequency}`);
  }
}

/* ───────────────── CSV ───────────────── */

const csvCell = (v: unknown): string => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(table: ReportTable): string {
  const head = table.columns.map(csvCell).join(",");
  const body = table.rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  return `${head}\r\n${body}\r\n`;
}

/* ───────────────── branded email body ───────────────── */

export function brandedReportEmail(opts: {
  title: string;
  generatedAt: Date;
  periodLabel: string;
  summary: ReportSummaryItem[];
  attachmentsNote?: string;
}): string {
  const rows = opts.summary
    .map(
      (s) => `<tr>
        <td style="padding:10px 16px;border-bottom:1px solid ${BRAND.border};color:${BRAND.muted};font-size:13px">${escapeHtml(s.label)}</td>
        <td style="padding:10px 16px;border-bottom:1px solid ${BRAND.border};text-align:right;font-weight:600;color:${BRAND.ink};font-size:13px">${escapeHtml(s.value)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html><html><body style="margin:0;background:${BRAND.surface};padding:24px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid ${BRAND.border};border-radius:16px;overflow:hidden">
      <div style="background:${BRAND.primary};padding:18px 24px;border-bottom:3px solid ${BRAND.gold}">
        <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:3px;font-family:Georgia,'Times New Roman',serif">${BRAND.wordmark}</div>
        <div style="color:${BRAND.accent};font-size:12px;font-style:italic;letter-spacing:.5px;margin-top:2px">${BRAND.tagline}</div>
      </div>
      <div style="padding:24px">
        <h1 style="margin:0 0 4px;font-size:20px;color:${BRAND.primaryDark}">${escapeHtml(opts.title)}</h1>
        <p style="margin:0;color:${BRAND.muted};font-size:12px">Generated ${opts.generatedAt.toLocaleString("en-IN")}</p>
        <p style="margin:2px 0 20px;color:${BRAND.muted};font-size:12px">Reporting period: ${escapeHtml(opts.periodLabel)}</p>
        <table style="width:100%;border-collapse:collapse;border:1px solid ${BRAND.border};border-radius:10px;overflow:hidden">${rows}</table>
        <p style="margin:20px 0 0;color:${BRAND.muted};font-size:12px">${escapeHtml(opts.attachmentsNote ?? "The full report is attached.")}</p>
      </div>
      <div style="background:${BRAND.surface};padding:14px 24px;color:${BRAND.muted};font-size:11px;text-align:center">
        This is an automated financial report from ${BRAND.name} &mdash; ${BRAND.tagline}. Do not reply to this email.
      </div>
    </div>
  </body></html>`;
}

/* ───────────────── printable (PDF) HTML ───────────────── */

export function printableReportHtml(opts: {
  title: string;
  generatedAt: Date;
  periodLabel: string;
  summary: ReportSummaryItem[];
  table?: ReportTable;
}): string {
  const summaryRows = opts.summary
    .map((s) => `<tr><td>${escapeHtml(s.label)}</td><td style="text-align:right;font-weight:600">${escapeHtml(s.value)}</td></tr>`)
    .join("");
  const tableHtml = opts.table
    ? `<h3 style="margin:24px 0 8px;color:${BRAND.primaryDark}">Details</h3>
       <table class="grid">
         <thead><tr>${opts.table.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
         <tbody>${opts.table.rows.map((r) => `<tr>${r.map((c, i) => `<td style="${i === 0 ? "" : "text-align:right"}">${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody>
       </table>`
    : "";

  return `<html><head><style>
    body{font-family:Arial,Helvetica,sans-serif;color:${BRAND.ink};padding:32px}
    .head{border-bottom:3px solid ${BRAND.primary};padding-bottom:16px;margin-bottom:20px}
    .brand{color:${BRAND.primary};font-size:22px;font-weight:700;letter-spacing:3px;font-family:Georgia,'Times New Roman',serif}
    .tagline{color:${BRAND.gold};font-size:12px;font-style:italic;margin:2px 0 0}
    h2{margin:8px 0 2px;font-size:18px;color:${BRAND.primaryDark}}
    .muted{color:${BRAND.muted};font-size:12px;margin:0}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    td,th{padding:8px 12px;border-bottom:1px solid ${BRAND.border};font-size:13px}
    .grid th{background:${BRAND.surface};text-align:left}
  </style></head><body>
    <div class="head">
      <div class="brand">${BRAND.wordmark}</div>
      <p class="tagline">${BRAND.tagline}</p>
      <h2>${escapeHtml(opts.title)}</h2>
      <p class="muted">Generated ${opts.generatedAt.toLocaleString("en-IN")} &nbsp;·&nbsp; Period: ${escapeHtml(opts.periodLabel)}</p>
    </div>
    <table>${summaryRows}</table>
    ${tableHtml}
  </body></html>`;
}
