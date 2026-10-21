import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString, Length } from "class-validator";

export class RegisterDto {
  @ApiProperty({
    description:
      "Firebase ID token returned to the client by the Firebase Auth phone OTP flow. The frontend completes phone+OTP verification with Firebase and sends the resulting idToken here.",
  })
  @IsString()
  idToken!: string;

  @ApiProperty({ example: "Jane Cooper" })
  @IsString() @Length(2, 120)
  name!: string;

  @ApiPropertyOptional({ example: "customer@shapthagiri-edibles.com", description: "Optional — used if Firebase token has no email" })
  @IsOptional() @IsEmail()
  email?: string;
}
