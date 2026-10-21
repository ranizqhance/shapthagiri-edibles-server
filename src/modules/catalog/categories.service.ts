// src/modules/catalog/categories.service.ts
import { Injectable } from '@nestjs/common';
import { ConflictException, NotFoundException, BadRequestException } from '@/common/errors/http';
import { InjectModel } from '@nestjs/sequelize';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize, Transaction, Op } from 'sequelize';
import { Category } from '@/models';
import { CreateCategoryDto, UpdateCategoryDto } from '@/common/dto/common.dto';
import { storageProvider } from '@/common/providers/storage.provider';
import { sellableAnywhereSql } from "./availability";

@Injectable()
export class CategoriesService {
  constructor(
    @InjectModel(Category) private categoryModel: typeof Category,
    @InjectConnection() private sequelize: Sequelize,
  ) {}

  /** Helper to compute level & path */
  private async computeHierarchy(parentId: string | null, transaction: Transaction) {
    if (!parentId) {
      return { level: 0, path: '' }; // will be set to its own id after creation
    }
    const parent = await this.categoryModel.findByPk(parentId, { transaction });
    if (!parent) throw new BadRequestException('BAD_REQUEST', 'Parent category not found');
    // Use the parent's existing path; do not duplicate the parent ID.
    const parentPath = parent.path ? parent.path : `${parent.id}`;
    return { level: parent.level + 1, path: parentPath };
  }

  /**
   * Guards against duplicate (parentId, name) among non-deleted rows.
   * This provides a clean, user-friendly error before the DB constraint fires.
   * It is paranoid-aware: soft-deleted rows with the same name are NOT a conflict.
   *
   * @param name     The category name to check.
   * @param parentId The parent category ID (or null for root).
   * @param excludeId Optional: the ID of the row being updated (to ignore itself).
   * @param transaction Active transaction.
   */
  private async assertNameUnique(
    name: string,
    parentId: string | null,
    excludeId: string | null,
    transaction: Transaction,
  ): Promise<void> {
    const where: any = { name };
    // parentId null means root-level: match WHERE "parentId" IS NULL
    if (parentId) {
      where.parentId = parentId;
    } else {
      where.parentId = null;
    }
    if (excludeId) {
      where.id = { [Op.ne]: excludeId };
    }
    // paranoid: true (default) means deletedAt IS NULL – only active rows
    const count = await this.categoryModel.count({ where, transaction });
    if (count > 0) {
      throw new ConflictException(
        'CATEGORY_DUPLICATE_NAME',
        `A category named "${name}" already exists under this parent.`,
      );
    }
  }

  async create(dto: CreateCategoryDto) {
    return await this.sequelize.transaction(async (t) => {
      // Guard: ensure no active sibling already has this name
      await this.assertNameUnique(dto.name, dto.parentId ?? null, null, t);

      const { level, path } = await this.computeHierarchy(dto.parentId ?? null, t);
      // create the category first to get its id
        const cat = await this.categoryModel.create(
          { ...(dto as any), level, path: '' } as any, // temporary path, will update after id is known
          { transaction: t },
        );
      // now set correct path (including its own id)
      const finalPath = path ? `${path}/${cat.id}` : cat.id;
      await cat.update({ path: finalPath }, { transaction: t });
      return cat;
    });
  }

  /**
   * SQL fragment counting the products in a category's subtree.
   *
   * With a shopId it counts only PUBLISHED products that the serving shop has
   * active, in-stock inventory for — so a category card can never advertise
   * products the customer's shop cannot deliver. Without one it keeps the
   * original global count, which is what the admin catalog tree expects.
   * `shopId` is validated as a UUID by the caller before it reaches here.
   */
  private productCountLiteral(shopId?: string) {
    // Always storefront-scoped. Every consumer of `productCount` is a shopper
    // surface — the categories page, its banner and sidebar, the home accordion
    // and the filter drawer — so a count that included drafts and switched-off
    // products was advertising items a shopper could not reach. The admin
    // catalog tree reads the same endpoint but renders no count.
    const visible = `AND p.status = 'published' AND ${sellableAnywhereSql("p.id")}`;
    const scoped = shopId
      ? `AND EXISTS (
           SELECT 1 FROM product_variants v
           JOIN shop_inventory si2 ON si2."variantId" = v.id
           WHERE v."productId" = p.id
             AND si2."shopId" = '${shopId}'
             AND si2."isActive" = true
             AND si2.quantity > 0
         )`
      : "";
    // Count only products DIRECTLY assigned to this category — a product listed
    // under a sub-category such as "Roasted Coconut Oil" must not also inflate the count
    // of its parent ("Coconut Oil"). No subtree/descendant rollup.
    return this.sequelize.literal(`(
      SELECT CAST(COUNT(p.id) AS INTEGER)
      FROM products p
      JOIN categories c2 ON p."categoryId" = c2.id
      WHERE c2.id = "Category".id
        AND p."deletedAt" IS NULL
        AND c2."deletedAt" IS NULL
        ${visible}
        ${scoped}
    )`);
  }

