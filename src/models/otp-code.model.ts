import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull } from "sequelize-typescript";

@Table({ tableName: "otp_codes", timestamps: true })
export class OtpCode extends Model<OtpCode> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @AllowNull(false) @Column(DataType.STRING(180)) declare identifier: string;
  @AllowNull(false) @Column(DataType.STRING(20)) declare channel: string; // sms | email
  @AllowNull(false) @Column(DataType.STRING(128)) declare codeHash: string;
  @AllowNull(false) @Column(DataType.STRING(40)) declare purpose: string;
  @AllowNull(false) @Column(DataType.DATE) declare expiresAt: Date;
  @Default(false) @Column(DataType.BOOLEAN) declare consumed: boolean;
  @Default(0) @Column(DataType.INTEGER) declare attempts: number;
}
