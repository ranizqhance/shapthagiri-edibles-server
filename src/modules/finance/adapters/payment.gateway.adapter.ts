export interface RefundRequest {
  referenceId: string; // Internal Return/Order ID
  amountPaise: number;
  currency: string;
  originalPaymentId: string;
}

export interface RefundResponse {
  gatewayName: string;
  gatewayRefundId: string;
  status: 'PROCESSING' | 'SUCCESS' | 'FAILED';
  errorMessage?: string;
}

export interface PaymentGatewayAdapter {
  getName(): string;
  issueRefund(request: RefundRequest): Promise<RefundResponse>;
  validateWebhookSignature(payload: string, signature: string, secret: string): boolean;
  normalizeWebhookStatus(rawStatus: string): 'SUCCESS' | 'FAILED' | 'PENDING';
}
