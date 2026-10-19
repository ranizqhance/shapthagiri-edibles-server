import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsEnum, IsNumber, IsObject, IsOptional, IsString, IsUUID, Min, MinDate, ValidateIf, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

export enum GiftCardType {
  DIGITAL = "digital",
  PHYSICAL = "physical",
  PROMOTIONAL = "promotional",
  REFUND = "refund",
}

export enum GiftCardStatus {
  ACTIVE = "active",
  PAUSED = "paused",
  DISABLED = "disabled",
  EXPIRED = "expired",
}

export class CreateGiftCardDto {
  @ApiProperty({ enum: GiftCardType, default: GiftCardType.DIGITAL })
  @IsEnum(GiftCardType)
  @IsOptional()
  type?: GiftCardType;

  @ApiProperty({ description: "Initial balance (INR)" })
  @IsNumber()
  @Min(0)
  @IsOptional()
  initialBalance?: number;

  @ApiPropertyOptional({ description: "Alias for initialBalance" })
  @IsNumber()
  @Min(0)
  @IsOptional()
  balance?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  customerId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  purchaserId?: string;

  @ApiPropertyOptional()
  @IsEmail()
  @IsOptional()
  recipientEmail?: string;

  @ApiPropertyOptional()
  @Type(() => Date)
  @IsOptional()
  scheduledDeliveryAt?: Date;

  @ApiPropertyOptional()
  @Type(() => Date)
  @IsOptional()
  expiresAt?: Date;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  autoExpiryDays?: number;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isPartialRedemptionAllowed?: boolean;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  rules?: any;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  code?: string;
}

export class UpdateGiftCardDto {
  @ApiPropertyOptional({ enum: GiftCardStatus })
  @IsEnum(GiftCardStatus)
  @IsOptional()
  status?: GiftCardStatus;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional()
  @Type(() => Date)
  @IsOptional()
  expiresAt?: Date;
}

export class RechargeGiftCardDto {
  @ApiProperty()
  @IsNumber()
  @Min(1)
  amount!: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;
}

export class ApplyGiftCardDto {
  @ApiProperty()
  @IsString()
  code!: string;
}

export class BulkUpdateStatusDto {
  @ApiProperty()
  @IsEnum(GiftCardStatus)
  status!: GiftCardStatus;

  @ApiProperty({ maxItems: 500 })
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true })
  ids!: string[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;
}

export class BulkRechargePayloadDto {
  @ApiProperty()
  @IsString()
  id!: string;

  @ApiProperty()
  @IsNumber()
  @Min(1)
  amount!: number;
}

export class BulkRechargeDto {
  /*
   * This had NO validator at all — only an @ApiProperty, which is
   * documentation. The contents were never checked and the length was never
   * bounded, on a route that moves money onto gift cards.
   */
  @ApiProperty({ type: [BulkRechargePayloadDto], maxItems: 500 })
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => BulkRechargePayloadDto)
  payloads!: BulkRechargePayloadDto[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;
}
