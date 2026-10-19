import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull } from "sequelize-typescript";

@Table({ tableName: "global_policies", timestamps: true, paranoid: true })
export class GlobalPolicy extends Model<GlobalPolicy> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @AllowNull(false)
  @Default(true)
  @Column(DataType.BOOLEAN)
  declare isReturnable: boolean;

  @AllowNull(false)
  @Default(true)
  @Column(DataType.BOOLEAN)
  declare isReplaceable: boolean;

  @AllowNull(false)
  @Default(7)
  @Column(DataType.INTEGER)
  declare returnWindowDays: number;

  @AllowNull(false)
  @Default(7)
  @Column(DataType.INTEGER)
  declare replacementWindowDays: number;

  @AllowNull(false)
  @Default("NONE")
  @Column(DataType.ENUM("NONE", "FIXED", "PERCENTAGE"))
  declare restockingFeeType: string;

  @AllowNull(false)
  @Default(0)
  @Column(DataType.DECIMAL(10, 2))
  declare restockingFeeValue: number;

  @AllowNull(false)
  @Default(false)
  @Column(DataType.BOOLEAN)
  declare requiresInspection: boolean;
}
