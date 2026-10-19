import { ApiProperty } from "@nestjs/swagger";

export class FieldErrorDto {
  @ApiProperty() field!: string;
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ required: false }) constraint?: Record<string, unknown>;
  @ApiProperty({ required: false }) received?: unknown;
}

export class ErrorResponseDto {
  @ApiProperty({ example: false }) success!: false;
  @ApiProperty({ example: 422 }) statusCode!: number;
  @ApiProperty({ example: "VALIDATION_FAILED" }) errorCode!: string;
  @ApiProperty({ example: "Request validation failed" }) message!: string;
  @ApiProperty({ type: [FieldErrorDto] }) errors!: FieldErrorDto[];
  @ApiProperty({ required: false }) details?: Record<string, unknown>;
  @ApiProperty() path!: string;
  @ApiProperty() method!: string;
  @ApiProperty() correlationId!: string;
  @ApiProperty() timestamp!: string;
  @ApiProperty({ required: false }) documentationUrl?: string;
}
