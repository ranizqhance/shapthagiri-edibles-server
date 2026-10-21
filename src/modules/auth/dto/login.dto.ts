import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MinLength } from "class-validator";

export class LoginDto {
  @ApiProperty({ example: "admin@shapthagiri-edibles.com" })
  @IsEmail() email!: string;

  @ApiProperty({ example: "admin" })
  @IsString() @MinLength(1) password!: string;
}
