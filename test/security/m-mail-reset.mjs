// Password reset by email, end to end. Local test API and database only.
//
// This script runs its own SMTP catcher on 127.0.0.1:2525, so start the API
// pointed at it (dotenv does not override variables already set):
//
//   ENABLE_EMAIL=true MAIL_HOST=127.0.0.1 MAIL_PORT=2525 MAIL_SECURE=false \
//   MAIL_USER=sink MAIL_PASS=sink DOTENV_CONFIG_PATH=.env.localtest node dist/main.js
//
// It asks for two resets for the fixture customer, and forgot-password allows
// three an hour per address: a second run within the hour needs a fresh Redis.
//
// With PROD_GATE=1 it checks the other half instead: an API started with
// NODE_ENV=production and no mail credentials must refuse to "send" a reset
// link or a code, rather than report success with nothing sent.
import net from "node:net";
import { api, data, login, q, check, section, done, said, clientIp } from "./lib.mjs";

const EMAIL = "customer@shapthagiri-edibles.com";
const PASSWORD = "customer";
const ip = () => ({ "x-forwarded-for": clientIp() });

if (process.env.PROD_GATE === "1") {
  section("production with no mail credentials: refuse, don't pretend");
  const before = await q(`select count(*)::int n from users where "passwordResetTokenHash" is not null`);
  const known = await api("POST", "/auth/forgot-password", { body: { email: EMAIL }, headers: ip() });
  const unknown = await api("POST", "/auth/forgot-password", { body: { email: `nobody-${Date.now()}@example.com` }, headers: ip() });
  check("forgot-password → 503 EMAIL_NOT_CONFIGURED", known.status === 503 && known.json?.errorCode === "EMAIL_NOT_CONFIGURED", said(known));
  check("same answer for an unregistered address (no account probing)", unknown.status === known.status && unknown.json?.errorCode === known.json?.errorCode && unknown.json?.message === known.json?.message, said(unknown));
  const after = await q(`select count(*)::int n from users where "passwordResetTokenHash" is not null`);
  check("no reset token was issued", after[0].n === before[0].n, `${before[0].n} → ${after[0].n}`);
  const otp = await api("POST", "/auth/otp/email/send", { body: { email: EMAIL }, headers: ip() });
  check("sign-in code by email → 503, not \"code sent\"", otp.status === 503 && otp.json?.errorCode === "EMAIL_NOT_CONFIGURED", said(otp));
  const reg = await api("POST", "/auth/register/send-otp", { body: { email: `new-${Date.now()}@example.com`, name: "Probe" }, headers: ip() });
  check("registration code → 503, not \"code sent\"", reg.status === 503 && reg.json?.errorCode === "EMAIL_NOT_CONFIGURED", said(reg));
  await done();
  process.exit(process.exitCode ?? 0);
}

// ── A catcher standing in for Gmail ───────────────────────────────────────
const inbox = [];
const sink = net.createServer((sock) => {
  let buf = "", body = null, auth = 0;
  const say = (s) => sock.write(s + "\r\n");
  say("220 sink");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    for (let i; (i = buf.indexOf("\r\n")) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (body) {
        if (line === ".") { inbox.push(body.join("\n")); body = null; say("250 queued"); }
        else body.push(line.startsWith("..") ? line.slice(1) : line);
      } else if (auth) { auth = auth === 1 ? 2 : 0; say(auth ? "334 UGFzc3dvcmQ6" : "235 ok"); }
      else if (/^EHLO/i.test(line)) sock.write("250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
      else if (/^AUTH LOGIN$/i.test(line)) { auth = 1; say("334 VXNlcm5hbWU6"); }
      else if (/^AUTH LOGIN /i.test(line)) { auth = 2; say("334 UGFzc3dvcmQ6"); }
      else if (/^AUTH/i.test(line)) say("235 ok");
      else if (/^DATA/i.test(line)) { body = []; say("354 go"); }
      else if (/^QUIT/i.test(line)) { say("221 bye"); sock.end(); }
      else say("250 ok");
    }
  });
  sock.on("error", () => {});
});
await new Promise((resolve) => sink.listen(2525, "127.0.0.1", resolve));

