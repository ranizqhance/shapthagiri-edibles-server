import {
  Table,
  Column,
  Model,
  DataType,
  Index,
} from "sequelize-typescript";

@Table({
  tableName: "notification_templates",
  timestamps: true,
  // Explicit name: the generated one is 68 chars, Postgres truncates identifiers to
  // 63, so sync() never recognised the existing index and re-created it on every
  // boot ("relation ... already exists"). This is the truncated name already in
  // existing databases, so no migration is needed.
  indexes: [{ unique: true, name: "notification_templates_event_type_major_version_minor_version_l", fields: ["eventType", "majorVersion", "minorVersion", "locale"] }],
})
export class NotificationTemplate extends Model {
  @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
  id!: string;

  @Column({ 
    type: DataType.ENUM("ORDER_PLACED", "ORDER_SHIPPED", "ORDER_DELIVERED", "RETURN_CREATED", "RETURN_APPROVED", "RETURN_REJECTED", "REFUND_INITIATED", "REVIEW_APPROVED", "SECURITY", "SYSTEM"), 
    allowNull: false 
  })
  eventType!: string;

  @Column({ type: DataType.INTEGER, defaultValue: 1 })
  majorVersion!: number;

  @Column({ type: DataType.INTEGER, defaultValue: 0 })
  minorVersion!: number;

  @Column({ type: DataType.INTEGER, defaultValue: 0 })
  patchVersion!: number;

  @Column({ type: DataType.STRING, allowNull: false })
  locale!: string;

  @Column({ type: DataType.STRING, allowNull: true })
  fallbackLocale?: string;

  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  isDefault!: boolean;

  @Column({ type: DataType.STRING, allowNull: false })
  subject!: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  htmlBody!: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  textBody!: string;

  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  isActive!: boolean;

  @Column({ type: DataType.DATE, allowNull: true })
  publishedAt?: Date;
}
