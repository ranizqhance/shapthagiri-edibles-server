import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "./user.model";

@Table({ tableName: "user_addresses", paranoid: true, timestamps: true, indexes: [{ name: "idx_addresses_user", fields: ["userId"] }] })
export class UserAddress extends Model<UserAddress> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => User) @AllowNull(false) @Column(DataType.UUID) declare userId: string;
  @BelongsTo(() => User) declare user?: User;
  @Column(DataType.STRING(40)) declare label: string;
  @AllowNull(false) @Column(DataType.STRING(200)) declare line1: string;
  @Column(DataType.STRING(200)) declare line2: string | null;
  @Column(DataType.STRING(100)) declare city: string;
  @Column(DataType.STRING(100)) declare state: string;
  @Column(DataType.STRING(16)) declare pincode: string;
  @Column(DataType.DECIMAL(10,6)) declare lat: number | null;
  @Column(DataType.DECIMAL(10,6)) declare lng: number | null;
  @Default(false) @Column(DataType.BOOLEAN) declare isDefault: boolean;
  @Column(DataType.STRING(200)) declare instructions: string | null;
}
