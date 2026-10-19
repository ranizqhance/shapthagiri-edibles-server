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

@Table({
  tableName: "notification_preferences",
  timestamps: true,
  indexes: [{ unique: true, fields: ["userId"] }],
})
export class NotificationPreference extends Model {
  @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
  id!: string;

  @ForeignKey(() => User)
  @Column({ type: DataType.UUID, allowNull: false })
  userId!: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  preferences!: any;

  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  enabled!: boolean;

  @Column({ type: DataType.DATE, allowNull: true })
  muteUntil?: Date;

  @Column({ type: DataType.STRING, allowNull: true })
  quietHoursStart?: string;

  @Column({ type: DataType.STRING, allowNull: true })
  quietHoursEnd?: string;

  @Column({ type: DataType.STRING, allowNull: true })
  timezone?: string;

  @ForeignKey(() => User)
  @Column({ type: DataType.UUID, allowNull: true })
  updatedBy?: string;

  @BelongsTo(() => User, "userId")
  user!: User;
}
