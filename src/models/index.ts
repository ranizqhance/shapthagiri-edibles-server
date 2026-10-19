import { User } from "./user.model";
import { UserAddress } from "./user-address.model";
import { UserPaymentMethod } from "./user-payment-method.model";
import { UserSession } from "./user-session.model";
import { OtpCode } from "./otp-code.model";
import { Shop } from "./shop.model";
import { Category } from "./category.model";
import { Brand } from "./brand.model";
import { Product } from "./product.model";
import { ProductVariant } from "./product-variant.model";
import { ProductMedia } from "./product-media.model";
import { ProductPolicy } from "./product-policy.model";
import { CategoryPolicy } from "./category-policy.model";
import { GlobalPolicy } from "./global-policy.model";
import { ShopInventory } from "./shop-inventory.model";
import { StockMovement } from "./stock-movement.model";
import { InventoryReservation } from "./inventory-reservation.model";
import { Cart, CartItem } from "./cart.model";
import { Wishlist, WishlistItem, PriceDropAlert, BackInStockAlert } from "./wishlist.model";
import { Order } from "./order.model";
import { OrderShipment, OrderItem, OrderStatusHistory, RoutingDecision } from "./order-shipment.model";
import {
  DeliveryZone, DeliveryPartner, DeliveryPartnerDocument,
  DeliveryAssignment, DeliveryLocationPing, ProofOfDelivery,
  DeliveryEarning, DeliveryPayout, FailedDelivery,
} from "./delivery.model";
import { ShippingCarrier, ShippingZone, ShippingRateBand } from "./shipping.model";
import { Payment, PaymentRefund, Invoice, TaxRecord } from "./payment.model";
import { Return, ReturnMedia, Exchange } from "./return.model";
import { ProductReview, ReviewMedia, DeliveryReview, ReviewVote } from "./review.model";
import {
  Coupon, CouponRedemption, CouponHistory, LoyaltyAccount, LoyaltyTransaction,
  Referral, GiftCard, GiftCardTransaction, Campaign,
} from "./promotion.model";
import { Notification } from "./notification.model";
import { NotificationTemplate } from "./notification-template.model";
import { NotificationPreference } from "./notification-preference.model";
import { FcmToken } from "./fcm-token.model";
import { NotificationInbox } from "./notification-inbox.model";
import { NotificationAuditLog } from "./notification-audit-log.model";
import { SupportTicket, TicketMessage, Dispute, DisputeMessage } from "./support.model";
import {
  AuditLog, FeatureFlag, Setting, IdempotencyKey,
  PeakMultiplier, DeliveryHoliday, SearchQuery, ScheduledReport,
} from "./admin.model";
import { Settlement } from "./settlement.model";
import { EarningWallet } from "./earning-wallet.model";
import { LedgerEntry } from "./ledger-entry.model";
import { CustomerWallet, WalletTransaction } from "./wallet.model";
import { Role } from "./role.model";
import { Permission } from "./permission.model";
import { RolePermission } from "./role-permission.model";
import { EmailLog } from "./email-log.model";
import { Deal } from "./deal.model";
import { Promotion } from "./promotion-engine.model";
import { PromotionRedemption } from "./promotion-redemption.model";

export const ALL_MODELS = [
  User, UserAddress, UserPaymentMethod, UserSession, OtpCode,
  Shop, Category, Brand,
  Product, ProductVariant, ProductMedia,
  ProductPolicy, CategoryPolicy, GlobalPolicy,
  ShopInventory, StockMovement, InventoryReservation,
  Cart, CartItem,
  Wishlist, WishlistItem, PriceDropAlert, BackInStockAlert,
  Order, OrderShipment, OrderItem, OrderStatusHistory, RoutingDecision,
  DeliveryZone, DeliveryPartner, DeliveryPartnerDocument,
  DeliveryAssignment, DeliveryLocationPing, ProofOfDelivery,
  DeliveryEarning, DeliveryPayout, FailedDelivery,
  Payment, PaymentRefund, Invoice, TaxRecord,
  Return, ReturnMedia, Exchange,
  ProductReview, ReviewMedia, DeliveryReview, ReviewVote,
  Coupon, CouponRedemption, CouponHistory, LoyaltyAccount, LoyaltyTransaction,
  Referral, GiftCard, GiftCardTransaction, Campaign,
  Notification, NotificationTemplate, NotificationPreference, FcmToken, NotificationInbox, NotificationAuditLog,
  SupportTicket, TicketMessage, Dispute, DisputeMessage,
  AuditLog, FeatureFlag, Setting, IdempotencyKey,
  PeakMultiplier, DeliveryHoliday, SearchQuery, ScheduledReport,
  Settlement, EarningWallet, LedgerEntry,
  CustomerWallet, WalletTransaction,
  Role, Permission, RolePermission,
  EmailLog,
  Deal,
  Promotion,
  PromotionRedemption,
  ShippingCarrier, ShippingZone, ShippingRateBand,
];

export {
  User, UserAddress, UserPaymentMethod, UserSession, OtpCode,
  Shop, Category, Brand,
  Product, ProductVariant, ProductMedia,
  ProductPolicy, CategoryPolicy, GlobalPolicy,
  ShopInventory, StockMovement, InventoryReservation,
  Cart, CartItem,
  Wishlist, WishlistItem, PriceDropAlert, BackInStockAlert,
  Order, OrderShipment, OrderItem, OrderStatusHistory, RoutingDecision,
  DeliveryZone, DeliveryPartner, DeliveryPartnerDocument,
  DeliveryAssignment, DeliveryLocationPing, ProofOfDelivery,
  DeliveryEarning, DeliveryPayout, FailedDelivery,
  Payment, PaymentRefund, Invoice, TaxRecord,
  Return, ReturnMedia, Exchange,
  ProductReview, ReviewMedia, DeliveryReview, ReviewVote,
  Coupon, CouponRedemption, CouponHistory, LoyaltyAccount, LoyaltyTransaction,
  Referral, GiftCard, GiftCardTransaction, Campaign,
  Notification, NotificationTemplate, NotificationPreference, FcmToken, NotificationInbox, NotificationAuditLog,
  SupportTicket, TicketMessage, Dispute, DisputeMessage,
  AuditLog, FeatureFlag, Setting, IdempotencyKey,
  PeakMultiplier, DeliveryHoliday, SearchQuery, ScheduledReport,
  Settlement, EarningWallet, LedgerEntry,
  CustomerWallet, WalletTransaction,
  Role, Permission, RolePermission,
  EmailLog,
  Deal,
  Promotion,
  PromotionRedemption,
  ShippingCarrier, ShippingZone, ShippingRateBand,
};

