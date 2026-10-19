import { Table, Column, Model, DataType, ForeignKey, PrimaryKey } from "sequelize-typescript";
import { Role } from "./role.model";
import { Permission } from "./permission.model";

/**
 * Join table for the role↔permission many-to-many. Composite primary key
 * (roleId, permissionId) makes an assignment unique and re-insert idempotent.
 * FKs cascade so deleting a role or permission cleans up its assignments.
 */
@Table({ tableName: "role_permissions", timestamps: false })
export class RolePermission extends Model<RolePermission> {
  @PrimaryKey
  @ForeignKey(() => Role)
  @Column(DataType.UUID)
  declare roleId: string;

  @PrimaryKey
  @ForeignKey(() => Permission)
  @Column(DataType.UUID)
  declare permissionId: string;
}
