import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "./user.model";

@Table({ tableName: "user_payment_methods", paranoid: true, timestamps: true })
export class UserPaymentMethod extends Model<UserPaymentMethod> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => User) @AllowNull(false) @Column(DataType.UUID) declare userId: string;
  @BelongsTo(() => User) declare user?: User;
  @AllowNull(false) @Column(DataType.STRING(20)) declare type: string; // card | upi | wallet | netbanking
  @Column(DataType.STRING(60)) declare brand: string | null;
  @Column(DataType.STRING(4)) declare last4: string | null;
  @Column(DataType.STRING(7)) declare expiryMonthYear: string | null;
  @Column(DataType.STRING(255)) declare gatewayToken: string | null;
  @Column(DataType.STRING(80)) declare upiId: string | null;
  @Default(false) @Column(DataType.BOOLEAN) declare isDefault: boolean;
}
