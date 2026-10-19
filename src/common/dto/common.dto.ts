// src/common/dto/common.dto.ts
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Allow, ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested, ValidationOptions, registerDecorator } from "class-validator";
import { PartialType } from "@nestjs/mapped-types";
import { Type } from "class-transformer";

/**
 * A grid of on/off switches — one row per notification type, one column per
 * channel (in-app, email, push).
 *
 * Needed because `@IsObject()` rejects arrays outright, so the matrix the
 * preferences screen sends was refused on every save. Validated rather than
 * waved through with `@Allow()`, since this lands in a JSONB column where
 * anything at all would otherwise stick.
 */
function IsBooleanMatrix(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isBooleanMatrix",
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return (
            Array.isArray(value) &&
            // At least one row. A non-array (say a stray object) is coerced to
            // [] before validation runs, which would otherwise pass and quietly
            // wipe the customer's saved preferences.
            value.length >= 1 &&
            value.length <= 50 &&
            value.every(
              (row) =>
                Array.isArray(row) &&
                row.length <= 10 &&
                row.every((cell) => typeof cell === "boolean"),
            )
          );
        },
        defaultMessage() {
          return "notificationPrefs must be an array of rows, each a list of true/false values";
        },
      },
    });
  };
}

/* ===== Users ===== */
export class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  /**
   * Changing this changes what the customer signs in with, and it is how an
   * account created from a phone OTP replaces its synthetic
   * `<uid>@firebase.user` placeholder with an address that can receive mail.
   */
  @ApiPropertyOptional({ example: "someone@example.com" }) @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() avatarUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() dateOfBirth?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() gender?: string;
  @ApiPropertyOptional({
    description: "Rows of channel switches, one row per notification type",
    example: [[true, true, false], [true, false, false]],
  })
  @IsOptional() @IsBooleanMatrix() notificationPrefs?: boolean[][];
}

export class AddressDto {
  @ApiProperty({ example: "Home" }) @IsString() label!: string;
  @ApiProperty({ example: "16/257A, Pulinkav" }) @IsString() line1!: string;
  @ApiPropertyOptional({ example: "Cherukara PO" }) @IsOptional() @IsString() line2?: string;
  @ApiPropertyOptional({ example: "Malappuram" }) @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional({ example: "Kerala" }) @IsOptional() @IsString() state?: string;
  @ApiPropertyOptional({ example: "679340" }) @IsOptional() @IsString() pincode?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() instructions?: string;
}

// PATCH is a partial update: "Set default" sends only { isDefault: true }, so
// label/line1 must not be required or the request 422s.
export class UpdateAddressDto extends PartialType(AddressDto) {}

export class PaymentMethodDto {
  @ApiProperty({ example: "card" }) @IsString() type!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() brand?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() last4?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() expiryMonthYear?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() gatewayToken?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() upiId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

/* ===== Catalog ===== */
export class CategoryDto {
  @ApiProperty({ example: "Pickles" }) @IsString() name!: string;
  @ApiPropertyOptional({ example: "pickles" }) @IsOptional() @IsString() slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() icon?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

// DTO for creating a new Category
export class CreateCategoryDto {
  @ApiProperty({ example: 'Pickles' }) @IsString() name!: string;
  @ApiPropertyOptional({ example: 'pickles' }) @IsOptional() @IsString() slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() icon?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateCategoryDto extends PartialType(CategoryDto) {}

export class BrandDto {
  @ApiProperty({ example: "Shreshtam" }) @IsString() name!: string;
  @ApiPropertyOptional({ example: "shreshtam" }) @IsOptional() @IsString() slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() logoUrl?: string;
}

export class ProductPolicyDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isReturnable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isReplaceable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) returnWindowDays?: number;
}

export class ProductDto {
  @ApiProperty({ example: "Kadumanga (Tender Mango Pickle)" }) @IsString() title!: string;
  @ApiPropertyOptional({ example: "kadumanga-tender-mango-pickle" }) @IsOptional() @IsString() slug?: string;
  @ApiPropertyOptional({ example: "Traditional Kerala tender mango pickle" }) @IsOptional() @IsString() subtitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() brandId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() specifications?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsUUID() shopId?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) shopIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() defaultPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() mrp?: number;
  @ApiPropertyOptional() @IsOptional() @ValidateNested() @Type(() => ProductPolicyDto) policy?: ProductPolicyDto;
  // Marker the product form sends to say "this product manages its own variants,
  // don't auto-create a default one". Must be declared or `whitelist: true`
  // strips it, and the guard silently created phantom SKU-###### variants.
  @ApiPropertyOptional() @IsOptional() @IsBoolean() _hasCombinations?: boolean;
  // Base stock for a SIMPLE product, written to ShopInventory.quantity for each
  // assigned shop. Variant products set stock per-shop in the inventory flow.
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) baseStock?: number;
}

