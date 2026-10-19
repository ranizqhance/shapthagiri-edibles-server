import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Unique, BelongsToMany } from "sequelize-typescript";
import { Role } from "./role.model";
import { RolePermission } from "./role-permission.model";

/**
 * The permission CATALOG — the universe of grantable permissions. Rows are seeded
 * from `rbac.catalog.ts` and can grow over time. A synthetic `key = "*"` row is the
 * all-access wildcard held only by admin / super_admin.
 *
 * Assignments (which role has which permission) live in `role_permissions`, never
 * here — this table only defines what CAN be granted.
 */
@Table({ tableName: "permissions", timestamps: true })
export class Permission extends Model<Permission> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  /** `<module>.<action>`, e.g. "products.create"; or "*" for the wildcard. */
  @AllowNull(false)
  @Unique
  @Column(DataType.STRING(100))
  declare key: string;

  @AllowNull(false)
  @Column(DataType.STRING(60))
  declare module: string;

  @AllowNull(false)
  @Column(DataType.STRING(60))
  declare action: string;

  @AllowNull(false)
  @Column(DataType.STRING(80))
  declare label: string;

  @Column(DataType.STRING(120))
  declare moduleLabel: string | null;

  /** Sidebar section grouping (e.g. "Catalog", "Finance"). */
  @Column(DataType.STRING(60))
  declare moduleGroup: string | null;

  @AllowNull(false)
  @Default(0)
  @Column(DataType.INTEGER)
  declare sortModule: number;

  @AllowNull(false)
  @Default(0)
  @Column(DataType.INTEGER)
  declare sortAction: number;

  @AllowNull(false)
  @Default(true)
  @Column(DataType.BOOLEAN)
  declare isActive: boolean;

  @BelongsToMany(() => Role, () => RolePermission)
  declare roles?: Role[];
}
