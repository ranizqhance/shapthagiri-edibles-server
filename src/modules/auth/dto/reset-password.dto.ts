import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength } from "class-validator";

export class ResetPasswordDto {
  @ApiProperty({ description: "Reset token from the emailed link" })
  @IsString()
  token!: string;

  @ApiProperty({ example: "MyNewStr0ngPass", minLength: 8 })
  @IsString()
  @MinLength(8, { message: "Password must be at least 8 characters" })
  password!: string;
}