export class VariantDto {
  @ApiProperty({ example: "SKU-2001" }) @IsString() sku!: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() attributes?: Record<string, unknown>;
  @ApiProperty({ example: 225 }) @IsNumber() defaultPrice!: number;
  @ApiProperty({ example: 260 }) @IsNumber() mrp!: number;
  @ApiPropertyOptional({ example: 0.5 }) @IsOptional() @IsNumber() weightKg?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() barcode?: string;
}

export class MediaDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() variantId?: string;
  @ApiProperty({ example: "/shreshtam/products/kadumanga-tender-mango-pickle-1.png" }) @IsString() url!: string;
  @ApiProperty({ example: "image" }) @IsString() type!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
}

export class CompareDto {
  /*
   * Bounded and typed. `@IsArray()` alone accepted any contents and any
   * length, and the value goes straight into `where: { id: b.ids }` — so a
   * few thousand ids in a single 100kb body became one enormous IN clause.
   * There was no @ArrayMaxSize anywhere in the codebase.
   */
  @ApiProperty({ type: [String], maxItems: 20 })
  @IsArray() @ArrayMaxSize(20) @IsUUID("4", { each: true })
  ids!: string[];
}

/* ===== Shops ===== */
/**
 * Inline "Create New Shop Manager" payload on the New/Edit Shop form.
 *
 * A shop manager can never exist without a shop (see AdminController.
 * resolveShopAssignment), and a brand-new shop has no id until it is inserted —
 * so the account cannot be provisioned by a separate call beforehand. This DTO
 * lets the shop and its manager be created together in ONE transaction.
 */
export class NewShopManagerDto {
  @ApiProperty({ example: "Jane Doe" }) @IsString() @IsNotEmpty() name!: string;
  @ApiProperty({ example: "manager@shreshtam.in" }) @IsEmail() email!: string;
  @ApiProperty({ example: "s3cret123" }) @IsString() @MinLength(6, { message: "Password must be at least 6 characters" }) password!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\+?[0-9]{10,15}$/, { message: "Invalid phone number format" }) phone?: string;
}

export class ShopDto {
  @ApiProperty({ example: "Shreshtam — Cherukara" }) @IsString() name!: string;
  @ApiProperty({ example: "16/257A, Pulinkav, Cherukara PO" }) @IsString() address!: string;
  @ApiProperty({ example: "Malappuram" }) @IsString() city!: string;
  @ApiProperty({ example: 10.9264 }) @IsNumber() lat!: number;
  @ApiProperty({ example: 76.2275 }) @IsNumber() lng!: number;
  @ApiPropertyOptional({ example: "+919902012150" }) @IsOptional() @IsString() @Matches(/^\+?[0-9]{10,15}$/, { message: "Invalid phone number format" }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() processingTimeMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() pickupEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;

  @ApiPropertyOptional({ example: "shreshtamgroup@gmail.com" }) @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional({ example: "Kerala" }) @IsOptional() @IsString() state?: string;
  @ApiPropertyOptional({ example: "India" }) @IsOptional() @IsString() country?: string;
  @ApiPropertyOptional({ example: "679340" }) @IsOptional() @IsString() postalCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.1, { message: "Radius must be greater than 0 km" }) @Max(100, { message: "Radius cannot exceed 100 km" }) deliveryRadiusKm?: number;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) supportedZones?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) weeklyHolidays?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() openingTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() closingTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() managerId?: string;
  /** Provision a new shop_manager atomically with the shop. Mutually exclusive with managerId. */
  @ApiPropertyOptional({ type: NewShopManagerDto })
  @IsOptional() @ValidateNested() @Type(() => NewShopManagerDto)
  newManager?: NewShopManagerDto;
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}

export class InterShopTransferDto {
  @ApiProperty() @IsUUID() sourceShopId!: string;
  @ApiProperty() @IsUUID() destinationShopId!: string;
  @ApiProperty() @IsUUID() variantId!: string;
  @ApiProperty() @IsInt() @Min(1) quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

/**
 * POST /inventory/transfer. Same operation as InterShopTransferDto but tolerant of
 * the legacy fromShopId/toShopId field names the endpoint originally shipped with;
 * exactly one naming pair must be supplied.
 */
export class InventoryTransferDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() sourceShopId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() destinationShopId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() fromShopId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() toShopId?: string;
  @ApiProperty() @IsUUID() variantId!: string;
  @ApiProperty() @IsInt() @Min(1) quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}


/* ===== Inventory ===== */
export class InventoryUpdateDto {
  @ApiPropertyOptional({ example: 50 }) @IsOptional() @IsInt() @Min(0) quantity?: number;
  @ApiPropertyOptional({ example: 215 }) @IsOptional() @IsNumber() priceOverride?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() lowStockThreshold?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class InventoryBulkItemDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() variantId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sku?: string;
  @ApiProperty() @IsInt() quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() priceOverride?: number;
}

