import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo, HasMany, AfterCreate } from "sequelize-typescript";
import { OrderStatus } from "../common/enums/order-status.enum";
import { Order } from "./order.model";
import { Shop } from "./shop.model";
import { User } from "./user.model";
import { ProductVariant } from "./product-variant.model";

/**
 * Waterfall precedence for parent-order status derivation.
 * Lower index = least advanced. When shipments are in mixed states the parent
 * reflects the LEAST-ADVANCED active shipment status, giving the customer the
 * most conservative (safest) view of their overall order.
 */
const STATUS_WATERFALL: OrderStatus[] = [
  OrderStatus.PLACED,
  OrderStatus.PAYMENT_PENDING,
  OrderStatus.PAYMENT_SUCCESS,
  OrderStatus.ROUTED,
  OrderStatus.CONFIRMED,
  OrderStatus.PACKED,
  OrderStatus.HANDED_OVER,
  OrderStatus.SHIPPED,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
];

@Table({ tableName: "order_shipments", timestamps: true, indexes: [{ name: "idx_shipments_order", fields: ["orderId"] }, { name: "idx_shipments_shop_status", fields: ["shopId", "status"] }, { name: "idx_shipments_status", fields: ["status"] }, { name: "idx_shipments_delivered", fields: ["deliveredAt"] }, { name: "idx_shipments_partner", fields: ["deliveryPartnerId"] }] })
export class OrderShipment extends Model<OrderShipment> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Order) @AllowNull(false) @Column(DataType.UUID) declare orderId: string;
  @ForeignKey(() => Shop) @AllowNull(false) @Column(DataType.UUID) declare shopId: string;
  @AllowNull(false) @Column(DataType.STRING(32)) declare shipmentNumber: string;
  @Default(OrderStatus.PLACED)
  @Column(DataType.ENUM(...Object.values(OrderStatus)))
  declare status: OrderStatus;
  @Column(DataType.STRING(60)) declare trackingNumber: string | null;
  @Column(DataType.UUID) declare deliveryPartnerId: string | null;
  @Column(DataType.UUID) declare settlementId: string | null;
  @Column(DataType.DATE) declare dispatchedAt: Date | null;
  @Column(DataType.DATE) declare deliveredAt: Date | null;
  @Column(DataType.DATE) declare acceptDeadlineAt: Date | null;
  @Column(DataType.DECIMAL(10, 6)) declare dropLat: number | null;
  @Column(DataType.DECIMAL(10, 6)) declare dropLng: number | null;

  @BelongsTo(() => Order) declare order?: Order;
  @BelongsTo(() => Shop) declare shop?: Shop;
  @HasMany(() => OrderItem) declare items?: OrderItem[];
  @HasMany(() => OrderStatusHistory, { foreignKey: "shipmentId" }) declare history?: OrderStatusHistory[];

  /**
   * Derive and persist the parent Order status from the current shipment statuses.
   *
   * Precedence rules (evaluated in order):
   *  1. ALL cancelled                 → CANCELLED
   *  2. ALL returned                  → RETURNED
   *  3. ALL refunded                  → REFUNDED
   *  4. ALL in (delivered|cancelled|returned|completed) → DELIVERED
   *  5. ANY cancel_requested          → CANCEL_REQUESTED  (customer requested, shop hasn't acted)
   *  6. ANY return_requested          → RETURN_REQUESTED
   *  7. ANY return_approved           → RETURN_APPROVED
   *  8. ANY refund_pending            → REFUND_PENDING
   *  9. ANY failed                    → FAILED
   * 10. Mixed active statuses         → least-advanced status wins (waterfall min)
   */
  static async deriveAndUpdateOrderStatus(orderId: string, transaction?: any): Promise<OrderStatus> {
    const shipments = await OrderShipment.findAll({ where: { orderId }, transaction });
    if (!shipments.length) return OrderStatus.PLACED;

    const statuses = shipments.map((s) => s.status);
    let derivedStatus: OrderStatus;

    // ── Terminal / unanimous states ─────────────────────────────────────────
    if (statuses.every((s) => s === OrderStatus.CANCELLED)) {
      derivedStatus = OrderStatus.CANCELLED;
    } else if (statuses.every((s) => s === OrderStatus.RETURNED)) {
      derivedStatus = OrderStatus.RETURNED;
    } else if (statuses.every((s) => s === OrderStatus.REFUNDED)) {
      derivedStatus = OrderStatus.REFUNDED;
    } else if (
      statuses.every((s) =>
        [OrderStatus.DELIVERED, OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.RETURNED].includes(s)
      )
    ) {
      derivedStatus = OrderStatus.DELIVERED;

    // ── Exception / interrupt states (any shipment) ──────────────────────────
    } else if (statuses.some((s) => s === OrderStatus.CANCEL_REQUESTED)) {
      derivedStatus = OrderStatus.CANCEL_REQUESTED;
    } else if (statuses.some((s) => s === OrderStatus.RETURN_REQUESTED)) {
      derivedStatus = OrderStatus.RETURN_REQUESTED;
    } else if (statuses.some((s) => s === OrderStatus.RETURN_APPROVED)) {
      derivedStatus = OrderStatus.RETURN_APPROVED;
    } else if (statuses.some((s) => s === OrderStatus.REFUND_PENDING)) {
      derivedStatus = OrderStatus.REFUND_PENDING;
    } else if (statuses.some((s) => s === OrderStatus.FAILED)) {
      derivedStatus = OrderStatus.FAILED;

    // ── Least-advanced active status (waterfall min) ─────────────────────────
    } else {
      // Exclude terminal/non-waterfall statuses when computing the min.
      const NON_WATERFALL = new Set<OrderStatus>([
        OrderStatus.CANCELLED, OrderStatus.RETURNED, OrderStatus.COMPLETED,
        OrderStatus.REFUNDED, OrderStatus.FAILED,
      ]);
      const activeStatuses = statuses.filter((s) => !NON_WATERFALL.has(s));
      if (activeStatuses.length === 0) {
        derivedStatus = OrderStatus.DELIVERED;
      } else {
        const minIdx = Math.min(
          ...activeStatuses.map((s) => {
            const idx = STATUS_WATERFALL.indexOf(s);
            return idx === -1 ? STATUS_WATERFALL.length : idx;
          })
        );
        derivedStatus = minIdx < STATUS_WATERFALL.length ? STATUS_WATERFALL[minIdx] : OrderStatus.PLACED;
      }
    }

    await Order.update({ status: derivedStatus }, { where: { id: orderId }, transaction });
    return derivedStatus;
  }
}

