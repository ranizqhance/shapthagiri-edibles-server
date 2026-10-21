import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString, Length } from "class-validator";

/** Phone OTP at checkout — the Firebase idToken the client holds after SMS verification. */
export class CheckoutOtpDto {
  @ApiProperty({ description: "Firebase ID token from the client-side phone OTP flow." })
  @IsString()
  idToken!: string;
}

/** Ask for an emailed code. Deliberately says nothing about whether the address is registered. */
export class CheckoutEmailOtpSendDto {
  @ApiProperty({ example: "customer@example.com" })
  @IsEmail()
  email!: string;
}

/** Submit the emailed code. */
export class CheckoutEmailOtpVerifyDto {
  @ApiProperty({ example: "customer@example.com" })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: "482193" })
  @IsString() @Length(4, 8)
  code!: string;
}

/** Registration-form pre-check, so a taken number is caught before the SMS is spent. */
export class CheckExistsDto {
  @ApiPropertyOptional({ example: "customer@example.com" })
  @IsOptional() @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: "+919446380334" })
  @IsOptional() @IsString() @Length(6, 20)
  phone?: string;
}
