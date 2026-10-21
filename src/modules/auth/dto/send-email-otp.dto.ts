import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString } from "class-validator";

export class SendEmailOtpDto {
  @ApiProperty({ example: "customer@shapthagiri-edibles.com" })
  @IsEmail({}, { message: "A valid email is required to receive the OTP" })
  email!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;
}
