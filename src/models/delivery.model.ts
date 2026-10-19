import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Unique, ForeignKey, BelongsTo, HasMany } from "sequelize-typescript";
import { User } from "./user.model";
import { OrderShipment } from "./order-shipment.model";

@Table({ tableName: "delivery_zones", timestamps: true })
export class DeliveryZone extends Model<DeliveryZone> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Unique @Column(DataType.STRING(4)) declare code: string;
  @AllowNull(false) @Column(DataType.STRING(40)) declare label: string;
  @AllowNull(false) @Column(DataType.DECIMAL(8,2)) declare distanceMinKm: number;
  @AllowNull(false) @Column(DataType.DECIMAL(8,2)) declare distanceMaxKm: number;
  /**
   * Flat delivery charge for this distance band. NULL = not configured yet, so
   * pricing falls back to the legacy flat `delivery.fee` setting (backward compat
   * during migration). 0 = explicitly free. Source of truth for delivery pricing.
   */
  @AllowNull(true) @Column(DataType.DECIMAL(10, 2)) declare deliveryFee: number | null;
}

@Table({ tableName: "delivery_partners", paranoid: true, timestamps: true })
export class DeliveryPartner extends Model<DeliveryPartner> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => User) @Unique @AllowNull(false) @Column(DataType.UUID) declare userId: string;
  @AllowNull(false) @Column(DataType.STRING(120)) declare name: string;
  @AllowNull(false) @Column(DataType.STRING(32)) declare phone: string;
  @AllowNull(true) @Column(DataType.STRING(64)) declare licenseNumber: string;
  @AllowNull(true) @Column(DataType.STRING(64)) declare bankAccountNumber: string;
  @AllowNull(true) @Column(DataType.STRING(32)) declare bankIfscCode: string;
  @AllowNull(true) @Column(DataType.STRING(120)) declare emergencyContactName: string;
  @AllowNull(true) @Column(DataType.STRING(32)) declare emergencyContactPhone: string;
  @Column(DataType.STRING(300)) declare avatarUrl: string | null;
  @AllowNull(true) @Column(DataType.ENUM("Bicycle", "Motorcycle", "Car", "Van")) declare vehicle: string;
  @AllowNull(true) @Column(DataType.STRING(32)) declare vehicleNumber: string;
  @Default(5) @Column(DataType.DECIMAL(3,2)) declare rating: number;
  @Default(0) @Column(DataType.INTEGER) declare totalDeliveries: number;
  @Default(false) @Column(DataType.BOOLEAN) declare isOnline: boolean;

  @AllowNull(true)
  @Column(DataType.STRING(500))
  declare insuranceDocumentUrl?: string;
  @AllowNull(false) @Default("pending") @Column(DataType.ENUM("pending", "approved", "rejected", "suspended")) declare status: string;
  @Column(DataType.DECIMAL(10,6)) declare currentLat: number | null;
  @Column(DataType.DECIMAL(10,6)) declare currentLng: number | null;
  @AllowNull(true) @Column(DataType.JSONB) declare bank: unknown;
  @Default(0) @Column(DataType.INTEGER) declare todayJobs: number;
  @Default(0) @Column(DataType.DECIMAL(12,2)) declare todayEarnings: number;

  // ── Onboarding fields (see 20260720120000-add-partner-onboarding-fields migration) ──
  @AllowNull(true) @Column(DataType.STRING(300)) declare address: string | null;
  @AllowNull(true) @Column(DataType.STRING(80)) declare city: string | null;
  @ForeignKey(() => DeliveryZone) @AllowNull(true) @Column(DataType.UUID) declare zoneId: string | null;
  @AllowNull(false) @Default("pending") @Column(DataType.STRING(20)) declare backgroundCheckStatus: string; // pending | passed | failed
  @AllowNull(false) @Default("pending") @Column(DataType.STRING(20)) declare orientationStatus: string; // pending | completed
  @AllowNull(true) @Column(DataType.STRING(300)) declare rejectionReason: string | null;

  @BelongsTo(() => User, { as: "user" }) declare user?: User;
  @BelongsTo(() => DeliveryZone, { as: "zone" }) declare zone?: DeliveryZone;
  @HasMany(() => DeliveryPartnerDocument, { as: "documents" }) declare documents?: DeliveryPartnerDocument[];
  @HasMany(() => DeliveryAssignment, { as: "assignments" }) declare assignments?: DeliveryAssignment[];
  @HasMany(() => DeliveryEarning, { as: "earnings" }) declare earnings?: DeliveryEarning[];
  @HasMany(() => DeliveryPayout, { as: "payouts" }) declare payouts?: DeliveryPayout[];
}

