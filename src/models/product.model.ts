import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, ForeignKey, BelongsTo, HasMany, BeforeValidate } from "sequelize-typescript";
import { Category } from "./category.model";
import { Brand } from "./brand.model";
import { ProductVariant } from "./product-variant.model";
import { ProductMedia } from "./product-media.model";
import { generateUniqueSlug } from "../common/utils/slug.util";

@Table({ tableName: "products", paranoid: true, timestamps: true, indexes: [{ name: "idx_products_category", fields: ["categoryId"] }, { name: "idx_products_brand", fields: ["brandId"] }, { name: "idx_products_status", fields: ["status"] }, { name: "idx_products_slug", fields: ["slug"] }] })
export class Product extends Model<Product> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @AllowNull(false)
  @Column(DataType.STRING(220))
  declare title: string;

  @AllowNull(false)
  @Column(DataType.STRING(240))
  declare slug: string;

  @ForeignKey(() => Brand)
  @Column(DataType.UUID)
  declare brandId: string | null;

  @ForeignKey(() => Category)
  @Column(DataType.UUID)
  declare categoryId: string | null;

  @Column(DataType.TEXT)
  declare description: string | null;

  @Column(DataType.STRING(255))
  declare subtitle: string | null;

  @Column(DataType.JSONB)
  declare specifications: Record<string, unknown> | null;

  @Default("draft")
  @Column(DataType.ENUM("draft", "approved", "published", "archived"))
  declare status: "draft" | "approved" | "published" | "archived";

  @Column(DataType.UUID)
  declare submittedBy: string | null;

  @BelongsTo(() => Category) declare category?: Category;
  @BelongsTo(() => Brand) declare brand?: Brand;
  @HasMany(() => ProductVariant) declare variants?: ProductVariant[];
  @HasMany(() => ProductMedia) declare media?: ProductMedia[];

  @BeforeValidate
  static async generateSlugHook(instance: Product) {
    if (instance.isNewRecord || instance.changed("title")) {
      instance.slug = await generateUniqueSlug(Product, instance.title, instance.id);
    }
  }
}
