import { Injectable, Inject, forwardRef, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import * as crypto from "crypto";
import { User, OtpCode, UserSession } from "@/models";
import { Role } from "@/common/enums/role.enum";
import { hashPassword, comparePassword } from "@/common/utils/password.util";
import { signAccess, signRefresh, verifyRefresh } from "@/common/utils/jwt.util";
import { InvalidCredentialsException } from "@/common/errors/domain";
import { BadRequestException, ConflictException } from "@/common/errors/http";
import { smsProvider } from "@/common/providers/sms.provider";
import { emailProvider } from "@/common/providers/email.provider";
import { env } from "@/config/env";
import { BRAND } from "@/common/brand";
import { brandedEmail, escapeHtml } from "@/common/utils/branded-email.util";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { NotificationQueueService } from "../notifications/notification.queue";
import { NotificationEventType } from "@/common/enums/notification-event.enum";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { RbacCacheService } from "../rbac/rbac-cache.service";
import { createHash } from "node:crypto";

// Reset tokens live for 30 minutes.
const RESET_TTL_MS = 30 * 60 * 1000;
// Neutral message — MUST be identical whether or not the email is registered,
// so the endpoint never reveals which addresses have accounts.
const FORGOT_GENERIC_MESSAGE =
  "If an account exists for this email, a password reset link has been sent.";

// --- Email OTP ---
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
/**
 * How long a refresh token — and its session row — remains valid.
 *
 * Shortened from 30 days. With rotation and reuse detection in place a long
 * window is less dangerous than it was, but these tokens still sit in
 * `localStorage` where any script injection can read them, so the exposure
 * window is worth keeping modest.
 */
const REFRESH_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** A real bcrypt hash at the same cost, compared against when there is no account. */
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword(crypto.randomBytes(16).toString("hex")));

/** Sessions store a hash, never the token itself. */
const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/** Creating an account from the registration page. */
const OTP_PURPOSE_REGISTER = "register";
/** Signing in / creating an account inline at checkout. */
const OTP_PURPOSE_CHECKOUT = "checkout";

