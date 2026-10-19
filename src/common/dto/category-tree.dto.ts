export interface CategoryTreeDto {
  id: string;
  name: string;
  slug: string;
  parentId?: string | null;
  level: number;
  path: string;
  sortOrder: number;
  isActive: boolean;
  imageUrl?: string;
  icon?: string;
  productCount?: number;
  children?: CategoryTreeDto[];
}
