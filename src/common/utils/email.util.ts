/**
 * Placeholder addresses minted for accounts that have no real email.
 *
 * `users.email` is NOT NULL and UNIQUE, so an account created from a phone OTP
 * (or a partner onboarded by number) still needs *something* in the column. The
 * synthetic value satisfies the constraint but no mailbox exists behind it —
 * sending to one earns a hard bounce and, repeated, damages the sending
 * domain's reputation.
 */
const SYNTHETIC_EMAIL_DOMAINS = /@(firebase\.user|stub\.user|partners\.local)$/i;

/**
 * The form every lookup keys on.
 *
 * `auth.service` has been lowercasing and trimming inline at a dozen call
 * sites; anything that writes `users.email` has to agree with that or the
 * account becomes unfindable at sign-in.
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/** True when mail addressed here can actually reach a person. */
export function isDeliverableEmail(email?: string | null): boolean {
  if (!email) return false;
  const trimmed = email.trim();
  if (!trimmed || !trimmed.includes("@")) return false;
  return !SYNTHETIC_EMAIL_DOMAINS.test(trimmed);
}
