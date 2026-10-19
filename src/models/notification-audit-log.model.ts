import { Table, Column, Model, DataType } from "sequelize-typescript";

@Table({ tableName: "notification_audit_logs", timestamps: true })
export class NotificationAuditLog extends Model {
  @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
  id!: string;

  @Column({ type: DataType.UUID, allowNull: false })
  userId!: string;

  @Column({ type: DataType.STRING, allowNull: false })
  channel!: string;

  @Column({ type: DataType.STRING, allowNull: false })
  status!: string;

  @Column({ type: DataType.UUID, allowNull: true })
  notificationId?: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  errorMessage?: string;
}
