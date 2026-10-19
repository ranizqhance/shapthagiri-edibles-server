import { IsUUID, IsOptional, IsString } from 'class-validator';

export class CancelPaymentDto {
  @IsUUID()
  paymentId!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