const waitForMail = async (count, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (inbox.length >= count) return inbox[count - 1];
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};
// Quoted-printable bodies wrap long lines with "=" and escape "=" as "=3D".
const unQP = (s) => s.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

const [{ passwordHash: originalHash }] = await q(`select "passwordHash" from users where email = $1`, [EMAIL]);
const oldSession = await login(EMAIL, PASSWORD, ip());

try {
  section("the reset email goes out, to the right person, with a working link");
  const r = await api("POST", "/auth/forgot-password", { body: { email: "Customer@Shapthagiri-Edibles.com" }, headers: ip() });
  check("forgot-password → 200 with the neutral message", r.status === 200 && /If an account exists/.test(data(r)?.message ?? ""), said(r));
  const raw = await waitForMail(1);
  check("an email reached the SMTP server", !!raw);
  const mail = unQP(raw ?? "");
  check("addressed to the account's email (typed in another case)", new RegExp(`^To: .*${EMAIL}`, "mi").test(mail));
  check("subject says it is a password reset", /^Subject: Reset your .* password/mi.test(mail));
  const link = mail.match(/https?:\/\/[^\s"'<>]+\/reset-password\?token=([0-9a-f]{64})/);
  check("body links to <web>/reset-password?token=<64 hex>", !!link, link?.[0]?.replace(/token=.*/, "token=…"));
  check("link points at the storefront (first CORS origin)", !!link && link[0].startsWith("http://localhost:9174/"), link?.[0]?.split("/reset")[0]);
  const token = link?.[1] ?? "";

  section("an unregistered address gets the same answer and no email");
  const u = await api("POST", "/auth/forgot-password", { body: { email: `nobody-${Date.now()}@example.com` }, headers: ip() });
  check("same status and message", u.status === r.status && data(u)?.message === data(r)?.message, said(u));
  check("no second email", (await waitForMail(2, 1500)) === null);

  section("the token: wrong, used, reused");
  const bad = await api("POST", "/auth/reset-password", { body: { token: "0".repeat(64), password: "Another#Pass2026" }, headers: ip() });
  check("a made-up token → 400", bad.status === 400, said(bad));
  const ok = await api("POST", "/auth/reset-password", { body: { token, password: "Fresh#Reset2026" }, headers: ip() });
  check("the emailed token sets the new password", ok.status === 200 && data(ok)?.reset === true, said(ok));
  const again = await api("POST", "/auth/reset-password", { body: { token, password: "Second#Use2026" }, headers: ip() });
  check("the same token a second time → 400 (single use)", again.status === 400, said(again));

  section("after the reset");
  const me = await api("GET", "/auth/me", { token: oldSession.accessToken });
  check("sessions from before the reset are revoked (access token)", me.status === 401, said(me));
  const refresh = await api("POST", "/auth/refresh", { body: { refreshToken: oldSession.refreshToken }, headers: ip() });
  check("…and the refresh token", refresh.status === 401, said(refresh));
  const oldPw = await api("POST", "/auth/login", { body: { email: EMAIL, password: PASSWORD }, headers: ip() });
  check("old password no longer signs in", oldPw.status === 401, said(oldPw));
  const newPw = await api("POST", "/auth/login", { body: { email: EMAIL, password: "Fresh#Reset2026" }, headers: ip() });
  check("new password signs in", newPw.status === 200, said(newPw));

  section("an expired link");
  await api("POST", "/auth/forgot-password", { body: { email: EMAIL }, headers: ip() });
  const second = unQP((await waitForMail(2)) ?? "").match(/reset-password\?token=([0-9a-f]{64})/)?.[1];
  await q(`update users set "passwordResetExpiresAt" = now() - interval '1 minute' where email = $1`, [EMAIL]);
  const expired = await api("POST", "/auth/reset-password", { body: { token: second, password: "Late#Reset2026" }, headers: ip() });
  check("a link past its 30 minutes → 400", !!second && expired.status === 400, said(expired));
} finally {
  // Put the fixture account back exactly as the other scripts expect it.
  await q(`update users set "passwordHash" = $2, "passwordResetTokenHash" = null, "passwordResetExpiresAt" = null where email = $1`, [EMAIL, originalHash]);
  sink.close();
}

await done();
process.exit(process.exitCode ?? 0);
