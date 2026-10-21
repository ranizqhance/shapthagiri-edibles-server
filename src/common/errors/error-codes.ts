export type ErrorCodeMeta = { status: number; message: string };

export const ERROR_CODES = {
  // Generic
  VALIDATION_FAILED:          { status: 422, message: "Request validation failed" },
  INTERNAL_ERROR:             { status: 500, message: "Something went wrong on our end" },
  NOT_FOUND:                  { status: 404, message: "Resource not found" },
  RATE_LIMITED:               { status: 429, message: "Too many requests" },
  // Phone OTP cannot be verified — no Firebase service account configured.
  // Distinct from INT_SMS_FAILED ("the SMS did not go out"), because here the
  // SMS was delivered fine and only server-side verification is unavailable.
  // The message points at the email fallback the checkout sheet already offers.
  OTP_PHONE_UNAVAILABLE:      { status: 503, message: "Mobile verification is temporarily unavailable. Please continue with email instead." },
  BAD_REQUEST:                { status: 400, message: "Bad request" },
  CONFLICT:                   { status: 409, message: "Conflict" },
  UNAUTHORIZED:               { status: 401, message: "Unauthorized" },
  FORBIDDEN:                  { status: 403, message: "Forbidden" },

  // Catalog
  CATEGORY_HAS_PRODUCTS:      { status: 409, message: "Category contains products" },
  CATEGORY_CIRCULAR_PARENT:   { status: 409, message: "Circular parent relationship detected" },
  CATEGORY_DUPLICATE_NAME:    { status: 409, message: "A category with this name already exists under this parent" },

  // Auth
  AUTH_INVALID_CREDENTIALS:   { status: 401, message: "Email or password is incorrect" },
  AUTH_TOKEN_EXPIRED:         { status: 401, message: "Session expired, please log in again" },
  AUTH_TOKEN_INVALID:         { status: 401, message: "Invalid authentication token" },
  AUTH_OTP_EXPIRED:           { status: 410, message: "OTP has expired, request a new one" },
  AUTH_OTP_INVALID:           { status: 422, message: "Invalid OTP" },
  AUTH_ACCOUNT_LOCKED:        { status: 423, message: "Account locked due to repeated failures" },
  AUTH_FORBIDDEN:             { status: 403, message: "You do not have permission for this action" },
  AUTH_EMAIL_TAKEN:           { status: 409, message: "Email already registered" },
  AUTH_PHONE_TAKEN:           { status: 409, message: "Phone number already registered" },

  // Cart / Inventory
  CART_EMPTY:                 { status: 400, message: "Your cart is empty" },
  CART_STOCK_CHANGED:         { status: 409, message: "Stock availability changed since you added items" },
  CART_PRICE_CHANGED:         { status: 409, message: "Prices changed since you added items" },
  INV_OUT_OF_STOCK:           { status: 409, message: "This item is out of stock" },
  INV_SHOP_NOT_SERVING:       { status: 400, message: "No shop delivers to this address" },

  // Orders
  ORDER_ALREADY_CANCELLED:    { status: 409, message: "Order is already cancelled" },
  ORDER_CANCEL_WINDOW:        { status: 409, message: "Cancellation window has passed" },
  ORDER_ADDRESS_UNSERVICEABLE:{ status: 400, message: "Selected address is not serviceable" },
  // Cash on delivery against an unverified identity: nothing ties a refused
  // consignment back to a real person, so those accounts must pay online.
  // Not thrown — COD is open to every signed-in customer.
  // Kept so an older client that still handles the code does not see an unknown one.
  COD_REQUIRES_PHONE:         { status: 400, message: "Cash on delivery needs a verified mobile number" },
  // Not thrown — COD places a real order again. Kept for older clients.
  COD_VIA_WHATSAPP:           { status: 400, message: "Cash on delivery orders are placed over WhatsApp" },

  // Payments
  PAY_DECLINED:               { status: 402, message: "Payment was declined by the bank" },
  PAY_GATEWAY_TIMEOUT:        { status: 504, message: "Payment gateway timed out" },
  PAY_FRAUD_SUSPECTED:        { status: 403, message: "Transaction flagged for review" },
  PAY_REFUND_FAILED:          { status: 500, message: "Refund could not be processed" },

  // Delivery
  DEL_NO_PARTNER:             { status: 503, message: "No delivery partner available right now" },
  DEL_ASSIGNMENT_EXPIRED:     { status: 410, message: "Assignment offer expired" },
  DEL_MAX_ATTEMPTS:            { status: 409, message: "Maximum delivery attempts reached" },

  // Coupons
  CPN_EXPIRED:                { status: 410, message: "Coupon has expired" },
  CPN_USAGE_LIMIT:            { status: 409, message: "Coupon usage limit reached" },
  CPN_NOT_APPLICABLE:         { status: 422, message: "Coupon not applicable to this cart" },

  // Routing / Shop
  RT_NO_STOCK_ANYWHERE:       { status: 409, message: "No shop has all items in stock" },
  RT_TIMEOUT:                 { status: 504, message: "Shop routing timed out" },
  SHOP_DISABLED:              { status: 423, message: "This shop is currently disabled" },

  // Integrations
  INT_GEOCODING_FAILED:       { status: 502, message: "Address lookup service unavailable" },
  INT_SMS_FAILED:             { status: 502, message: "SMS service unavailable" },
  INT_EMAIL_FAILED:           { status: 502, message: "Email service unavailable" },
  INT_STORAGE_FAILED:         { status: 502, message: "File upload service unavailable" },
  INT_DB_ERROR:               { status: 500, message: "Database error" },
  INT_GATEWAY_ERROR:          { status: 502, message: "External gateway error" },

  // Uploads
  UPLOAD_TOO_LARGE:           { status: 413, message: "File exceeds maximum size" },
  UPLOAD_INVALID_TYPE:        { status: 415, message: "Unsupported file type" },

  // Idempotency
  IDEMPOTENCY_CONFLICT:       { status: 409, message: "Request already processed with different payload" },
  IDEMPOTENCY_IN_PROGRESS:    { status: 409, message: "This request is still being processed" },
} as const satisfies Record<string, ErrorCodeMeta>;

export type ErrorCode = keyof typeof ERROR_CODES;
