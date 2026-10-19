import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Unique, BelongsToMany, HasMany } from "sequelize-typescript";
import { Permission } from "./permission.model";
import { RolePermission } from "./role-permission.model";
import { User } from "./user.model";

/**
 * An RBAC role — the single unit of authorization. System roles (`isSystem`) are
 * seeded and cannot be deleted or have their `key` changed; custom roles are
 * created by admins at runtime with any combination of permissions.
 *
 * A role's permissions are the `Permission` rows linked through `role_permissions`.
 * Nothing about authorization is hardcoded — it all resolves from these tables.
 */
@Table({ tableName: "roles", paranoid: true, timestamps: true })
export class Role extends Model<Role> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  /** Stable slug, e.g. "finance_staff". Immutable for system roles. */
  @AllowNull(false)
  @Unique
  @Column(DataType.STRING(60))
  declare key: string;

  @AllowNull(false)
  @Column(DataType.STRING(120))
  declare name: string;

  @Column(DataType.STRING(300))
  declare description: string | null;

  /** Seeded role: not deletable, key immutable. */
  @AllowNull(false)
  @Default(false)
  @Column(DataType.BOOLEAN)
  declare isSystem: boolean;

  /** Status toggle — an inactive role grants nothing (audited on change). */
  @AllowNull(false)
  @Default(true)
  @Column(DataType.BOOLEAN)
  declare isActive: boolean;

  @BelongsToMany(() => Permission, () => RolePermission)
  declare permissions?: Permission[];

  @HasMany(() => User)
  declare users?: User[];
}
