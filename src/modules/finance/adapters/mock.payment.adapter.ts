import { PaymentGatewayAdapter, RefundRequest, RefundResponse } from './payment.gateway.adapter';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export class MockPaymentAdapter implements PaymentGatewayAdapter {
  private readonly logger = new Logger(MockPaymentAdapter.name);

  getName(): string {
    return 'MockGateway';
  }

  async issueRefund(request: RefundRequest): Promise<RefundResponse> {
    this.logger.log(`[MockGateway] Issuing refund for ${request.amountPaise} paise. Ref: ${request.referenceId}`);
    
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 600));

    // Simulate 2% gateway failure rate for resilience testing
    if (Math.random() < 0.02) {
      return {
        gatewayName: this.getName(),
        gatewayRefundId: '',
        status: 'FAILED',
        errorMessage: 'Mock Gateway: Insufficient merchant balance.'
      };
    }

    const gatewayRefundId = `MOCK-RFND-${uuidv4()}`;

    // Asynchronous processing: Real gateways return PENDING/PROCESSING immediately
    this.logger.log(`[MockGateway] Refund initiated successfully: ${gatewayRefundId}`);

    return {
      gatewayName: this.getName(),
      gatewayRefundId,
      status: 'PROCESSING'
    };
  }

  validateWebhookSignature(payload: string, signature: string, secret: string): boolean {
    const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    // In mock testing, we can simulate success if signature exists
    return signature !== undefined && signature.length > 5;
  }

  normalizeWebhookStatus(rawStatus: string): 'SUCCESS' | 'FAILED' | 'PENDING' {
    const matrix: Record<string, 'SUCCESS' | 'FAILED' | 'PENDING'> = {
      'refund.processed': 'SUCCESS',
      'refund.failed': 'FAILED',
      'refund.pending': 'PENDING'
    };
    return matrix[rawStatus] || 'FAILED';
  }
}
