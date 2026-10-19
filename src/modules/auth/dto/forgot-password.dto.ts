import { ApiProperty } from "@nestjs/swagger";
import { IsEmail } from "class-validator";

export class ForgotPasswordDto {
  @ApiProperty({ example: "customer@shreshtam.in" })
  @IsEmail({}, { message: "A valid email is required" })
  email!: string;
}
