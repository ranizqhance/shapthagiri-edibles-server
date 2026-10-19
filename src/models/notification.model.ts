import {
  Table,
  Column,
  Model,
  DataType,
  ForeignKey,
  BelongsTo,
  Index,
} from "sequelize-typescript";
import { User } from "./user.model";
import { Shop } from "./shop.model";

@Table({ tableName: "notifications", timestamps: true })
export class Notification extends Model {
  @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
  id!: string;

  @ForeignKey(() => User)
  @Index("idx_notifications_user_created")
  @Index("idx_notifications_user_isread")
  @Column({ type: DataType.UUID, allowNull: false })
  userId!: string;

  @ForeignKey(() => Shop)
  @Column({ type: DataType.UUID, allowNull: true })
  shopId?: string;

  @Index("idx_notifications_type_created")
  @Column({ 
    type: DataType.ENUM("ORDER_PLACED", "ORDER_SHIPPED", "ORDER_DELIVERED", "RETURN_CREATED", "RETURN_APPROVED", "RETURN_REJECTED", "REFUND_INITIATED", "REVIEW_APPROVED", "SECURITY", "SYSTEM"), 
    allowNull: false 
  })
  type!: string;

  @Column({ 
    type: DataType.ENUM("CREATED", "QUEUED", "PROCESSING", "DELIVERED", "FAILED"), 
    allowNull: false 
  })
  status!: string;

  @Index("idx_notifications_priority_created")
  @Column({ type: DataType.STRING, allowNull: false })
  priority!: string;

  @Column({ type: DataType.STRING, allowNull: false })
  title!: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  body!: string;

  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'all' })
  channel!: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  metadata?: any;

  @Column({ type: DataType.INTEGER, defaultValue: 1 })
  metadataVersion!: number;

  @Column({ 
    type: DataType.ENUM("EMAIL_SES", "EMAIL_SMTP", "SMS_TWILIO", "SMS_MSG91", "PUSH_FCM", "INAPP", "WEBHOOK"), 
    allowNull: false 
  })
  provider!: string;

  @Column({ type: DataType.STRING, allowNull: true })
  providerMessageId?: string;

  @Column({ type: DataType.STRING, allowNull: true })
  providerStatus?: string;

  @Column({ type: DataType.INTEGER, defaultValue: 0 })
  attemptCount!: number;

  @Column({ type: DataType.DATE, allowNull: true })
  lastAttemptAt?: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  deliveredAt?: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  failedAt?: Date;

  @Column({ type: DataType.STRING, allowNull: true })
  failureReason?: string;

  // Named for a composite on (userId, isRead) that it never was — kept so the
  // existing database is not churned, with the real composite added above.
  @Index("idx_notifications_user_read")
  @Index("idx_notifications_user_isread")
  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  isRead!: boolean;

  @Column({ type: DataType.DATE, allowNull: true })
  readAt?: Date;

  @Index("idx_notifications_expires")
  @Column({ type: DataType.DATE, allowNull: false })
  expiresAt!: Date;

  @BelongsTo(() => User)
  user!: User;

  @BelongsTo(() => Shop)
  shop?: Shop;
}