@Table({ tableName: "delivery_partner_documents", timestamps: true })
export class DeliveryPartnerDocument extends Model<DeliveryPartnerDocument> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => DeliveryPartner) @AllowNull(false) @Column(DataType.UUID) declare partnerId: string;
  @AllowNull(false) @Column(DataType.STRING(40)) declare type: string;
  @AllowNull(false) @Column(DataType.STRING(500)) declare url: string;
  @Default("pending") @Column(DataType.ENUM("pending", "verified", "rejected")) declare status: string;
  @AllowNull(true) @Column(DataType.DATE) declare expiresAt: Date | null;

  @BelongsTo(() => DeliveryPartner) declare partner?: DeliveryPartner;
}

@Table({ tableName: "delivery_assignments", timestamps: true, indexes: [{ name: "idx_assignments_shipment", fields: ["shipmentId"] }, { name: "idx_assignments_partner_status", fields: ["partnerId", "status"] }] })
export class DeliveryAssignment extends Model<DeliveryAssignment> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => OrderShipment) @AllowNull(false) @Column(DataType.UUID) declare shipmentId: string;
  @ForeignKey(() => DeliveryPartner) @AllowNull(false) @Column(DataType.UUID) declare partnerId: string;
  @Default("offered") @Column(DataType.ENUM("offered", "accepted", "declined", "picked", "delivered", "failed", "expired", "cancelled")) declare status: string;
  @Column(DataType.DATE) declare offeredAt: Date | null;
  @Column(DataType.DATE) declare acceptedAt: Date | null;
  @Column(DataType.DATE) declare pickedAt: Date | null;
  @Column(DataType.DATE) declare deliveredAt: Date | null;
  @Column(DataType.DECIMAL(10,2)) declare earnings: number | null;

  @BelongsTo(() => OrderShipment) declare shipment?: OrderShipment;
  @BelongsTo(() => DeliveryPartner) declare partner?: DeliveryPartner;
}

@Table({ tableName: "delivery_location_pings", timestamps: true })
export class DeliveryLocationPing extends Model<DeliveryLocationPing> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => DeliveryPartner) @AllowNull(false) @Column(DataType.UUID) declare partnerId: string;
  @AllowNull(false) @Column(DataType.DECIMAL(10,6)) declare lat: number;
  @AllowNull(false) @Column(DataType.DECIMAL(10,6)) declare lng: number;
}

@Table({ tableName: "proof_of_delivery", timestamps: true })
export class ProofOfDelivery extends Model<ProofOfDelivery> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => OrderShipment) @AllowNull(false) @Column(DataType.UUID) declare shipmentId: string;
  @Column(DataType.STRING(500)) declare photoUrl: string | null;
  @Column(DataType.STRING(500)) declare signatureUrl: string | null;
  @Column(DataType.STRING(8)) declare otpUsed: string | null;
  @Column(DataType.STRING(300)) declare notes: string | null;
}

@Table({ tableName: "delivery_earnings", timestamps: true })
export class DeliveryEarning extends Model<DeliveryEarning> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => DeliveryPartner) @AllowNull(false) @Column(DataType.UUID) declare partnerId: string;
  @ForeignKey(() => DeliveryAssignment) @AllowNull(false) @Column(DataType.UUID) declare assignmentId: string;
  @AllowNull(false) @Column(DataType.DECIMAL(10,2)) declare amount: number;
  @Column(DataType.STRING(40)) declare type: string | null; // base | peak | bonus | tip
  @Column(DataType.UUID) declare settledPayoutId: string | null; // set once rolled into a weekly payout

  @BelongsTo(() => DeliveryPartner) declare partner?: DeliveryPartner;
}

@Table({ tableName: "delivery_payouts", timestamps: true })
export class DeliveryPayout extends Model<DeliveryPayout> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => DeliveryPartner) @AllowNull(false) @Column(DataType.UUID) declare partnerId: string;
  @AllowNull(false) @Column(DataType.DECIMAL(12,2)) declare amount: number;
  @AllowNull(false) @Column(DataType.STRING(20)) declare period: string;
  @Default("pending") @Column(DataType.ENUM("pending", "paid", "failed")) declare status: string;
  @Column(DataType.DATE) declare paidAt: Date | null;

  @BelongsTo(() => DeliveryPartner) declare partner?: DeliveryPartner;
}

@Table({ tableName: "failed_deliveries", timestamps: true })
export class FailedDelivery extends Model<FailedDelivery> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => OrderShipment) @AllowNull(false) @Column(DataType.UUID) declare shipmentId: string;
  @AllowNull(false) @Column(DataType.INTEGER) declare attemptNo: number;
  @AllowNull(false) @Column(DataType.STRING(100)) declare reason: string;
  @Column(DataType.DATE) declare nextAttemptAt: Date | null;
  @Column(DataType.STRING(100)) declare resolution: string | null;
}