@Table({ tableName: "order_items", timestamps: true, indexes: [{ name: "idx_order_items_shipment", fields: ["shipmentId"] }, { name: "idx_order_items_shop", fields: ["shopId"] }, { name: "idx_order_items_product", fields: ["productId"] }, { name: "idx_order_items_variant", fields: ["variantId"] }] })
export class OrderItem extends Model<OrderItem> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => OrderShipment) @AllowNull(false) @Column(DataType.UUID) declare shipmentId: string;
  @ForeignKey(() => ProductVariant) @AllowNull(false) @Column(DataType.UUID) declare variantId: string;
  @ForeignKey(() => Shop) @AllowNull(false) @Column(DataType.UUID) declare shopId: string;
  
  @Column(DataType.UUID) declare productId: string | null;
  @Column(DataType.STRING) declare productName: string | null;
  @Column(DataType.STRING) declare productImage: string | null;
  @Column(DataType.STRING) declare sku: string | null;
  @Column(DataType.JSONB) declare variantAttributes: unknown | null;
  
  @AllowNull(false) @Column(DataType.INTEGER) declare quantity: number;
  @AllowNull(false) @Column(DataType.DECIMAL(12,2)) declare price: number; // legacy alias
  @Column(DataType.DECIMAL(12,2)) declare unitPrice: number | null;
  @Column(DataType.DECIMAL(12,2)) declare subtotal: number | null;

  // ── Per-line allocation snapshot (§2) — written at placement, read by the refund engine ──
  @Column(DataType.DECIMAL(12,2)) declare allocatedCoupon: number | null;
  @Column(DataType.DECIMAL(12,2)) declare allocatedLoyalty: number | null;
  @Column(DataType.DECIMAL(12,2)) declare allocatedGiftCard: number | null;
  @Column(DataType.DECIMAL(12,2)) declare allocatedTax: number | null;
  @Column(DataType.DECIMAL(12,2)) declare allocatedDelivery: number | null;
  @Column(DataType.DECIMAL(12,2)) declare allocatedWallet: number | null;
  @Column(DataType.DECIMAL(12,2)) declare allocatedCash: number | null;
  @Column(DataType.DECIMAL(12,2)) declare lineRefundableBase: number | null; // = allocatedWallet + allocatedCash
  @Default(0) @Column(DataType.DECIMAL(12,2)) declare refundedAmount: number; // running total refunded on this line
  
  @Default("pending") @Column(DataType.STRING(30)) declare fulfillmentStatus: string;

  // ── BOGO / free-goods (Buy X Get Y) ──────────────────────────────────────────
  // `isFree` = this line was granted by a promotion (price may be 0 for 100% BOGO
  // or a reduced price for a partial BOGO). `isBogo` narrows that to a Buy-X-Get-Y
  // reward specifically. `bogoParentVariantId` links the reward back to the purchased
  // ("buy") variant that earned it, so views can show the relationship.
  @Default(false) @Column(DataType.BOOLEAN) declare isFree: boolean;
  @Default(false) @Column(DataType.BOOLEAN) declare isBogo: boolean;
  @Column(DataType.UUID) declare bogoParentVariantId: string | null;
  // Promotion Engine (Phase 3): which automatic promotion granted this line (null for
  // legacy BOGO coupons / non-promo lines) and its type, for reporting.
  @Column(DataType.UUID) declare promotionId: string | null;
  @Column(DataType.STRING(30)) declare appliedPromotionType: string | null;

  @BelongsTo(() => OrderShipment) declare shipment?: OrderShipment;
  @BelongsTo(() => ProductVariant) declare variant?: ProductVariant;
}

