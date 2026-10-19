import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Unique, Scopes, DefaultScope, HasMany, ForeignKey, BelongsTo, BeforeCreate, BeforeUpdate } from "sequelize-typescript";
import { Role } from "../common/enums/role.enum";
import { UserAddress } from "./user-address.model";
import { UserPaymentMethod } from "./user-payment-method.model";
import { UserSession } from "./user-session.model";
import { Order } from "./order.model";
import { Shop } from "./shop.model";
import { Role as RbacRole } from "./role.model";

/**
 * Sensitive columns (passwordHash) are excluded by default so they never leak
 * out of generic queries / `users/me`. Use `User.scope("withPassword")` only
 * in the auth flow where the hash is needed for bcrypt comparison.
 */
@DefaultScope(() => ({ attributes: { exclude: ["passwordHash", "passwordResetTokenHash"] } }))
@Scopes(() => ({ withPassword: { attributes: { include: ["passwordHash"] } } }))
@Table({ tableName: "users", paranoid: true, timestamps: true })
export class User extends Model<User> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @AllowNull(false)
  @Column(DataType.STRING(120))
  declare name: string;

  @AllowNull(false)
  @Unique
  @Column(DataType.STRING(180))
  declare email: string;

  @Unique
  @Column(DataType.STRING(32))
  declare phone: string | null;

  @AllowNull(false)
  @Column(DataType.STRING(255))
  declare passwordHash: string;

  /**
   * Legacy flat role. Retained as a temporary compatibility shim during the RBAC
   * migration (kept in sync with `roleId`) and removed once every module is
   * migrated. New authorization derives from `roleId` → RBAC permissions.
   */
  @AllowNull(false)
  @Default(Role.CUSTOMER)
  @Column(DataType.ENUM(...Object.values(Role)))
  declare role: Role;

  /**
   * RBAC role — the source of truth for authorization. Nullable during migration
   * (backfilled from `role`); a user's permissions are this role's permissions.
   */
  @ForeignKey(() => RbacRole)
  @Column(DataType.UUID)
  declare roleId: string | null;

  @BelongsTo(() => RbacRole) declare rbacRole?: RbacRole;

  @ForeignKey(() => Shop)
  @Column(DataType.UUID)
  declare shopId: string | null;

  @BelongsTo(() => Shop) declare shop?: Shop;

  @Column(DataType.STRING(300))
  declare avatarUrl: string | null;

  @Column(DataType.DATEONLY)
  declare dateOfBirth: string | null;

  @Column(DataType.STRING(16))
  declare gender: string | null;

  @Default(true)
  @Column(DataType.BOOLEAN)
  declare isActive: boolean;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare emailVerified: boolean;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare phoneVerified: boolean;

  /**
   * Bumped to invalidate every previously-issued JWT for this user
   * (logout-all / password change / admin force-revoke). The value is embedded
   * in the token as `tv` and re-checked on every request by JwtStrategy.
   */
  @AllowNull(false)
  @Default(0)
  @Column(DataType.INTEGER)
  declare tokenVersion: number;

  @AllowNull(true)
  @Default({})
  @Column(DataType.JSONB)
  declare notificationPrefs: any | null;

  // Password reset: SHA-256 hash of the emailed token (raw token never stored)
  // and its short-lived expiry. Cleared on successful reset (single use).
  @AllowNull(true)
  @Column(DataType.STRING(255))
  declare passwordResetTokenHash: string | null;

  @AllowNull(true)
  @Column(DataType.DATE)
  declare passwordResetExpiresAt: Date | null;

  /**
   * Keeps `roleId` in sync with the legacy `role` enum during the RBAC migration:
   * when a user is created, or their enum role changes, resolve the matching RBAC
   * role by key. A directly-assigned custom role (roleId set, enum unchanged) is
   * left untouched — roleId is the source of truth and must win.
   */
  @BeforeCreate
  @BeforeUpdate
  static async syncRbacRole(user: User) {
    // An explicit roleId assignment (RBAC role picked directly, incl. custom roles
    // whose key has no matching enum) is authoritative — never re-derive over it.
    if (user.changed("roleId")) return;
    if (user.changed("role") || !user.roleId) {
      const role = await RbacRole.findOne({ where: { key: String(user.role) }, attributes: ["id"] });
      if (role) user.roleId = role.id;
    }
  }

  @HasMany(() => UserAddress, { as: "addresses" }) declare addresses?: UserAddress[];
  @HasMany(() => UserPaymentMethod, { as: "paymentMethods" }) declare paymentMethods?: UserPaymentMethod[];
  @HasMany(() => UserSession, { as: "sessions" }) declare sessions?: UserSession[];
  @HasMany(() => Order, { as: "orders" }) declare orders?: Order[];
}
