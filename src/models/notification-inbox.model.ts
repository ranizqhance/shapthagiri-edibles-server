import { Table, Column, Model, DataType } from "sequelize-typescript";

@Table({ tableName: "notification_inboxes", timestamps: true, indexes: [{ name: "idx_inbox_user_cat_read_created", fields: ["userId", "category", "readStatus", "createdAt"] }, { name: "idx_inbox_user_created", fields: ["userId", "createdAt"] }] })
export class NotificationInbox extends Model {
  @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
  id!: string;

  @Column({ type: DataType.UUID, allowNull: false })
  userId!: string;

  @Column({ type: DataType.STRING, allowNull: false })
  title!: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  message!: string;

  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  readStatus!: boolean;

  @Column({ type: DataType.STRING, allowNull: true })
  clickAction?: string;

  @Column({ type: DataType.STRING, defaultValue: "MEDIUM" })
  priority!: string;

  @Column({ type: DataType.STRING, defaultValue: "system" })
  category!: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  actions?: any;

  @Column({ type: DataType.JSONB, allowNull: true })
  subItems?: any;

  @Column({ type: DataType.STRING, allowNull: true })
  thumbnail?: string;

  @Column({ type: DataType.INTEGER, defaultValue: 1 })
  occurrences!: number;

  @Column({ type: DataType.STRING, allowNull: true })
  idempotencyKey?: string;

  @Column({ type: DataType.DATE, allowNull: true })
  expiresAt?: Date;

  // Triage fields. The inbox controller already reads/writes all four
  // (archive/snooze/assign/resolve + the "exclude archived" list filter), but
  // they were never declared here — so list/summary threw
  // "column NotificationInbox.archivedAt does not exist", and the mutations
  // silently no-opped because Sequelize drops unknown attributes.
  @Column({ type: DataType.DATE, allowNull: true })
  archivedAt?: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  snoozeUntil?: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  resolvedAt?: Date;

  @Column({ type: DataType.UUID, allowNull: true })
  assignedTo?: string;
}
