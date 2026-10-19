// src/models/category.model.ts
import {
  Table,
  Column,
  Model,
  DataType,
  Default,
  PrimaryKey,
  AllowNull,
  ForeignKey,
  BelongsTo,
  HasMany,
  Index,
  Scopes,
  BeforeValidate,
} from "sequelize-typescript";
import { Product } from "./product.model";
import { generateUniqueSlug } from "../common/utils/slug.util";

/**
 * Category model supporting unlimited nesting via a materialized‑path.
 *
 * Fields:
 *  - parentId   : self‑reference (nullable)
 *  - level      : depth from root (0‑based)
 *  - path       : '/'‑separated list of ancestor IDs ending with own ID
 *  - sortOrder  : UI ordering within siblings
 *  - isActive   : soft‑activate flag (archived categories have false)
 *  - deletedAt  : soft‑delete timestamp (handled by Sequelize `paranoid`)
 */
@Table({
  tableName: "categories",
  timestamps: true,
  paranoid: true,
})
@Scopes(() => ({
  // Helper scope to load the entire tree in one query
  tree: {
    include: [{ model: Category, as: "children", hierarchy: true }],
    order: [["sortOrder", "ASC"]],
  },
}))
export class Category extends Model<Category> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @AllowNull(false)
  @Column(DataType.STRING(120))
  declare name: string;

  @AllowNull(false)
  @Column(DataType.STRING(120))
  declare slug: string;

  // -----------------------------------------------------------------
  // Self‑referencing hierarchy fields
  // -----------------------------------------------------------------
  @ForeignKey(() => Category)
  @AllowNull(true)
  @Column(DataType.UUID)
  @Index
  declare parentId: string | null;

  @BelongsTo(() => Category, { as: "parent" })
  parent?: Category;

  @HasMany(() => Category, { as: "children", foreignKey: "parentId" })
  children?: Category[];

  @AllowNull(false)
  @Default(0)
  @Column(DataType.INTEGER)
  declare level: number; // depth from root

  @AllowNull(false)
  @Default("")
  @Column(DataType.TEXT)
  @Index
  declare path: string; // materialized path: "rootId/.../selfId"

  // -----------------------------------------------------------------
  // Additional UI/behaviour columns
  // -----------------------------------------------------------------
  @AllowNull(false)
  @Default(0)
  @Column(DataType.INTEGER)
  declare sortOrder: number;

  @AllowNull(false)
  @Default(true)
  @Column(DataType.BOOLEAN)
  declare isActive: boolean;

  @AllowNull(true)
  @Column(DataType.STRING(255))
  declare icon?: string;

  @AllowNull(true)
  @Column(DataType.STRING(255))
  declare imageUrl?: string;

  // -----------------------------------------------------------------
  // Relations
  // -----------------------------------------------------------------
  @HasMany(() => Product)
  declare products?: Product[];

  @BeforeValidate
  static async generateSlugHook(instance: Category) {
    if (instance.isNewRecord || instance.changed("name")) {
      instance.slug = await generateUniqueSlug(Category, instance.name, instance.id);
    }
  }
}
