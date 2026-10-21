/**
 * The browser origins CORS_ORIGINS allows, with `www.` treated as the same
 * site: https://example.com <-> https://www.example.com. Mapping a domain
 * usually produces both hosts, and configuring only one silently breaks every
 * call from the other. Accepting the www counterpart of a configured origin
 * cannot widen access to any other registrable domain. Skipped for localhost
 * and bare IPs, which have no www form.
 *
 * Shared by the HTTP CORS check (main.ts) and the socket gateway, so the two
 * can never disagree about who may connect.
 */
export function expandCorsOrigins(configured: string): string[] {
  const allowed = new Set<string>();
  for (const raw of configured.split(",")) {
    const origin = raw.trim().replace(/\/$/, "");
    if (!origin) continue;
    allowed.add(origin);
    let host: string;
    try { host = new URL(origin).hostname; } catch { continue; }
    const isRealDomain = host.includes(".") && !/^\d+(\.\d+)*$/.test(host);
    if (isRealDomain) {
      allowed.add(
        host.startsWith("www.")
          ? origin.replace("://www.", "://")
          : origin.replace("://", "://www."),
      );
    }
  }
  return [...allowed];
}
