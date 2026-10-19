import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo } from "sequelize-typescript";
import { User } from "./user.model";

@Table({ tableName: "user_sessions", timestamps: true })
export class UserSession extends Model<UserSession> {
  @PrimaryKey @Default(DataType.UUIDV4) @Column(DataType.UUID) declare id: string;
  @ForeignKey(() => User) @AllowNull(false) @Column(DataType.UUID) declare userId: string;
  @BelongsTo(() => User) declare user?: User;
  @AllowNull(false) @Column(DataType.STRING(255)) declare refreshTokenHash: string;
  @Column(DataType.STRING(120)) declare device: string | null;
  @Column(DataType.STRING(48)) declare ip: string | null;
  @AllowNull(false) @Column(DataType.DATE) declare expiresAt: Date;
  @Default(false) @Column(DataType.BOOLEAN) declare revoked: boolean;
}