@Table({ tableName: "order_status_history", timestamps: true, indexes: [{ name: "idx_status_history_order", fields: ["orderId"] }, { name: "idx_status_history_shipment", fields: ["shipmentId"] }] })
export class OrderStatusHistory extends Model<OrderStatusHistory> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Order) @Column(DataType.UUID) declare orderId: string | null;
  @ForeignKey(() => OrderShipment) @Column(DataType.UUID) declare shipmentId: string | null;
  @AllowNull(false) @Column(DataType.STRING(30)) declare status: string;
  @Column(DataType.STRING(300)) declare notes: string | null;
  @ForeignKey(() => User) @Column(DataType.UUID) declare actorId: string | null;
  /** Resolved actor profile — populated when queries include the User association. */
  @BelongsTo(() => User, { foreignKey: "actorId", constraints: false }) declare actor?: User;

  /** Set by the socket gateway; told about each shipment status row once it is committed. */
  static onShipmentStatus?: (row: { shipmentId: string; orderId: string | null; status: string }) => void;

  @AfterCreate
  static announceShipmentStatus(row: OrderStatusHistory, options: any) {
    const listener = OrderStatusHistory.onShipmentStatus;
    if (!listener || !row.shipmentId) return;
    const fire = () => {
      try { listener({ shipmentId: row.shipmentId!, orderId: row.orderId, status: row.status }); } catch { /* never fail a write over a push */ }
    };
    // Inside a transaction, wait for the commit: a rolled-back status must not reach anyone.
    if (options?.transaction) options.transaction.afterCommit(fire);
    else fire();
  }
}

@Table({ tableName: "routing_decisions", timestamps: true, indexes: [{ name: "idx_routing_order", fields: ["orderId"] }] })
export class RoutingDecision extends Model<RoutingDecision> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => Order) @AllowNull(false) @Column(DataType.UUID) declare orderId: string;
  @ForeignKey(() => ProductVariant) @AllowNull(false) @Column(DataType.UUID) declare variantId: string;
  @ForeignKey(() => Shop) @AllowNull(false) @Column(DataType.UUID) declare chosenShopId: string;
  @Column(DataType.JSONB) declare alternatives: unknown;
  @Column(DataType.STRING(200)) declare reason: string | null;
  @Column(DataType.DECIMAL(8,2)) declare distanceKm: number | null;
  @Column(DataType.STRING(4)) declare zone: string | null;

  @BelongsTo(() => ProductVariant, { foreignKey: "variantId" }) declare variant?: ProductVariant;
  @BelongsTo(() => Shop, { foreignKey: "chosenShopId" }) declare shop?: Shop;
}
