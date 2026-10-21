# Shapthagiri Edibles — Backend (NestJS)

API for **Shapthagiri Edibles**, the online shop of **Shapthagiri Refineries**
(Neelamkatchi, Vannamada, Palakkad, Kerala; since 1987). It sells the company's
two coconut-oil brands: **Pooram** (roasted, eight packs) and **Dhwani** (pure,
two pouches).

The storefront and the admin dashboard (`../ecommerce-web`) both talk to this
API. It runs on NestJS 10, TypeScript and Sequelize (PostgreSQL).

## Branding
Everything the server renders reads its name, contact details and colours from
one file: **`src/common/brand.ts`**. That covers:
- the Swagger UI title and description (`src/main.ts`)
- the email sender name (`common/providers/email.provider.ts`)
- the password-reset and verification emails, plus every notification email,
  in a shared frame (`common/utils/branded-email.util.ts`)
- the tax invoice PDF (`buildInvoiceHtml` in `modules/orders/orders.service.ts`)
- settlement statements (`modules/finance/finance.module.ts`)
- scheduled finance reports (`common/utils/report-format.util.ts`)

The invoice prints the legal name, Shapthagiri Refineries. Its GSTIN and FSSAI
lines appear only after `business.gst` / `business.fssai` are set in
Dashboard → Settings. Neither number is public yet.

## Tech
- **NestJS 10** + TypeScript (strict)
- **Sequelize** + sequelize-typescript on PostgreSQL. There are no migrations:
  `db:sync` builds the schema from the models.
- **JWT auth** (Passport) with bcrypt passwords and refresh-token rotation.
  Access is controlled by RBAC permissions (`modules/rbac`), and a boot-time
  audit rejects any route that is left ungated.
- **Redis** for BullMQ notification queues, rate limiting and the socket.io
  adapter. With `REDIS_ENABLED=false` everything falls back to in-memory for a
  single local instance.
- **Socket.io** gateway: live courier location and shipment status
  (`modules/tracking`).
- **Puppeteer** (system Chromium) for invoice and statement PDFs.
- Unified `DataResponseDto` / `ErrorResponseDto` envelopes.

## Integrations
Every value is in `.env.example`.
- **Phone OTP and push**: Firebase. The server verifies the ID token the
  storefront gets from Firebase and sends FCM push. Until the Shapthagiri
  Firebase project exists, use email OTP. In development only,
  `ALLOW_OTP_STUB=true` accepts fake phone tokens.
- **Email**: Gmail app password or any SMTP server (see `EMAIL-SETUP.md`).
  With no credentials, mail is logged instead of sent.
- **Payments**: Razorpay for online payments. A built-in `mock` gateway runs
  when no key secret is set. **Cash on delivery** places a real order (status
  placed, payment pending). Staff, the fulfilling shop or the delivery partner
  then records the cash with `POST /payments/cod/confirm/:orderId`, which the
  dashboard exposes as "Mark cash collected".
- **Uploads**: AWS S3. Each kind of upload gets its own prefix, and the public
  ones are listed in `.env.example`.

## Local setup
Prerequisites: Node 22, PostgreSQL, and Redis (Memurai on Windows), or set
`REDIS_ENABLED=false`.

```bash
cd ecommerce-server
npm ci
cp .env.example .env          # then set DB_PASSWORD, DB_NAME, …
createdb shapthagiri          # or the DB_NAME you chose
npm run db:reset              # build the schema and seed the catalogue
npm run start:dev             # http://localhost:9165/api/v1
```

The storefront's `NEXT_PUBLIC_API_BASE` points at `http://localhost:9165/api/v1`.
Its `REVALIDATE_SECRET` must equal this server's `WEB_REVALIDATE_SECRET` for
catalogue changes to show on the storefront right away.

## What the seed creates
`npm run db:seed` (`src/scripts/seed.ts`) is idempotent. It creates:
- the RBAC permissions and system roles
- the shop **Shapthagiri Refineries — Vannamada**, which ships nationwide
- the category **Coconut Oil**, the brands **Pooram** and **Dhwani**, and
  **10 products**, one per pack, with 50 units each in stock
- a courier **rate card** in three zones (Kerala, South India, Rest of India).
  Without one, checkout refuses every order with `SHIPPING_RATE_MISSING`.
- the business settings: name, legal name, phones, support email, address and
  free-delivery threshold

Placeholders to replace before launch: the **prices** and the **courier rates**
(the old website published neither), and the shop's exact map pin.

**Demo logins (development only)**

| Email | Password | Role |
|---|---|---|
| admin@shapthagiri-edibles.com | admin | admin |
| manager@shapthagiri-edibles.com | manager | shop_manager |
| customer@shapthagiri-edibles.com | customer | customer |
| partner@shapthagiri-edibles.com | partner | delivery_partner |

Development also gets one sample delivered order, `ORD-DEMO-0001`. With
`NODE_ENV=production` the seed creates none of this. It creates a single
administrator from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, or none if
those are unset.

## Scripts
- `npm run start:dev`: nodemon + ts-node with hot reload
- `npm run build` and `npm run start:prod`: production
- `npm run db:sync` / `db:sync:alter` / `db:sync:force`
- `npm run db:seed` / `db:reset` (force sync + seed; refused in production)

## Key URLs
- API base: `http://localhost:9165/api/v1`
- Swagger UI: `http://localhost:9165/api/docs` (Basic auth `DOCS_USER` / `DOCS_PASSWORD`)
- Queues: `http://localhost:9165/admin/queues` (same login)
- Health: `GET /api/v1/health`, `/live` and `/ready`

## Deploying (Dokploy)
`dokploy-api.env` is the production template; fill every empty value. The
container (`Dockerfile`) listens on 9165. For a fresh database, deploy once
with `DB_BOOTSTRAP=1` to build the schema and run the seed, then set it back
to 0. The API refuses to start in production while JWT secrets, the DB
password, payment secrets, `ORDER_LOOKUP_SECRET` or the docs login are
missing or still defaults.

## Structure
```
src/
├── main.ts · app.module.ts
├── config/         env (envalid schema) · database · firebase
├── common/
│   ├── brand.ts    the shop's name, contacts and colours
│   ├── dto/        DataResponseDto · ErrorResponseDto · PageOptionsDto · request DTOs
│   ├── errors/     AppException tree + ERROR_CODES
│   ├── security/   route-gate audit (SELF_SERVICE_ROUTES)
│   ├── providers/  email · push · storage (S3) · geocoding · payment
│   └── utils/      branded-email · report-format · pdf · cors-origins · crud · …
├── models/         Sequelize models
├── modules/        auth · users · catalog · shops · inventory · cart · delivery-engine ·
│                   orders · partners · shipments · payments · returns · reviews ·
│                   promotions · notifications · search · support · analytics ·
│                   finance · admin · rbac · uploads · tracking · jobs · health
└── scripts/        sync-db · seed
```

## Response envelopes
Success, wrapped automatically by `ResponseInterceptor`:
```json
{ "success": true, "statusCode": 200, "message": "OK", "data": { ... }, "errors": null, "meta": null, "timestamp": "..." }
```
Error, emitted by `AllExceptionsFilter`:
```json
{
  "success": false, "statusCode": 422, "errorCode": "VALIDATION_FAILED",
  "message": "Request validation failed",
  "errors": [{ "field": "email", "code": "IS_EMAIL", "message": "Must be a valid email" }],
  "path": "/api/v1/auth/register", "method": "POST",
  "correlationId": "b8f2-...", "timestamp": "..."
}
```
