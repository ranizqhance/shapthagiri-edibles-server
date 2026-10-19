import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Unique, BelongsTo } from "sequelize-typescript";
import { User } from "./user.model";

@Table({ tableName: "audit_logs", timestamps: true })
export class AuditLog extends Model<AuditLog> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @Column(DataType.UUID) declare actorId: string | null;
  @BelongsTo(() => User, "actorId") declare actor: User;
  @AllowNull(false) @Column(DataType.STRING(60)) declare action: string;
  @AllowNull(false) @Column(DataType.STRING(60)) declare entity: string;
  @Column(DataType.STRING(60)) declare entityId: string | null;
  @Column(DataType.JSONB) declare before: unknown;
  @Column(DataType.JSONB) declare after: unknown;
  @Column(DataType.STRING(48)) declare ip: string | null;
  @Column(DataType.STRING(300)) declare userAgent: string | null;
  @Column(DataType.STRING(64)) declare correlationId: string | null;
}

@Table({ tableName: "feature_flags", timestamps: true })
export class FeatureFlag extends Model<FeatureFlag> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Unique @Column(DataType.STRING(80)) declare key: string;
  @Default(false) @Column(DataType.BOOLEAN) declare enabled: boolean;
  @Default(0) @Column(DataType.INTEGER) declare rolloutPct: number;
  @Column(DataType.JSONB) declare conditions: unknown;
}

@Table({ tableName: "settings", timestamps: true })
export class Setting extends Model<Setting> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Unique @Column(DataType.STRING(80)) declare key: string;
  @AllowNull(false) @Column(DataType.JSONB) declare value: unknown;
  @Column(DataType.STRING(40)) declare scope: string | null;
}

@Table({ tableName: "idempotency_keys", timestamps: true })
export class IdempotencyKey extends Model<IdempotencyKey> {
  @PrimaryKey @Column(DataType.STRING(120)) declare key: string;
  @AllowNull(false) @Column(DataType.STRING(200)) declare endpoint: string;
  @AllowNull(false) @Column(DataType.STRING(64)) declare requestHash: string;
  @Column(DataType.JSONB) declare responseSnapshot: unknown;
  @AllowNull(false) @Column(DataType.DATE) declare expiresAt: Date;
}

@Table({ tableName: "peak_multipliers", timestamps: true })
export class PeakMultiplier extends Model<PeakMultiplier> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.STRING(80)) declare label: string;
  @AllowNull(false) @Column(DataType.DATE) declare startsAt: Date;
  @AllowNull(false) @Column(DataType.DATE) declare endsAt: Date;
  @AllowNull(false) @Column(DataType.DECIMAL(4,2)) declare multiplier: number;
  @Column(DataType.STRING(40)) declare appliesTo: string | null;
}

@Table({ tableName: "delivery_holidays", timestamps: true })
export class DeliveryHoliday extends Model<DeliveryHoliday> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.DATEONLY) declare date: string;
  @AllowNull(false) @Column(DataType.STRING(80)) declare name: string;
  @Column(DataType.UUID) declare shopId: string | null;
  @Default("all") @Column(DataType.ENUM("all", "zone", "shop")) declare appliesTo: string;
}

@Table({ tableName: "search_queries", timestamps: true })
export class SearchQuery extends Model<SearchQuery> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @Column(DataType.UUID) declare userId: string | null;
  @AllowNull(false) @Column(DataType.STRING(200)) declare query: string;
  @Default(0) @Column(DataType.INTEGER) declare resultsCount: number;
  @Default(false) @Column(DataType.BOOLEAN) declare converted: boolean;
}

@Table({ tableName: "scheduled_reports", timestamps: true })
export class ScheduledReport extends Model<ScheduledReport> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.UUID) declare ownerId: string;
  @AllowNull(false) @Column(DataType.STRING(60)) declare reportType: string;
  @AllowNull(false) @Column(DataType.STRING(40)) declare cronExpr: string;
  @AllowNull(false) @Column(DataType.JSONB) declare recipients: unknown;
  @Column(DataType.DATE) declare lastRunAt: Date | null;
  /** Attachment formats to generate, e.g. ["pdf","csv"]. Defaults to PDF. */
  @Default(["pdf"]) @Column(DataType.JSONB) declare formats: unknown;
  /** Enable/disable (pause) a schedule without deleting it. Disabled = not swept. */
  @Default(true) @Column(DataType.BOOLEAN) declare enabled: boolean;
  /** Outcome of the most recent run: "success" | "failed" | null (never run). */
  @Column(DataType.STRING(20)) declare lastStatus: string | null;
  /** Error message from the most recent failed run (cleared on success). */
  @Column(DataType.TEXT) declare lastError: string | null;
}
