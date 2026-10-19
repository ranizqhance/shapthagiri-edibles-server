import { Table, Column, Model, DataType } from "sequelize-typescript";

@Table({ tableName: "fcm_tokens", timestamps: true })
export class FcmToken extends Model {
  @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4, primaryKey: true })
  id!: string;

  @Column({ type: DataType.UUID, allowNull: false })
  userId!: string;

  @Column({ type: DataType.STRING, allowNull: false })
  token!: string;
}
