/*
 * Column lists for rows that leave the API to people who should not see the
 * whole row. Applied at the query, not in the models (model scopes would
 * change every internal query too).
 */

/** A variant as anonymous shoppers see it — never `costPrice`, our margin. */
export const VARIANT_PUBLIC_ATTRS = ["id", "productId", "sku", "attributes", "defaultPrice", "mrp", "weightKg"];

/** A payment as its customer sees it — no idempotency key or gateway order id. */
export const PAYMENT_CUSTOMER_ATTRS = ["id", "orderId", "method", "gateway", "gatewayRef", "amount", "status", "createdAt", "updatedAt"];

/** A gift card as its holder sees it — no staff notes, rules or audit columns. */
export const GIFT_CARD_HOLDER_ATTRS = [
  "id", "code", "type", "initialBalance", "balance", "currency", "status", "description",
  "expiresAt", "isPartialRedemptionAllowed", "createdAt",
];
