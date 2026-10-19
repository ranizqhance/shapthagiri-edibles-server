import { AppException } from "../app.exception";

export class InvalidCredentialsException extends AppException { constructor() { super("AUTH_INVALID_CREDENTIALS"); } }
export class OtpExpiredException extends AppException { constructor() { super("AUTH_OTP_EXPIRED"); } }
export class OtpInvalidException extends AppException { constructor() { super("AUTH_OTP_INVALID"); } }
export class AccountLockedException extends AppException { constructor() { super("AUTH_ACCOUNT_LOCKED"); } }
export class EmailTakenException extends AppException { constructor() { super("AUTH_EMAIL_TAKEN"); } }
export class PhoneTakenException extends AppException { constructor() { super("AUTH_PHONE_TAKEN"); } }

export class CartEmptyException extends AppException { constructor() { super("CART_EMPTY"); } }
export class StockChangedException extends AppException { constructor(details?: Record<string, unknown>) { super("CART_STOCK_CHANGED", undefined, [], details); } }
export class OutOfStockException extends AppException { constructor(details?: Record<string, unknown>) { super("INV_OUT_OF_STOCK", undefined, [], details); } }
export class ShopNotServingException extends AppException { constructor() { super("INV_SHOP_NOT_SERVING"); } }

export class OrderAlreadyCancelledException extends AppException { constructor() { super("ORDER_ALREADY_CANCELLED"); } }
export class CancellationWindowExpiredException extends AppException { constructor() { super("ORDER_CANCEL_WINDOW"); } }
export class AddressNotServiceableException extends AppException { constructor() { super("ORDER_ADDRESS_UNSERVICEABLE"); } }

export class PaymentDeclinedException extends AppException { constructor(details?: Record<string, unknown>) { super("PAY_DECLINED", undefined, [], details); } }
export class FraudSuspectedException extends AppException { constructor() { super("PAY_FRAUD_SUSPECTED"); } }

export class NoPartnerAvailableException extends AppException { constructor() { super("DEL_NO_PARTNER"); } }
export class AssignmentExpiredException extends AppException { constructor() { super("DEL_ASSIGNMENT_EXPIRED"); } }

export class CouponExpiredException extends AppException { constructor() { super("CPN_EXPIRED"); } }
export class CouponUsageLimitException extends AppException { constructor() { super("CPN_USAGE_LIMIT"); } }
export class CouponNotApplicableException extends AppException { constructor() { super("CPN_NOT_APPLICABLE"); } }

export class NoShopHasStockException extends AppException { constructor() { super("RT_NO_STOCK_ANYWHERE"); } }
export class ShopDisabledException extends AppException { constructor() { super("SHOP_DISABLED"); } }
