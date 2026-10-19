import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MinLength } from "class-validator";

export class LoginDto {
  @ApiProperty({ example: "admin@shreshtam.in" })
  @IsEmail() email!: string;

  @ApiProperty({ example: "admin" })
  @IsString() @MinLength(1) password!: string;
}