  async findTree(q?: string, page?: number, limit?: number, shopId?: string) {
    const qTrimmed = q?.trim();
    
    // Safely parse page and limit to handle NaN
    const p = Number(page);
    const l = Number(limit);
    const usePagination = !isNaN(p) && !isNaN(l) && p > 0 && l > 0;
    
    const offset = usePagination ? (p - 1) * l : undefined;
    const limitOpt = usePagination ? l : undefined;

    if (!qTrimmed) {
      // Return all categories as a flat array sorted by level and sortOrder.
      // The frontend's `buildTree` algorithm constructs the nested tree natively.
      return await this.categoryModel.findAll({
        order: [['level', 'ASC'], ['sortOrder', 'ASC']],
        limit: limitOpt,
        offset,
        attributes: {
          include: [[this.productCountLiteral(shopId), 'productCount']]
        }
      });
    }

    // Process search
    const matches = await this.categoryModel.findAll({
      where: {
        [Op.or]: [
          { name: { [Op.iLike]: `%${qTrimmed}%` } },
          { slug: { [Op.iLike]: `%${qTrimmed}%` } }
        ]
      },
      limit: limitOpt,
      offset,
    });

    if (matches.length === 0) return [];

    const allIds = new Set<string>();
    for (const match of matches) {
      if (match.path) {
        match.path.split('/').forEach(id => allIds.add(id));
      } else {
        allIds.add(match.id);
      }
    }

    return await this.categoryModel.findAll({
      where: { id: Array.from(allIds) },
      order: [['level', 'ASC'], ['sortOrder', 'ASC']],
      attributes: {
        include: [[this.productCountLiteral(shopId), 'productCount']]
      }
    });
  }

  async findOne(id: string) {
    const cat = await this.categoryModel.findByPk(id, { include: [{ model: Category, as: 'children' }] });
    if (!cat) throw new NotFoundException('NOT_FOUND', 'Category not found');
    // breadcrumb: split path and fetch ancestors
    const ids = cat.path ? cat.path.split('/') : [];
    const ancestors = await this.categoryModel.findAll({ where: { id: ids } });
    return { category: cat, breadcrumb: ancestors };
  }

  async update(id: string, dto: UpdateCategoryDto) {
    return await this.sequelize.transaction(async (t) => {
      const cat = await this.categoryModel.findByPk(id, { transaction: t });
      if (!cat) throw new NotFoundException('NOT_FOUND', 'Category not found');

      // Determine the effective parentId for uniqueness check (after move or existing)
      const effectiveParentId =
        dto.parentId !== undefined ? (dto.parentId ?? null) : cat.parentId;

      // Guard: if the name is changing, ensure no active sibling already has it
      if (dto.name !== undefined && dto.name !== cat.name) {
        await this.assertNameUnique(dto.name, effectiveParentId, id, t);
      }

      // if parent changes, recompute hierarchy
      if (dto.parentId !== undefined && dto.parentId !== cat.parentId) {
        // prevent circular reference
        if (dto.parentId) {
          const newParent = await this.categoryModel.findByPk(dto.parentId, { transaction: t });
          if (!newParent) throw new BadRequestException('BAD_REQUEST', 'New parent not found');
          if (newParent.path.includes(cat.id))
            throw new ConflictException('CATEGORY_CIRCULAR_PARENT', 'Circular parent relationship detected');
        }
        // Also guard duplicate name in the NEW parent scope (if name not being changed)
        if (dto.name === undefined || dto.name === cat.name) {
          await this.assertNameUnique(cat.name, dto.parentId ?? null, id, t);
        }
        const { level, path } = await this.computeHierarchy(dto.parentId ?? null, t);
        await cat.update({ parentId: dto.parentId, level, path: '' }, { transaction: t });
        const finalPath = path ? `${path}/${cat.id}` : cat.id;
        await cat.update({ path: finalPath }, { transaction: t });
        // update descendants' level & path
        await this.updateDescendants(cat.id, level, finalPath, t);
      }

      // other fields (name, slug, icon, imageUrl, sortOrder, isActive)
      if (dto.imageUrl !== undefined && dto.imageUrl !== cat.imageUrl) {
        if (cat.imageUrl) {
          storageProvider.deleteFile(cat.imageUrl).catch(console.error);
        }
      }

      const updatable = { name: dto.name, slug: dto.slug, icon: dto.icon, imageUrl: dto.imageUrl, sortOrder: dto.sortOrder, isActive: dto.isActive };
      await cat.update(updatable, { transaction: t });
      return cat;
    });
  }

