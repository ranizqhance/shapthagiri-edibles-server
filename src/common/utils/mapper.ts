// src/common/utils/mapper.ts
import { Category } from "@/models";
import { CategoryTreeDto } from "../dto/category-tree.dto";

/** Convert a Category model (with nested children) into a plain DTO suitable for caching */
export function toCategoryTreeDto(cat: Category): CategoryTreeDto {
  const { id, name, slug, parentId, level, path, sortOrder, isActive, imageUrl, icon, children } = cat;
  return {
    id,
    name,
    slug,
    parentId,
    level,
    path,
    sortOrder,
    isActive,
    imageUrl,
    icon,
    productCount: Number((cat as any).getDataValue('productCount')) || 0,
    children: children?.map(toCategoryTreeDto),
  };
}
