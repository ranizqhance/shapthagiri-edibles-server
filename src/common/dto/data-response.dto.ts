import { ApiProperty } from "@nestjs/swagger";
import { PageMetaDto } from "./page-meta.dto";

export class DataResponseDto<T> {
  @ApiProperty({ example: true }) success!: boolean;
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiProperty({ example: "OK" }) message!: string;
  @ApiProperty() data!: T | null;
  @ApiProperty({ type: [String], nullable: true }) errors!: string[] | null;
  @ApiProperty({ required: false }) meta?: PageMetaDto;
  @ApiProperty() timestamp!: string;

  private constructor(init: Partial<DataResponseDto<T>>) {
    Object.assign(this, init);
    this.timestamp = new Date().toISOString();
  }
  static ok<T>(data: T, message = "OK", meta?: PageMetaDto) { return new DataResponseDto({ success: true, statusCode: 200, message, data, errors: null, meta }); }
  static created<T>(data: T, message = "Created") { return new DataResponseDto({ success: true, statusCode: 201, message, data, errors: null }); }
  static noContent(message = "No content") { return new DataResponseDto<null>({ success: true, statusCode: 204, message, data: null, errors: null }); }
}
