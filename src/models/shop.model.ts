import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, HasMany } from "sequelize-typescript";
import { ShopInventory } from "./shop-inventory.model";

@Table({ tableName: "shops", paranoid: true, timestamps: true, version: true })
export class Shop extends Model<Shop> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @AllowNull(false)
  @Column(DataType.STRING(160))
  declare name: string;

  @Column(DataType.STRING(300))
  declare address: string;

  @Column(DataType.STRING(100))
  declare city: string;

  @AllowNull(false)
  @Column(DataType.DECIMAL(10, 6))
  declare lat: number;

  @AllowNull(false)
  @Column(DataType.DECIMAL(10, 6))
  declare lng: number;

  @Column(DataType.STRING(32))
  declare phone: string | null;

  @Column(DataType.UUID)
  declare managerId: string | null;

  @Default(120)
  @Column(DataType.INTEGER)
  declare processingTimeMinutes: number;

  @Default(true)
  @Column(DataType.BOOLEAN)
  declare isActive: boolean;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare pickupEnabled: boolean;

  @Column(DataType.JSONB)
  declare operatingHours: Record<string, { open: string; close: string }> | null;

  @Column(DataType.STRING(100))
  declare email: string | null;

  @Column(DataType.STRING(100))
  declare state: string | null;

  @Column(DataType.STRING(100))
  declare country: string | null;

  @Column(DataType.STRING(20))
  declare postalCode: string | null;

  @Default(15)
  @Column(DataType.DECIMAL(6, 2))
  declare deliveryRadiusKm: number;

  @Default([])
  @Column(DataType.JSONB)
  declare supportedZones: string[];

  @Default([])
  @Column(DataType.JSONB)
  declare weeklyHolidays: string[];

  @Column(DataType.STRING(10))
  declare openingTime: string | null;

  @Column(DataType.STRING(10))
  declare closingTime: string | null;

  @Default(0)
  @Column(DataType.INTEGER)
  declare version: number;

  @HasMany(() => ShopInventory) declare inventory?: ShopInventory[];
}
