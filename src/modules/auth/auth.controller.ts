import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { LIMITS } from "@/common/security/throttle";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { RefreshDto } from "./dto/refresh.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { SendEmailOtpDto } from "./dto/send-email-otp.dto";
import { VerifyEmailOtpDto } from "./dto/verify-email-otp.dto";
import {
  CheckoutOtpDto,
  CheckoutEmailOtpSendDto,
  CheckoutEmailOtpVerifyDto,
  CheckExistsDto,
} from "./dto/checkout-otp.dto";
import { Public } from "@/common/decorators/public.decorator";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "./jwt.strategy";

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Creates a User and makes a Firebase round trip per call.
  @Public()
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @Post("register")
  @HttpCode(200)
  @ApiOperation({
    summary: "Register / login customer using Firebase phone OTP",
    description:
      "The frontend runs the Firebase Auth phone OTP flow and obtains an `idToken`. Send that idToken here along with the user's name. The backend verifies the token with Firebase Admin, creates the user if new (or returns the existing one matched by verified phone), and issues our own JWTs.",
  })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  /* ─────────────── Checkout OTP: sign in or sign up inline ───────────────
   * The storefront lets people shop anonymously and only asks who they are at
   * "Proceed to Checkout". These endpoints sign an existing customer in or
   * create the account on the spot, so the cart is never lost to a login wall.
   * Throttled hard: each one either sends an SMS/email or tests a credential.
   */

  @Public()
  @Throttle(LIMITS.verifyCode)
  @Post("otp/checkout")
  @HttpCode(200)
  @ApiOperation({
    summary: "Checkout: sign in (or create an account) with a Firebase phone OTP",
    description:
      "The client completes the Firebase phone OTP flow and posts the resulting idToken. Matches an existing account by verified phone, creates one if the number is new, and issues our own JWTs. No name required — it arrives with the delivery address.",
  })
  otpCheckout(@Body() dto: CheckoutOtpDto) {
    return this.authService.otpCheckout(dto.idToken);
  }

  @Public()
  @Throttle(LIMITS.sendCode)
  @Post("otp/email/send")
  @HttpCode(200)
  @ApiOperation({
    summary: "Checkout: email a 6-digit code (fallback when SMS is unavailable)",
    description:
      "Sends a code whether or not the address is registered, and the response does not reveal which — so this cannot be used to enumerate customers.",
  })
  sendCheckoutEmailOtp(@Body() dto: CheckoutEmailOtpSendDto) {
    return this.authService.sendCheckoutEmailOtp(dto.email);
  }

  @Public()
  @Throttle(LIMITS.verifyCode)
  @Post("otp/email/verify")
  @HttpCode(200)
  @ApiOperation({ summary: "Checkout: verify the emailed code, then sign in or create the account" })
  verifyCheckoutEmailOtp(@Body() dto: CheckoutEmailOtpVerifyDto) {
    return this.authService.verifyCheckoutEmailOtp(dto.email, dto.code);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("check-exists")
  @HttpCode(200)
  @ApiOperation({
    summary: "Registration form: is this email or mobile already taken?",
    description:
      "Lets the registration form fail before an SMS is spent. Discloses whether an identifier is registered, hence the throttle — the checkout OTP flow deliberately does not use it.",
  })
  checkExists(@Body() dto: CheckExistsDto) {
    return this.authService.checkExists(dto.email, dto.phone);
  }

  /*
   * 5 attempts per 15 minutes.
   *
   * Had no limit at all, so password guessing ran at the global 300/minute —
   * and because ThrottlerGuard used to be registered after JwtAuthGuard, a
   * failed login short-circuited before being counted, which meant the one
   * endpoint most worth limiting was effectively unlimited. There is
   * deliberately no account lockout: that would let anyone freeze a
   * competitor's account by guessing at their address.
   */
  @Public()
  @Throttle(LIMITS.login)
  @Post("login")
  @HttpCode(200)
  @ApiOperation({ summary: "Login with email + password (admin / shop manager / staff)" })
  @ApiBody({
    type: LoginDto,
    // Placeholder values only. These examples ship inside the published
    // OpenAPI document, and real-looking staff credentials in it are a
    // standing invitation to try them.
    examples: {
      staff: { value: { email: "you@example.com", password: "your-password" } },
    },
  })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // Legitimate clients refresh roughly every 15 minutes; 20/hour leaves ample
  // headroom for several tabs and devices while bounding token grinding.
  @Public()
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @Post("refresh")
  @HttpCode(200)
  @ApiOperation({ summary: "Issue a new access token from refresh token" })
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // Sends an email per call to an address the caller names: a mail bomb and an
  // SMTP-quota burn in one. Was unthrottled.
  @Public()
  @Throttle(LIMITS.sendCode)
  @Post("register/send-otp")
  @HttpCode(200)
  @ApiOperation({ summary: "Registration: email a 6-digit OTP (temporary email verification while SMS OTP is disabled)" })
  sendRegistrationOtp(@Body() dto: SendEmailOtpDto) {
    return this.authService.sendRegistrationEmailOtp(dto.email, dto.name);
  }

  // Guessing a 6-digit code. The per-code attempt cap resets whenever a new
  // code is minted, so the request limit is what actually bounds this.
  @Public()
  @Throttle(LIMITS.verifyCode)
  @Post("register/verify-otp")
  @HttpCode(200)
  @ApiOperation({ summary: "Registration: verify the emailed OTP and create the account" })
  verifyRegistrationOtp(@Body() dto: VerifyEmailOtpDto) {
    return this.authService.verifyRegistrationEmailOtp(dto.email, dto.code, dto.name, dto.phone);
  }

  // Same shape as register/send-otp, aimed at an address that definitely
  // exists. Was unthrottled.
  @Public()
  @Throttle(LIMITS.sendCode)
  @Post("forgot-password")
  @HttpCode(200)
  @ApiOperation({ summary: "Request a password reset link (emailed). Always returns a generic message." })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  // Guessing a reset token.
  @Public()
  @Throttle(LIMITS.verifyCode)
  @Post("reset-password")
  @HttpCode(200)
  @ApiOperation({ summary: "Set a new password using a valid, unexpired reset token" })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.password);
  }

  @Get("me")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get currently authenticated user" })
  me(@CurrentUser() user: JwtPayload) {
    return this.authService.me(user.sub);
  }

  @Post("logout")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Log out from all devices (revokes all issued tokens)" })
  logout(@CurrentUser() user: JwtPayload) {
    return this.authService.logout(user.sub);
  }
}
