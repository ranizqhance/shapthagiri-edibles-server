# Email configuration — Shreshtam API

Lives here rather than in a `.env.example`: `.gitignore` excludes `.env*`,
so a dotfile example would never actually reach the repository.

Copy the block you need into the service's environment. These are read at
RUNTIME, not baked in at build time, so changing them needs a restart of the
API container, not a rebuild.

Nothing here is a secret in this file: fill the values in Dokploy, never in
the repository. The canonical schema lives in `src/config/env.ts`.

## Which block wins

`email.provider.ts` checks GMAIL_* FIRST. If GMAIL_USER and
GMAIL_APP_PASSWORD are both set, the MAIL_* block is ignored entirely —
including MAIL_FROM, because Gmail requires the From address to be the
authenticated account. Set one block or the other, not both.

With neither set the provider runs in stub mode: it logs "[Email stub] → …"
and reports success while sending nothing. That is the failure mode to watch
for — it is silent. Since this change the API also logs one line at startup,
either "Email ready (…)" or "Email credentials rejected (…)".

To check a running deployment without placing an order, call
`POST /api/v1/notifications/test-email` as an admin. `configured: false` in
the response means no credentials are loaded.

## Option A: Gmail with an app password (what production uses today)

Needs 2-Step Verification on the Google account, then an app password from
https://myaccount.google.com/apppasswords — a normal account password will
not work. Paste it without spaces.

Limits worth knowing: roughly 500 messages a day, and mail sent from a
gmail.com address reaches spam more often than mail from your own domain.
Fine at current order volume; revisit if that grows.
```bash
GMAIL_USER=
GMAIL_APP_PASSWORD=

```

## Option B: any other SMTP provider (Brevo, SES, Postmark, Mailgun…)

Used only when the GMAIL_* pair above is empty. Prefer this once you have a
sender on your own domain — deliverability is markedly better and there is no
daily cap to collide with.

MAIL_SECURE=true means implicit TLS on port 465. For port 587 leave it false:
the connection upgrades through STARTTLS, and setting it true there fails.
```bash
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_SECURE=false
MAIL_USER=
MAIL_PASS=
MAIL_FROM=Shreshtam <shreshtamgroup@gmail.com>

```

## Channel switches

ENABLE_EMAIL=false now suppresses every outbound email, including password
resets, OTP codes and finance reports. Until this change it was honoured only
by the notification queue, so those three kept sending regardless.
```bash
ENABLE_EMAIL=true
ENABLE_PUSH=true
ENABLE_SMS=true

```
.