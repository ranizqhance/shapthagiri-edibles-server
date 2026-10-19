import { Table, Column, Model, DataType, Default, PrimaryKey, AllowNull, Unique, HasMany, BeforeValidate } from "sequelize-typescript";
import { Product } from "./product.model";
import { generateUniqueSlug } from "../common/utils/slug.util";

@Table({ tableName: "brands", paranoid: true, timestamps: true })
export class Brand extends Model<Brand> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @AllowNull(false)
  @Column(DataType.STRING(120))
  declare name: string;

  @AllowNull(false)
  @Unique
  @Column(DataType.STRING(140))
  declare slug: string;

  @Column(DataType.STRING(300))
  declare logoUrl: string | null;

  @HasMany(() => Product) declare products?: Product[];

  @BeforeValidate
  static async generateSlugHook(instance: Brand) {
    if (instance.isNewRecord || instance.changed("name")) {
      instance.slug = await generateUniqueSlug(Brand, instance.name, instance.id);
    }
  }
}