  private async updateDescendants(rootId: string, rootLevel: number, rootPath: string, transaction: Transaction) {
    const descendants = await this.categoryModel.findAll({ where: { path: { [Op.like]: `%/${rootId}%` } }, transaction });
    for (const child of descendants) {
      const relative = child.path.replace(rootPath, ''); // get part after rootPath
      const newPath = `${rootPath}${relative}`;
      const newLevel = rootLevel + (child.path.split('/').length - rootPath.split('/').length);
      await child.update({ path: newPath, level: newLevel }, { transaction });
    }
  }

  async delete(id: string, reassignCategoryId?: string) {
    return await this.sequelize.transaction(async (t) => {
      const cat = await this.categoryModel.findByPk(id, { transaction: t });
      if (!cat) throw new NotFoundException('NOT_FOUND', 'Category not found');
      
      const ids = await this.getDescendantIds(id);
      
      // check for products linked to any descendant
      const productModel = (await import('@/models')).Product; // lazy import to avoid circular deps
      const productCount = await productModel.count({ where: { categoryId: ids }, transaction: t });
      
      if (productCount > 0) {
        if (!reassignCategoryId) {
          throw new ConflictException('CATEGORY_HAS_PRODUCTS', 'Category (or its descendants) has products; provide reassignCategoryId to move them');
        }
        // reassign products
        await productModel.update({ categoryId: reassignCategoryId }, { where: { categoryId: ids }, transaction: t });
      }
      
      // delete descendants first
      await this.categoryModel.destroy({ where: { id: ids.filter(i => i !== id) }, transaction: t });
      
      if (cat.imageUrl) {
        storageProvider.deleteFile(cat.imageUrl).catch(console.error);
      }
      await cat.destroy({ transaction: t });
      return { deleted: true };
    });
  }

  /** Move a category to a new parent */
  async move(id: string, newParentId: string | null) {
    return await this.sequelize.transaction(async (t) => {
      const cat = await this.categoryModel.findByPk(id, { transaction: t });
      if (!cat) throw new NotFoundException('NOT_FOUND', 'Category not found');

      // prevent circular reference
      if (newParentId) {
        const newParent = await this.categoryModel.findByPk(newParentId, { transaction: t });
        if (!newParent) throw new BadRequestException('BAD_REQUEST', 'New parent not found');
        if (newParent.path.includes(cat.id))
          throw new ConflictException('CATEGORY_CIRCULAR_PARENT', 'Circular parent relationship detected');
      }

      const { level, path } = await this.computeHierarchy(newParentId, t);
      await cat.update({ parentId: newParentId, level, path: '' }, { transaction: t });
      const finalPath = path ? `${path}/${cat.id}` : cat.id;
      await cat.update({ path: finalPath }, { transaction: t });
      await this.updateDescendants(cat.id, level, finalPath, t);
      return cat;
    });
  }


  /** Returns all descendant IDs (including the node itself) */
  async getDescendantIds(id: string) {
    const cat = await this.categoryModel.findByPk(id);
    if (!cat) throw new NotFoundException('NOT_FOUND', 'Category not found');

    // A blank path used to make the pattern `'%'`, which matched EVERY category
    // and turned the caller's category filter into a no-op (the whole catalog came
    // back). Legacy blank paths are repaired by migration
    // 20260723090000-backfill-category-path; this guard makes the query safe even
    // if one ever reappears — fall back to the row itself.
    const basePath = cat.path && cat.path.trim() !== "" ? cat.path : null;
    if (!basePath) return [cat.id];

    const rows = await this.categoryModel.findAll({
      where: { [Op.or]: [{ path: basePath }, { path: { [Op.like]: `${basePath}/%` } }] },
      attributes: ['id'],
    });
    const ids = rows.map((r: any) => r.id);
    if (!ids.includes(cat.id)) ids.push(cat.id);
    return ids;
  }
}
