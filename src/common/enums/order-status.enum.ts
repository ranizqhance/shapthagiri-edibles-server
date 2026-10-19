export enum OrderStatus {
  // Pre-fulfillment
  PLACED             = "placed",
  PAYMENT_PENDING    = "payment_pending",
  PAYMENT_SUCCESS    = "payment_success",
  ROUTED             = "routed",

  // Fulfillment lifecycle
  CONFIRMED          = "confirmed",    // shop accepted
  PACKED             = "packed",
  HANDED_OVER        = "handed_over",  // handed to delivery partner
  SHIPPED            = "shipped",      // en-route (legacy / internal alias)
  OUT_FOR_DELIVERY   = "out",
  DELIVERED          = "delivered",
  COMPLETED          = "completed",    // post-delivery (review window closed)

  // Cancellation flow
  CANCEL_REQUESTED   = "cancel_requested",
  CANCELLED          = "cancelled",
  FAILED             = "failed",

  // Returns & refunds
  RETURN_REQUESTED   = "return_requested",
  RETURN_APPROVED    = "return_approved",
  RETURNED           = "returned",
  REFUND_PENDING     = "refund_pending",
  REFUNDED           = "refunded",
}

export enum OrderType {
  NORMAL = "NORMAL",
  EXCHANGE_REPLACEMENT = "EXCHANGE_REPLACEMENT",
}

export enum PaymentMethod {
  CARD = "card",
  UPI = "upi",
  NET_BANKING = "net_banking",
  WALLET = "wallet",
  COD = "cod",
  // Stored value covered the whole order — no gateway was involved.
  GIFT_CARD = "gift_card",
}

export enum PaymentStatus {
  PENDING = "pending",
  AUTHORIZED = "authorized",
  CAPTURED = "captured",
  FAILED = "failed",
  REFUNDED = "refunded",
  PARTIAL_REFUNDED = "partial_refunded",
}