@Injectable()
export class AuthService {
  private failedAttempts = new Map<string, { count: number; first: number }>();
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(OtpCode) private otpModel: typeof OtpCode,
    @InjectModel(UserSession) private sessionModel: typeof UserSession,
    @Inject(forwardRef(() => NotificationQueueService))
    private notificationQueue: NotificationQueueService,
    private eventEmitter: EventEmitter2,
    private rbac: RbacCacheService,
  ) {}

  /**
   * Register / login customer via Firebase phone OTP.
   * Frontend runs Firebase Auth phone OTP, then sends the idToken here.
   * - Verifies the idToken with Firebase Admin
   * - Looks up existing user by verified phone (or email)
   * - Creates a new customer if none exists
   * - Returns our own JWTs
   */
  async register(dto: RegisterDto) {
    const decoded = await smsProvider.verifyIdToken(dto.idToken);
    const user = await this.findOrCreateFromPhone(decoded, dto.name, dto.email);
    return this.issueTokens(user);
  }

  /**
   * Sign in at checkout with a Firebase phone OTP, creating the account when the
   * number is new. Same identity rules as register(), minus the name: checkout
   * asks for as little as possible, and the real name arrives with the delivery
   * address a moment later.
   */
  async otpCheckout(idToken: string) {
    const decoded = await smsProvider.verifyIdToken(idToken);
    const user = await this.findOrCreateFromPhone(decoded);
    return this.issueTokens(user);
  }

  /**
   * Resolve a Firebase-verified phone to an account, creating one if needed.
   *
   * Shared by registration and checkout so there is exactly one place where a
   * verified phone turns into a session.
   *
   * An existing account is matched ONLY by something the caller just proved:
   * the phone in the Firebase token, or an email the token itself carries as
   * verified. The `email` typed into the registration form proves nothing, so
   * it may name a NEW account but never select an existing one. Matching on it
   * used to hand a session for any account to whoever typed its address next
   * to a fresh phone number.
   *
   * Phone-only signups have no real email, so they get a synthetic one to
   * satisfy the NOT NULL + UNIQUE constraint on users.email. Nothing may be
   * mailed to it — see isDeliverableEmail() in the notification queue.
   */
  private async findOrCreateFromPhone(
    decoded: { uid: string; phone: string | null; email: string | null; emailVerified?: boolean },
    name?: string,
    emailOverride?: string,
  ): Promise<User> {
    const phone = decoded.phone;
    const provenEmail = decoded.email && decoded.emailVerified ? decoded.email.toLowerCase().trim() : null;
    const typedEmail = emailOverride ? emailOverride.toLowerCase().trim() : null;
    const email = provenEmail ?? typedEmail ?? `${decoded.uid}@firebase.user`;

    let user = phone ? await this.userModel.findOne({ where: { phone } }) : null;
    if (!user && provenEmail) user = await this.userModel.findOne({ where: { email: provenEmail } });

    if (!user && !provenEmail && typedEmail && (await this.userModel.findOne({ where: { email: typedEmail } }))) {
      throw new ConflictException(
        "CONFLICT",
        "An account already exists for this email. Sign in with that email first, then add your mobile number from your profile.",
      );
    }

    if (user) {
      // They just proved they hold this number. An older account may predate
      // phone verification, or have been created by email OTP with no number at
      // all — record it now, or cash on delivery stays refused for a customer
      // who has in fact verified their mobile.
      const patch: Record<string, unknown> = {};
      if (phone && !user.phone) patch.phone = phone;
      if (phone && !user.phoneVerified) patch.phoneVerified = true;
      if (Object.keys(patch).length) await user.update(patch);
      return user;
    }

    user = await this.userModel.create({
      name: name?.trim() || "Customer",
      email,
      phone,
      // Random, and told to nobody. It used to be `firebase_<uid>`, and the uid
      // is also spelled out in the synthetic email — so the email/password
      // login accepted anyone who learned a uid. These accounts sign in by OTP.
      passwordHash: await hashPassword(crypto.randomBytes(32).toString("base64url")),
      role: Role.CUSTOMER,
      phoneVerified: !!phone,
      emailVerified: !!provenEmail,
    } as any);

    // Notify admins of new registration
    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.USER_REGISTERED,
      variables: { userId: user.id, name: user.name, email: user.email },
    });

    return user;
  }

  /**
   * Does an account already exist for this email or phone?
   *
   * Used by the registration form to fail early instead of after the SMS has
   * been spent. This does disclose whether an address is registered, which is
   * why it is throttled and why the checkout OTP flow does NOT call it — there,
   * an existing account simply signs in.
   */
  async checkExists(email?: string, phone?: string) {
    const emailKey = email?.toLowerCase().trim();
    if (emailKey && (await this.userModel.findOne({ where: { email: emailKey } }))) {
      return { exists: true, field: "email", message: "An account with this email already exists. Please sign in instead." };
    }
    const phoneKey = phone?.trim();
    if (phoneKey && (await this.userModel.findOne({ where: { phone: phoneKey } }))) {
      return { exists: true, field: "phone", message: "An account with this mobile number already exists. Please sign in instead." };
    }
    return { exists: false };
  }

  async login(dto: LoginDto) {
    // `withPassword` scope is required because passwordHash is excluded by default.
    const emailKey = dto.email.toLowerCase();
    const user = await this.userModel.scope("withPassword").findOne({ where: { email: emailKey } });
    this.logger.debug('Login attempt', { email: emailKey, userFound: !!user, isActive: user?.isActive });
    // Same work for every answer. Returning before bcrypt ran made an unknown
    // or deactivated address answer ~200 ms faster than a wrong password —
    // a timing oracle for which addresses have accounts.
    if (!user || !user.isActive) {
      await comparePassword(dto.password, await dummyHash());
      await this.trackFailedLogin(emailKey, user?.id);
      throw new InvalidCredentialsException();
    }
    let ok: boolean;
    try {
      ok = await comparePassword(dto.password, user.passwordHash);
    } catch (err) {
      this.logger.error('Password compare error', err);
      throw err;
    }
    if (!ok) {
      await this.trackFailedLogin(emailKey, user.id);
      throw new InvalidCredentialsException();
    }
    this.failedAttempts.delete(emailKey);
    return this.issueTokens(user);
  }

  /**
   * Count failures per address so admins hear about a run of them. Alerting
   * only — never a lockout (that would let anyone lock a customer out by
   * guessing at their address); the rate limiter is what slows guessing.
   *
   * Bounded: keyed by an address the caller types, an unbounded map grew one
   * entry per guessed address for the life of the process. Entries expire with
   * the login throttle window, and the oldest are dropped past a cap.
   */
  private async trackFailedLogin(email: string, userId?: string) {
    const WINDOW_MS = 15 * 60 * 1000;
    const CAP = 10_000;
    const now = Date.now();
    const prev = this.failedAttempts.get(email);
    const count = prev && now - prev.first < WINDOW_MS ? prev.count + 1 : 1;
    this.failedAttempts.delete(email); // re-insert so Map order stays oldest-first
    this.failedAttempts.set(email, { count, first: prev && count > 1 ? prev.first : now });
    while (this.failedAttempts.size > CAP) this.failedAttempts.delete(this.failedAttempts.keys().next().value as string);

    if (count === 5) {
      this.eventEmitter.emit("admin.notify", {
        eventType: NotificationEventType.MULTIPLE_FAILED_LOGINS, 
        variables: { email, targetUserId: userId, attempts: count }
      });
    }
  }

  /**
   * Exchange a refresh token for a new pair — once.
   *
   * Previously the presented token was verified and then simply left valid:
   * no rotation, no record, no reuse detection. A refresh token lasts 30 days
   * and lives in `localStorage`, so one stolen token was a month of silent
   * access, and nothing on the server could tell a theft from ordinary use.
   *
   * Now every refresh issues a new token and marks the old one spent. If a
   * spent token is presented again, that is the signature of theft — the
   * legitimate client and the attacker both hold a copy, and only one can
   * have used it first — so the whole family is revoked and the user is
   * signed out everywhere. That is the standard browser-app pattern.
   *
   * Tokens are stored hashed. A leaked database read should not hand over
   * working sessions.
   */
  async refresh(refreshToken: string, meta?: { ip?: string; device?: string }) {
    let payload: ReturnType<typeof verifyRefresh>;
    try {
      payload = verifyRefresh(refreshToken);
    } catch {
      // Bad signature, expired, or an access token offered as a refresh token.
      throw new InvalidCredentialsException();
    }
    const user = await this.userModel.findByPk(payload.sub);
    if (!user || !user.isActive) throw new InvalidCredentialsException();
    // tokenVersion still revokes everything at once (logout, password change).
    if ((payload.tv ?? 0) !== user.tokenVersion) throw new InvalidCredentialsException();

    const presentedHash = hashToken(refreshToken);

    /*
     * Check-and-spend under a row lock. Two refreshes racing with the same
     * token both used to read it as unspent and both got a new pair — a
     * stolen copy used at the same moment as the real one went unnoticed.
     *
     * Outcomes are returned, not thrown: throwing inside the transaction
     * would roll back the very revocation a reuse has to commit.
     */
    const outcome = await this.sessionModel.sequelize!.transaction(async (t) => {
      const session = await this.sessionModel.findOne({
        where: { userId: user.id, refreshTokenHash: presentedHash },
        lock: t.LOCK.UPDATE,
        transaction: t,
      });

      // A valid signature with no session row used to be "adopted" and
      // honoured, so a token whose row was never written (or was pruned)
      // could be replayed until it expired. Every live token has a row.
      if (!session) return "unknown" as const;

      if (session.revoked) {
        // A spent token, presented again: someone holds a copy. Revoke every
        // session and bump tokenVersion so their access tokens die too.
        await this.sessionModel.update({ revoked: true }, { where: { userId: user.id }, transaction: t });
        await this.userModel.increment("tokenVersion", { where: { id: user.id }, transaction: t });
        return "reuse" as const;
      }

      if (session.expiresAt.getTime() < Date.now()) {
        await session.update({ revoked: true }, { transaction: t });
        return "expired" as const;
      }

      // Spend this one; the next is issued after commit.
      await session.update({ revoked: true }, { transaction: t });
      return "ok" as const;
    });

    if (outcome === "reuse") this.logger.error(`Refresh token REUSE detected for user ${user.id} — all sessions revoked`);
    if (outcome === "unknown") this.logger.warn(`Refresh presented with no session row (user ${user.id}) — refused`);
    if (outcome !== "ok") throw new InvalidCredentialsException();
    return this.issueTokens(user, meta);
  }

  /** Revoke every token previously issued to this user (logout from all devices). */
  async logout(userId: string) {
    await this.userModel.increment("tokenVersion", { where: { id: userId } });
    await this.sessionModel.update({ revoked: true }, { where: { userId } });
    return { loggedOut: true };
  }

  /**
   * Currently authenticated user, sanitised (passwordHash excluded by default
   * scope), enriched with the RBAC role and effective permission keys. The
   * frontend uses `permissions` only to show/hide UI — the backend independently
   * re-checks on every request.
   */
  async me(userId: string) {
    const user = await this.userModel.findByPk(userId, { include: [{ association: "rbacRole" }] });
    if (!user) throw new InvalidCredentialsException();
    const { roleId, permissions } = await this.rbac.getPermissionsForUser(user);
    return {
      ...(user.toJSON() as any),
      roleId,
      permissions,
      rbacRole: user.rbacRole ? { id: user.rbacRole.id, key: user.rbacRole.key, name: user.rbacRole.name } : null,
    };
  }

  /**
   * Step 1 of reset: generate a secure, single-use, time-limited token, persist
   * only its SHA-256 hash, and email the raw token as a link. Always returns the
   * same generic message — never reveals whether the email is registered.
   */
  async forgotPassword(email: string) {
    // Before the lookup: the same answer for every address, registered or not.
    emailProvider.assertDeliverable();
    const emailKey = email.toLowerCase().trim();
    const user = await this.userModel.findOne({ where: { email: emailKey } });

    if (user && user.isActive) {
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      await user.update({
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: new Date(Date.now() + RESET_TTL_MS),
      });

      const base = (env.CORS_ORIGINS.split(",")[0] || "http://localhost:9164").trim().replace(/\/$/, "");
      const resetUrl = `${base}/reset-password?token=${token}`;

      // Email failures must not leak (or 500) — log and still return generic.
      try {
        await emailProvider.send(user.email, `Reset your ${BRAND.name} password`, this.resetEmailHtml(user.name, resetUrl));
      } catch (e) {
        this.logger.error("Password reset email failed to send", e as Error);
      }
    }

    return { message: FORGOT_GENERIC_MESSAGE };
  }

  /**
   * Step 2 of reset: validate the token (exists + not expired), set the new
   * (hashed) password, invalidate the token (single use) and revoke all existing
   * sessions via tokenVersion.
   */
  async resetPassword(token: string, newPassword: string) {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await this.userModel.findOne({ where: { passwordResetTokenHash: tokenHash } });

    if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt.getTime() < Date.now()) {
      throw new BadRequestException("BAD_REQUEST", "This reset link is invalid or has expired. Please request a new one.");
    }

    await user.update({
      passwordHash: await hashPassword(newPassword),
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      // Revoke every previously-issued token so old sessions can't survive a reset.
      tokenVersion: user.tokenVersion + 1,
    });

    return { reset: true, message: "Your password has been reset. You can now sign in." };
  }

  private resetEmailHtml(name: string, resetUrl: string): string {
    return brandedEmail(`
        <h2 style="color:${BRAND.primaryDark};margin:0 0 12px">Reset your password</h2>
        <p>Hi ${escapeHtml(name || "there")},</p>
        <p>We received a request to reset your ${BRAND.name} password. Click the button below to choose a new one. This link expires in 30 minutes and can be used once.</p>
        <p style="text-align:center;margin:28px 0">
          <a href="${resetUrl}" style="background:${BRAND.primary};color:#fff;text-decoration:none;padding:12px 28px;border-radius:9999px;font-weight:600;display:inline-block">Reset password</a>
        </p>
        <p style="font-size:12px;color:${BRAND.muted}">If the button doesn't work, copy this link into your browser:<br/><a href="${resetUrl}" style="color:${BRAND.primary};word-break:break-all">${resetUrl}</a></p>
        <p style="font-size:12px;color:${BRAND.muted}">If you didn't request this, you can safely ignore this email — your password won't change.</p>`);
  }

  // ─────────────────────── Registration Email OTP ───────────────────────
  // Temporary email-based OTP so users can register while SMS OTP is disabled.
  // Modular: the Firebase `register()` path above is untouched and can be
  // re-enabled by pointing the frontend back at /auth/register.

  /**
   * Mint a 6-digit code for (identifier, purpose), store only its SHA-256 hash,
   * and supersede any code still outstanding for that pair.
   *
   * Backed by the otp_codes table rather than process memory, so a restart or a
   * second instance cannot strand a customer mid-checkout holding a code the
   * server has forgotten.
   */
  private async issueOtp(identifier: string, channel: "sms" | "email", purpose: string): Promise<string> {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    // Only the newest code may be used; requesting another invalidates the old.
    await this.otpModel.update({ consumed: true }, { where: { identifier, purpose, consumed: false } });
    await this.otpModel.create({
      identifier,
      channel,
      codeHash,
      purpose,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    } as any);
    return code;
  }

  /**
   * Check a submitted code and burn it. Throws on expiry, too many attempts or
   * a mismatch. Single use — a correct code cannot be replayed.
   */
  private async consumeOtp(identifier: string, purpose: string, code: string): Promise<void> {
    const entry = await this.otpModel.findOne({
      where: { identifier, purpose, consumed: false },
      order: [["createdAt", "DESC"]],
    });

    if (!entry || entry.expiresAt.getTime() < Date.now()) {
      if (entry) await entry.update({ consumed: true });
      throw new BadRequestException("BAD_REQUEST", "This code has expired. Please request a new one.");
    }
    if (entry.attempts >= OTP_MAX_ATTEMPTS) {
      await entry.update({ consumed: true });
      throw new BadRequestException("RATE_LIMITED", "Too many incorrect attempts. Please request a new code.");
    }

    const codeHash = crypto.createHash("sha256").update(code.trim()).digest("hex");
    if (codeHash !== entry.codeHash) {
      await entry.increment("attempts");
      throw new BadRequestException("BAD_REQUEST", "Incorrect code. Please check and try again.");
    }

    await entry.update({ consumed: true });
  }

  private async mailOtp(emailKey: string, code: string, name?: string) {
    try {
      await emailProvider.send(emailKey, `Your ${BRAND.name} verification code`, this.otpEmailHtml(name || "there", code));
    } catch (e) {
      this.logger.error("OTP email failed to send", e as Error);
      throw new BadRequestException("INTERNAL_ERROR", "We couldn't send the verification email. Please try again.");
    }
    return { message: "A 6-digit verification code has been sent to your email. It expires in 10 minutes." };
  }

  /** Generate a 6-digit OTP, store only its hash + a 10-min expiry, and email it. */
  async sendRegistrationEmailOtp(email: string, name?: string) {
    emailProvider.assertDeliverable();
    const emailKey = email.toLowerCase().trim();

    const existing = await this.userModel.findOne({ where: { email: emailKey } });
    if (existing) {
      throw new BadRequestException("CONFLICT", "An account with this email already exists. Please sign in instead.");
    }

    const code = await this.issueOtp(emailKey, "email", OTP_PURPOSE_REGISTER);
    return this.mailOtp(emailKey, code, name);
  }

  /**
   * Checkout variant: emails a code whether or not the address is registered.
   *
   * Unlike the registration flow this must NOT reject an existing account — at
   * checkout an existing customer is simply signing in. It also stays silent
   * about which case it is, so the endpoint cannot be used to test whether an
   * address has an account.
   */
  async sendCheckoutEmailOtp(email: string) {
    emailProvider.assertDeliverable();
    const emailKey = email.toLowerCase().trim();
    const code = await this.issueOtp(emailKey, "email", OTP_PURPOSE_CHECKOUT);
    return this.mailOtp(emailKey, code);
  }

  /**
   * Checkout variant: verify the code, then sign in or create the account.
   *
   * These accounts have no verified phone, which is why COD is refused for them
   * in OrdersService.create() — an unverified identity must not be able to
   * generate cash-on-delivery consignments.
   */
  async verifyCheckoutEmailOtp(email: string, code: string) {
    const emailKey = email.toLowerCase().trim();
    await this.consumeOtp(emailKey, OTP_PURPOSE_CHECKOUT, code);

    let user = await this.userModel.findOne({ where: { email: emailKey } });
    if (!user) {
      user = await this.userModel.create({
        name: "Customer",
        email: emailKey,
        phone: null,
        // Random password — OTP accounts sign in via OTP, not a password; they
        // can set one later through forgot-password.
        passwordHash: await hashPassword(crypto.randomBytes(24).toString("hex")),
        role: Role.CUSTOMER,
        emailVerified: true,
        phoneVerified: false,
      } as any);

      this.eventEmitter.emit("admin.notify", {
        eventType: NotificationEventType.USER_REGISTERED,
        variables: { userId: user.id, name: user.name, email: user.email },
      });
    } else if (!user.emailVerified) {
      await user.update({ emailVerified: true });
    }

    return this.issueTokens(user);
  }

  /** Verify the emailed OTP; on success create the account (single-use) and issue tokens. */
  async verifyRegistrationEmailOtp(email: string, code: string, name: string, phone?: string) {
    const emailKey = email.toLowerCase().trim();
    const phoneKey = phone?.trim() || null;

    // The code proves the email, not the phone typed beside it. A number that
    // already belongs to an account must never select that account: matching on
    // it handed a session for any account to whoever typed its number here.
    // Checked before the code is burnt, so the customer can retry without it.
    if (phoneKey && (await this.userModel.findOne({ where: { phone: phoneKey } }))) {
      throw new ConflictException(
        "CONFLICT",
        "This mobile number is already registered. Sign in with it instead, or leave it out to continue.",
      );
    }

    await this.consumeOtp(emailKey, OTP_PURPOSE_REGISTER, code);

    // Guard against a race: someone may have registered this email meanwhile.
    // The code just proved this address, so signing into it is correct.
    let user = await this.userModel.findOne({ where: { email: emailKey } });

    if (!user) {
      user = await this.userModel.create({
        name: name?.trim() || "Customer",
        email: emailKey,
        phone: phoneKey,
        // Random password — OTP-verified accounts sign in via OTP, not password;
        // they can set one later via forgot-password.
        passwordHash: await hashPassword(crypto.randomBytes(24).toString("hex")),
        role: Role.CUSTOMER,
        emailVerified: true,
        phoneVerified: false,
      } as any);

      this.eventEmitter.emit("admin.notify", {
        eventType: NotificationEventType.USER_REGISTERED,
        variables: { userId: user.id, name: user.name, email: user.email },
      });
    }

    return this.issueTokens(user);
  }

  private otpEmailHtml(name: string, code: string): string {
    return brandedEmail(`
        <h2 style="color:${BRAND.primaryDark};margin:0 0 12px">Verify your email</h2>
        <p>Hi ${escapeHtml(name)},</p>
        <p>Use the code below to finish creating your ${BRAND.name} account. It expires in 10 minutes.</p>
        <p style="text-align:center;margin:28px 0">
          <span style="display:inline-block;background:${BRAND.surface};border:1px solid ${BRAND.amber};border-radius:12px;padding:14px 28px;font-size:30px;letter-spacing:8px;font-weight:700;color:${BRAND.primary}">${code}</span>
        </p>
        <p style="font-size:12px;color:${BRAND.muted}">If you didn't request this, you can safely ignore this email.</p>`);
  }

  private async issueTokens(user: User, meta?: { ip?: string; device?: string }) {
    const payload = { sub: user.id, role: user.role, email: user.email, shopId: user.shopId ?? undefined, tv: user.tokenVersion };
    const refreshToken = signRefresh(payload);

    /*
     * Record the refresh token so it can be rotated and, crucially, so reuse
     * of a spent one is detectable. Stored as a hash: a database read must not
     * yield usable sessions.
     *
     * Failure here is logged, not thrown. A session row is a security
     * improvement, not a precondition for signing in — if the table is
     * unavailable, letting the customer in without rotation beats refusing
     * every login on the platform.
     */
    try {
      await this.sessionModel.create({
        userId: user.id,
        refreshTokenHash: hashToken(refreshToken),
        device: meta?.device?.slice(0, 120) ?? null,
        ip: meta?.ip?.slice(0, 48) ?? null,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        revoked: false,
      } as any);
    } catch (e) {
      this.logger.error(`Could not record session for user ${user.id}: ${(e as Error).message}`);
    }

    // The same role id and permission keys /auth/me returns, so the dashboard
    // can draw its menu from the sign-in response instead of waiting on a
    // follow-up request. UI only — every route re-checks on the server.
    const { roleId, permissions } = await this.rbac.getPermissionsForUser(user);

    return {
      accessToken: signAccess(payload),
      refreshToken,
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, avatarUrl: user.avatarUrl, shopId: user.shopId, phoneVerified: user.phoneVerified, emailVerified: user.emailVerified, roleId, permissions },
    };
  }
}
