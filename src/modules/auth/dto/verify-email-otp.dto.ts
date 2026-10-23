import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString, Length } from "class-validator";

export class VerifyEmailOtpDto {
  @ApiProperty({ example: "you@example.com" })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: "123456" })
  @IsString()
  @Length(6, 6, { message: "OTP must be 6 digits" })
  code!: string;

  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({ required: false, example: "+919876543210" })
  @IsOptional()
  @IsString()
  phone?: string;
}