export class InventoryBulkDto {
  @ApiProperty({ type: [InventoryBulkItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InventoryBulkItemDto)
  items!: InventoryBulkItemDto[];
}

export class ScanDto {
  @ApiProperty({ example: "8901234567890" }) @IsString() barcode!: string;
  @ApiProperty({ example: "IN" }) @IsString() direction!: string;
  @ApiPropertyOptional({ example: 1 }) @IsOptional() @IsInt() quantity?: number;
}

/**
 * Unauthenticated order tracking. The order number alone is a weak secret, so
 * the contact that placed the order has to be supplied with it.
 */
export class OrderLookupDto {
  @ApiProperty({ example: "ORD-M2XK4P-9A3F" })
  @IsString() @MinLength(4) @MaxLength(40)
  orderNumber!: string;

  @ApiProperty({ example: "9902012150", description: "The mobile number or email the order was placed with." })
  @IsString() @MinLength(4) @MaxLength(180)
  contact!: string;
}

/**
 * One row of the courier rate card, in grams and upper-inclusive to match its
 * "Weight upto gm" heading: a parcel over `minG` and up to `maxG` costs `charge`.
 */
export class ShippingBandDto {
  @ApiProperty({ example: 0 }) @IsInt() @Min(0) minG!: number;
  @ApiProperty({ example: 1000 }) @IsInt() @Min(1) maxG!: number;
  @ApiProperty({ example: 57 }) @IsNumber() @Min(0) charge!: number;
}

/** Switch which courier's card prices orders. */
export class ActiveCarrierDto {
  @ApiProperty({ example: "PROCOURIER" }) @IsString() code!: string;
}

/** A destination tier and its whole rate card, saved in one go. */
export class ShippingZoneDto {
  @ApiPropertyOptional({ example: "KL" }) @IsOptional() @IsString() @MaxLength(16) code?: string;
  @ApiProperty({ example: "Kerala" }) @IsString() @MaxLength(60) name!: string;
  /** Delivery-address states this zone covers. Empty on the catch-all zone. */
  @ApiPropertyOptional({ type: [String], example: ["Kerala"] })
  @IsOptional() @IsArray() @IsString({ each: true }) states?: string[];
  @ApiPropertyOptional({ example: false }) @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional({ example: 40, description: "Charged per whole kg past the heaviest band." })
  @IsOptional() @IsNumber() @Min(0) perKgAboveTopBand?: number;
  @ApiPropertyOptional({ type: [ShippingBandDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ShippingBandDto)
  bands?: ShippingBandDto[];
}

/** The entire grid, as the admin screen edits it. */
export class ShippingRatesSaveDto {
  @ApiProperty({ type: [ShippingZoneDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ShippingZoneDto)
  zones!: ShippingZoneDto[];
}

/* ===== Cart ===== */
export class CartAddDto {
  @ApiProperty() @IsUUID() variantId!: string;
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) quantity!: number;
  // Serving shop resolved from the customer's delivery address (single-serving-shop).
  // When set, price + availability come from this shop only.
  @ApiPropertyOptional() @IsOptional() @IsUUID() shopId?: string;
}

/**
 * Lines carried over from a guest (browser-local) cart when the customer signs
 * in at checkout. Bounded so a forged request cannot ask the server to price
 * thousands of variants in one transaction.
 */
export class CartMergeDto {
  @ApiProperty({ type: () => [CartAddDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CartAddDto)
  items!: CartAddDto[];
}

export class CartUpdateDto {
  @ApiPropertyOptional({ example: 2 }) @IsOptional() @IsInt() @Min(1) quantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() variantId?: string;
}

export class CouponApplyDto {
  @ApiProperty({ example: "WELCOME20" }) @IsString() code!: string;
}

export class CartCouponApplyDto extends CouponApplyDto {
  @ApiProperty({ example: 1500 }) @IsNumber() cartTotal!: number;
  @ApiPropertyOptional() @IsOptional() @IsArray() items?: any[];
  @ApiPropertyOptional() @IsOptional() @IsString() paymentMethod?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() deliveryMethod?: string;
}

export class EligibleCouponsDto {
  @ApiProperty({ example: 1500 }) @IsNumber() cartTotal!: number;
  @ApiPropertyOptional() @IsOptional() @IsArray() items?: any[];
  @ApiPropertyOptional() @IsOptional() @IsString() paymentMethod?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() deliveryMethod?: string;
}

export class DeliveryModeDto {
  @ApiProperty({ example: "combined", enum: ["combined", "split"] }) @IsString() mode!: string;
}

/* ===== Wishlist ===== */
export class WishlistAddDto {
  @ApiProperty() @IsUUID() variantId!: string;
}

export class PriceDropAlertDto {
  @ApiProperty() @IsUUID() variantId!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() threshold?: number;
}

/* ===== Delivery Engine ===== */
export class EtaItemDto {
  @ApiProperty() @IsUUID() variantId!: string;
  @ApiProperty() @IsInt() quantity!: number;
}

export class EstimateDto {
  /** Destination state — selects the shipping zone. Resolved from addressId when omitted. */
  @ApiPropertyOptional({ example: "Kerala" }) @IsOptional() @IsString() state?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() addressId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;
  @ApiProperty({ type: [EtaItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EtaItemDto)
  items!: EtaItemDto[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() express?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() freeDelivery?: boolean;
}

export class DeliveryZoneDto {
  // Admins now manage distance bands as From/To/Charge only. Code + label are
  // auto-generated internally (kept for routing/shop/partner compatibility) and SLA
  // has sensible defaults — all optional so the simplified UI never sends them.
  @ApiPropertyOptional({ example: "A" }) @IsOptional() @IsString() code?: string;
  @ApiPropertyOptional({ example: "Local" }) @IsOptional() @IsString() label?: string;
  @ApiProperty() @IsNumber() distanceMinKm!: number;
  @ApiProperty() @IsNumber() distanceMaxKm!: number;
  // Flat delivery charge for this band (₹). Optional — NULL falls back to the legacy
  // flat delivery.fee setting during migration; 0 = free.
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) deliveryFee?: number;
}

export class PeakMultiplierDto {
  @ApiProperty() @IsString() label!: string;
  @ApiProperty({ example: "2026-11-01T00:00:00Z" }) @IsString() startsAt!: string;
  @ApiProperty({ example: "2026-11-10T23:59:59Z" }) @IsString() endsAt!: string;
  @ApiProperty({ example: 1.25 }) @IsNumber() multiplier!: number;
}

export class HolidayDto {
  @ApiProperty({ example: "2026-12-25" }) @IsString() date!: string;
  @ApiProperty({ example: "Christmas" }) @IsString() name!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() shopId?: string;
}

/* ===== Orders ===== */
export class PlaceOrderDto {
  @ApiProperty() @IsObject() addressSnapshot!: Record<string, unknown>;
  @ApiProperty({ example: 10.9264 }) @IsNumber() lat!: number;
  @ApiProperty({ example: 76.2275 }) @IsNumber() lng!: number;
  /**
   * The methods that can still place an order here. `cod` is absent on purpose:
   * cash on delivery is handed to WhatsApp and creates nothing, and the service
   * refuses it too. `gift_card`/`wallet` are not accepted from the client — the
   * service derives them when stored value covers the whole amount.
   *
   * Was `@IsString()` alone, which let any string through to a Postgres ENUM
   * column and turned a typo into a 500.
   */
  @ApiProperty({ example: "upi", enum: ["card", "upi", "net_banking"] })
  @IsIn(["card", "upi", "net_banking"])
  paymentMethod!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() couponCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() express?: boolean;

  // Apply the customer's wallet balance to this order. `useWallet` applies as
  // much as possible; `walletAmount` caps it (partial payment).
  @ApiPropertyOptional() @IsOptional() @IsBoolean() useWallet?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) walletAmount?: number;

  // Gift card applied to this order (used by the buy-now flow, which has no
  // server cart). Must be declared or `whitelist: true` strips it and the card
  // is silently ignored — the customer then pays full price.
  @ApiPropertyOptional() @IsOptional() @IsUUID() giftCardId?: string;

  // Loyalty points the customer wants to redeem on this order. The server is
  // authoritative: it converts points→discount, caps to the goods value and the
  // available balance, and deducts within the order transaction.
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) loyaltyPoints?: number;

  // Serving shop resolved from the delivery address (single-serving-shop). When
  // set, the order is fulfilled and priced from this shop only — no cross-shop routing.
  @ApiPropertyOptional() @IsOptional() @IsUUID() shopId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  buyNowVariantId?: string;

  @ApiPropertyOptional()
  @IsInt()
  @Min(1)
  @IsOptional()
  buyNowQuantity?: number;
}

export class ReassignDto {
  @ApiProperty() @IsUUID() newShopId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

/* ===== Loyalty (admin) ===== */
export class LoyaltyAdjustDto {
  @ApiProperty() @IsUUID() userId!: string;
  // Positive credits, negative debits. Balance is floored at 0 by the engine.
  @ApiProperty({ example: 100 }) @IsInt() points!: number;
  @ApiProperty({ example: "Goodwill credit" }) @IsString() @IsNotEmpty() reason!: string;
}

/* ===== Partners ===== */
export class PartnerRegisterDto {
  @ApiProperty({ example: "Akash P" }) @IsString() name!: string;
  @ApiProperty({ example: "+919876510022" }) @IsString() phone!: string;
  @ApiProperty({ example: "Motorcycle" }) @IsString() vehicle!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vehicleNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() avatarUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;
}

export class PartnerDocumentDto {
  @ApiProperty({ example: "driving_license" }) @IsString() type!: string;
  @ApiProperty() @IsString() url!: string;
  @ApiPropertyOptional({ example: "2027-01-01" }) @IsOptional() @IsString() expiresAt?: string;
}

export class PartnerOnlineDto {
  @ApiProperty() @IsBoolean() online!: boolean;
}

export class PartnerPingDto {
  @ApiProperty() @IsNumber() lat!: number;
  @ApiProperty() @IsNumber() lng!: number;
}

export class DeliverDto {
  @ApiPropertyOptional({ example: 95 }) @IsOptional() @IsNumber() earnings?: number;
}

export class FailDto {
  @ApiProperty({ example: "Customer unavailable" }) @IsString() reason!: string;
}

/* ===== Delivery-partner onboarding & admin lifecycle ===== */
export class OnboardDocumentDto {
  @ApiProperty({ example: "driving_license" }) @IsString() type!: string;
  @ApiProperty() @IsString() url!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() expiresAt?: string;
}

export class PartnerOnboardDto {
  @ApiProperty({ example: "Akash P" }) @IsString() name!: string;
  @ApiProperty({ example: "+919876510022" }) @IsString() phone!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() email?: string;
  @ApiProperty({ example: "Motorcycle" }) @IsString() vehicle!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vehicleNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() avatarUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() licenseNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bankAccountNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bankIfscCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bankName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() emergencyContactName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() emergencyContactPhone?: string;
  @ApiPropertyOptional({ type: [OnboardDocumentDto] }) @IsOptional() @IsArray() documents?: OnboardDocumentDto[];
}

export class RejectPartnerDto {
  @ApiProperty({ example: "Driving license expired" }) @IsString() reason!: string;
}

export class AssignZoneDto {
  @ApiProperty() @IsUUID() zoneId!: string;
}

export class BackgroundCheckDto {
  @ApiProperty({ example: "passed", enum: ["passed", "failed", "pending"] }) @IsString() result!: string;
}

export class OrientationDto {
  @ApiProperty({ example: true }) @IsBoolean() completed!: boolean;
}

export class VerifyPartnerDto {
  @ApiPropertyOptional({ example: false, description: "Admin override of onboarding gating" }) @IsOptional() @IsBoolean() override?: boolean;
}

/* ===== Shipments ===== */
export class PodDto {
  @ApiPropertyOptional() @IsOptional() @IsString() photoUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() signatureUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() otpUsed?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class DropPinDto {
  @ApiProperty() @IsNumber() lat!: number;
  @ApiProperty() @IsNumber() lng!: number;
}

/* ===== Payments ===== */
export class PaymentIntentDto {
  @ApiProperty() @IsUUID() orderId!: string;
  @ApiProperty({ example: "card" }) @IsString() method!: string;
  // Advisory only — the server charges the order's own payableAmount. A
  // client-supplied amount is never trusted (tamperable, and would be the gross
  // total rather than what is left after gift card + wallet).
  @ApiPropertyOptional({ example: 4820 }) @IsOptional() @IsNumber() amount?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() gateway?: string;
}

export class PaymentVerifyDto {
  @ApiProperty() @IsString() razorpay_order_id!: string;
  @ApiProperty() @IsString() razorpay_payment_id!: string;
  @ApiProperty() @IsString() razorpay_signature!: string;
}

export class RefundDto {
  @ApiProperty() @IsUUID() paymentId!: string;
  @ApiProperty() @IsNumber() amount!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

/* ===== Returns ===== */
export class CreateReturnDto {
  @ApiProperty() @IsUUID() orderItemId!: string;
  @ApiProperty({ example: "damaged" }) @IsString() reason!: string;
  @ApiPropertyOptional({ example: "pickup" }) @IsOptional() @IsString() method?: string;
  // Units to return. Omit = the whole line (legacy). Bounded to remaining
  // eligible quantity server-side.
  @ApiPropertyOptional({ example: 2 }) @IsOptional() @IsInt() @Min(1) quantity?: number;
}

/** One selected line in a multi-item return/replacement request. */
export class ReturnBatchItemDto {
  @ApiProperty() @IsUUID() orderItemId!: string;
  @ApiProperty({ example: 2 }) @IsInt() @Min(1) quantity!: number;
}

export class CreateReturnBatchDto {
  @ApiProperty({ type: [ReturnBatchItemDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReturnBatchItemDto)
  items!: ReturnBatchItemDto[];
  @ApiProperty({ example: "damaged" }) @IsString() reason!: string;
  @ApiPropertyOptional({ example: "pickup" }) @IsOptional() @IsString() method?: string;
  // "return" (refund) or "exchange" (same-variant replacement) for the whole batch.
  @ApiPropertyOptional({ example: "return" }) @IsOptional() @IsIn(["return", "exchange"]) type?: "return" | "exchange";
}

export class ReturnMediaDto {
  @ApiProperty() @IsString() url!: string;
}

export class RefundReturnDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() refundId?: string;
  // Fields processRefund reads — must be declared or `whitelist: true` strips them.
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) amount?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
  // Store-credit refund: credit the customer's wallet instead of the gateway.
  @ApiPropertyOptional() @IsOptional() @IsBoolean() toWallet?: boolean;
  @ApiPropertyOptional({ example: "wallet" }) @IsOptional() @IsString() method?: string;
}

export class ExchangeDto {
  @ApiProperty() @IsUUID() replacementVariantId!: string;
  // Units to replace. Omit = the whole line (legacy).
  @ApiPropertyOptional({ example: 2 }) @IsOptional() @IsInt() @Min(1) quantity?: number;
}

/* ===== Reviews ===== */
export class ProductReviewDto {
  // @Max(5) was missing — a rating of 9999 was accepted.
  @ApiProperty({ example: 5 }) @IsInt() @Min(1) @Max(5) rating!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) text?: string;
  /** Uploaded media URLs (from POST /uploads). */
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) media?: string[];
}

export class UpdateReviewDto {
  @ApiPropertyOptional({ example: 4 }) @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) text?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) media?: string[];
}

export class ReviewReplyDto {
  @ApiProperty({ example: "Thanks for the feedback!" }) @IsString() @MaxLength(2000) text!: string;
}

export class DeliveryReviewDto {
  // Had no bounds at all — negatives and 9999 were accepted.
  @ApiProperty({ example: 5 }) @IsInt() @Min(1) @Max(5) rating!: number;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) feedback?: string;
}

export class ModerateDto {
  // Was a bare @IsString(), so any junk value could be persisted as a status.
  @ApiProperty({ example: "approved", enum: ["pending", "approved", "rejected"] })
  @IsIn(["pending", "approved", "rejected"])
  status!: string;

  @ApiPropertyOptional({ example: "Contains profanity" }) @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/* ===== Promotions ===== */

export class CouponDto {
  @ApiProperty({ example: "WELCOME20" }) @IsString() code!: string;
  // Coupon types are code-driven money discounts only. BOGO moved to the Promotion
  // Engine (Phase 6), so it is no longer accepted here.
  @ApiProperty({ example: "pct", enum: ["pct", "flat", "free_delivery"] })
  @IsIn(["pct", "flat", "free_delivery"]) type!: string;
  // Not required for free_delivery (its benefit is not a flat "value").
  @ApiProperty({ example: 20 }) @ValidateIf(o => o.type !== "free_delivery") @IsNumber() value!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() minOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() usageLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() perUserLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() expiresAt?: string;

  @ApiPropertyOptional() @IsOptional() @IsInt() priority?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() stackable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() firstOrderOnly?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() newCustomerOnly?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() rules?: Record<string, unknown>;
}

export class UpdateCouponDto extends PartialType(CouponDto) {}

export class GiftCardDto {
  @ApiProperty({ example: "GIFT-1000" }) @IsString() code!: string;
  @ApiProperty({ example: 1000 }) @IsNumber() balance!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() expiresAt?: string;
}

export class CampaignDto {
  @ApiProperty({ example: "Onam Specials" }) @IsString() name!: string;
  @ApiProperty({ example: "push" }) @IsString() channel!: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() segment?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsString() scheduledAt?: string;
}

/* ===== Deals of the Day (product-level marketing promotion) ===== */
export class DealDto {
  @ApiProperty({ example: "ab6cbf2f-ba5b-49d5-8b80-bb7e168f8a4c" }) @IsUUID() productId!: string;
  @ApiProperty({ example: "pct", enum: ["pct", "flat"] }) @IsIn(["pct", "flat"]) discountType!: string;
  @ApiProperty({ example: 20 }) @IsNumber() @Min(0) discountValue!: number;
  @ApiProperty({ example: "2026-07-29T00:00:00.000Z" }) @IsDateString() startsAt!: string;
  @ApiProperty({ example: "2026-07-30T23:59:59.000Z" }) @IsDateString() endsAt!: string;
  @ApiPropertyOptional({ example: 0 }) @IsOptional() @IsInt() priority?: number;
  @ApiPropertyOptional({ example: true }) @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateDealDto extends PartialType(DealDto) {}

/* ===== Promotion Engine (automatic promotions — plan Phase 1) ===== */
export class PromotionDto {
  @ApiProperty({ example: "Onam Sadhya Special — 10% Off" }) @IsString() name!: string;
  @ApiProperty({ enum: ["auto", "buy_x_get_y", "buy_x_get_x", "cart", "category", "festival", "flash"] })
  @IsIn(["auto", "buy_x_get_y", "buy_x_get_x", "cart", "category", "festival", "flash"]) type!: string;
  @ApiPropertyOptional({ enum: ["cart", "product", "variant", "category", "brand", "shop", "all"] })
  @IsOptional() @IsIn(["cart", "product", "variant", "category", "brand", "shop", "all"]) scope?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() scopeIds?: string[];
  @ApiPropertyOptional({ enum: ["pct", "flat", "reward"] }) @IsOptional() @IsIn(["pct", "flat", "reward"]) discountKind?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) discountValue?: number;
  @ApiPropertyOptional() @IsOptional() @IsObject() rewardRule?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsInt() priority?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() stackable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() usageLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() perUserLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() stockCap?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() shopId?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() shopIds?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() excludeShopIds?: string[];
  @ApiPropertyOptional({ enum: ["draft", "active", "paused", "inactive", "expired"] })
  @IsOptional() @IsIn(["draft", "active", "paused", "inactive", "expired"]) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}
export class UpdatePromotionDto extends PartialType(PromotionDto) {}

/** Read-only resolver preview input: evaluate active promotions against a cart. */
export class ResolvePromotionsDto {
  @ApiProperty({ type: [Object], description: "Cart lines: { variantId, quantity, shopId?, priceSnapshot? }" })
  @IsArray() items!: any[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() shopId?: string;
}

/** Read-only orchestrator preview: merge promotions + an optional coupon (Phase 2). */
export class OrchestratePreviewDto {
  @ApiProperty({ type: [Object], description: "Cart lines: { variantId, quantity, shopId?, priceSnapshot? }" })
  @IsArray() items!: any[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() shopId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() couponCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() paymentMethod?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() deliveryMethod?: string;
}

/* ===== Notifications ===== */
export class FcmTokenDto {
  @ApiProperty() @IsString() platform!: string;
  @ApiProperty() @IsString() token!: string;
}

export class TemplateDto {
  @ApiProperty() @IsString() code!: string;
  @ApiProperty() @IsString() title!: string;
  @ApiProperty() @IsString() body!: string;
  @ApiProperty() @IsString() channel!: string;
}

export class SendNotificationDto {
  @ApiProperty() @IsUUID() userId!: string;
  @ApiProperty() @IsString() title!: string;
  @ApiProperty() @IsString() body!: string;
  @ApiProperty({ enum: ["push", "email", "sms", "all"] }) @IsString() channel!: string;
}

/* ===== Support ===== */
export class TicketDto {
  @ApiProperty({ example: "Item damaged on arrival" }) @IsString() subject!: string;
  @ApiPropertyOptional({ example: "high" }) @IsOptional() @IsString() priority?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() orderId?: string;
}

export class TicketMessageDto {
  @ApiProperty() @IsString() body!: string;
}

export class TicketAssignDto {
  @ApiProperty() @IsUUID() agentId!: string;
}

/* ===== Disputes ===== */
export const DISPUTE_TYPES = ["item_not_received", "not_as_described", "damaged", "wrong_item", "billing", "delivery", "other"] as const;
export const DISPUTE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const DISPUTE_DESIRED = ["refund", "replacement", "apology", "other"] as const;
export const DISPUTE_RESOLUTION_TYPES = ["refund_wallet", "refund_source", "gift_card", "replacement", "goodwill", "none"] as const;

export class CreateDisputeDto {
  @ApiProperty() @IsUUID() orderId!: string;
  @ApiProperty({ enum: DISPUTE_TYPES }) @IsOptional() @IsIn(DISPUTE_TYPES as unknown as string[]) type?: string;
  @ApiProperty({ example: "Only 2 of 3 items arrived" }) @IsString() @MaxLength(300) issue!: string;
  @ApiPropertyOptional({ enum: DISPUTE_PRIORITIES }) @IsOptional() @IsIn(DISPUTE_PRIORITIES as unknown as string[]) priority?: string;
  @ApiPropertyOptional({ enum: DISPUTE_DESIRED }) @IsOptional() @IsIn(DISPUTE_DESIRED as unknown as string[]) desiredResolution?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) amountClaimed?: number;
  // Evidence image URLs (uploaded via /uploads) attached at creation.
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() attachments?: string[];
}

/** Inbound payment-gateway chargeback → mapped to a Dispute. Called by the
 * gateway webhook handler (or Finance manually). Idempotent on `externalRef`. */
export class ChargebackDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() orderId?: string;
  @ApiPropertyOptional({ description: "Gateway payment ref, if orderId unknown" }) @IsOptional() @IsString() paymentRef?: string;
  @ApiProperty({ description: "Gateway dispute id (idempotency key)" }) @IsString() externalRef!: string;
  @ApiProperty() @IsNumber() @Min(0) amount!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class DisputeMessageDto {
  @ApiProperty() @IsString() @MaxLength(4000) body!: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() attachments?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() internal?: boolean;
}

export class AssignDisputeDto {
  @ApiProperty() @IsUUID() agentId!: string;
}

export class EscalateDisputeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class RejectDisputeDto {
  @ApiProperty() @IsString() @MaxLength(500) reason!: string;
}

export class ResolveDisputeDto {
  @ApiProperty({ enum: DISPUTE_RESOLUTION_TYPES }) @IsIn(DISPUTE_RESOLUTION_TYPES as unknown as string[]) resolutionType!: string;
  @ApiProperty() @IsString() @MaxLength(1000) resolution!: string;
  // Required for monetary resolution types (refund_wallet / refund_source / gift_card).
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) amount?: number;
}

/* ===== Finance ===== */
export class ScheduleReportSpecDto {
  @ApiProperty({ example: "weekly" }) @IsString() frequency!: string;
  @ApiPropertyOptional({ example: "09:00" }) @IsOptional() @IsString() time?: string;
  @ApiPropertyOptional({ example: 1 }) @IsOptional() @IsInt() weekday?: number;
  @ApiPropertyOptional({ example: 1 }) @IsOptional() @IsInt() monthDay?: number;
  @ApiPropertyOptional({ example: 1 }) @IsOptional() @IsInt() month?: number;
}

export class ScheduleReportDto {
  @ApiProperty() @IsString() reportType!: string;
  // Optional: the raw cron (advanced/power users). When omitted, the backend derives
  // it from `schedule` below so business users never touch cron syntax.
  @ApiPropertyOptional({ example: "0 9 * * 1" }) @IsOptional() @IsString() cronExpr?: string;
  // Business-friendly schedule. The backend converts it to a cron expression.
  @ApiPropertyOptional({ type: ScheduleReportSpecDto }) @IsOptional() @ValidateNested() @Type(() => ScheduleReportSpecDto) schedule?: ScheduleReportSpecDto;
  // Validated + deduped in the handler (invalid addresses are reported back), so we
  // accept a loose array here rather than @IsEmail which would 422 the whole request.
  @ApiProperty({ type: [String] }) @IsArray() recipients!: string[];
  // Attachment formats to generate. Subset of ["pdf","csv"]; defaults to ["pdf"].
  @ApiPropertyOptional({ type: [String], example: ["pdf", "csv"] }) @IsOptional() @IsArray() formats?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
}

/* ===== Admin ===== */
export class AdminCreateUserDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty() @IsString() email!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiProperty() @IsString() password!: string;
  @ApiProperty({ example: "admin" }) @IsString() role!: string;
  // RBAC role (source of truth for permissions). Sent by the Admin Users UI, which
  // loads roles from the Roles & Permissions module. `role` above carries the same
  // role's key for the structural provisioning branches (shop_manager/delivery_partner).
  @ApiPropertyOptional() @ValidateIf((o) => !!o.roleId) @IsUUID() roleId?: string;
  // Validate as UUID only when a non-empty value is supplied; an empty string (the
  // "Unassigned" option) is allowed through so the handler can reject it with a
  // clear "must be assigned to a shop" message instead of a generic 422.
  @ApiPropertyOptional() @ValidateIf((o) => !!o.shopId) @IsUUID() shopId?: string;

  // Delivery-partner details — REQUIRED only when role === "delivery_partner"
  // (ValidateIf skips them for every other role, keeping the fast invite path).
  @ApiPropertyOptional({ example: "Motorcycle" }) @ValidateIf((o) => o.role === "delivery_partner") @IsString() @IsNotEmpty() vehicle?: string;
  @ApiPropertyOptional({ example: "KL-10-AA-0001" }) @ValidateIf((o) => o.role === "delivery_partner") @IsString() @IsNotEmpty() vehicleNumber?: string;
  @ApiPropertyOptional({ example: "Malappuram" }) @ValidateIf((o) => o.role === "delivery_partner") @IsString() @IsNotEmpty() city?: string;
  @ApiPropertyOptional() @ValidateIf((o) => o.role === "delivery_partner") @IsUUID() zoneId?: string;
  @ApiPropertyOptional({ example: "Cherukara PO, Malappuram, Kerala 679340" }) @ValidateIf((o) => o.role === "delivery_partner") @IsString() @IsNotEmpty() address?: string;
  @ApiPropertyOptional({ example: "SBI" }) @ValidateIf((o) => o.role === "delivery_partner") @IsString() @IsNotEmpty() bankName?: string;
  @ApiPropertyOptional({ example: "1234567890" }) @ValidateIf((o) => o.role === "delivery_partner") @IsString() @IsNotEmpty() bankAccountNumber?: string;
  @ApiPropertyOptional({ example: "SBIN0000123" }) @ValidateIf((o) => o.role === "delivery_partner") @IsString() @IsNotEmpty() bankIfscCode?: string;
  // Required documents (gov_id, driving_license, rc, insurance) — enforced in createUser.
  @ApiPropertyOptional({ type: [OnboardDocumentDto] }) @ValidateIf((o) => o.role === "delivery_partner") @IsArray() @ValidateNested({ each: true }) @Type(() => OnboardDocumentDto) documents?: OnboardDocumentDto[];
}

export class UpdateRoleDto {
  // `role` carries the assigned RBAC role's key (drives structural branches like the
  // shop-manager shop requirement); `roleId` is the RBAC role itself and the source
  // of truth for the user's permissions.
  @ApiProperty() @IsString() role!: string;
  @ApiPropertyOptional() @ValidateIf((o) => !!o.roleId) @IsUUID() roleId?: string;
  // See AdminCreateUserDto.shopId — empty string passes validation so the handler
  // can return a clear message; a non-empty value must be a real shop UUID.
  @ApiPropertyOptional() @ValidateIf((o) => !!o.shopId) @IsUUID() shopId?: string;
}

export class FeatureFlagDto {
  @ApiProperty() @IsString() key!: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() rolloutPct?: number;
  @ApiPropertyOptional() @IsOptional() @IsObject() conditions?: Record<string, unknown>;
}

export class SettingUpsertDto {
  @ApiProperty() @Allow() value!: unknown;
  @ApiPropertyOptional() @IsOptional() @IsString() scope?: string;
}
