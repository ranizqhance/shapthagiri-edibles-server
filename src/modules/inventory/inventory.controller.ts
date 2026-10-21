import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectModel } from "@nestjs/sequelize";
import { Op, Sequelize } from "sequelize";
import { Category, Product, ProductVariant, ShopInventory, StockMovement, Shop, User } from "@/models";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { RequirePermissions } from "@/common/decorators/permissions.decorator";
import { Role } from "@/common/enums/role.enum";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { BadRequestException, ForbiddenException, NotFoundException } from "@/common/errors/http";
import { OutOfStockException } from "@/common/errors/domain";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate } from "@/common/utils/crud.util";
import { InventoryBulkDto, InventoryTransferDto, InventoryUpdateDto, ScanDto } from "@/common/dto/common.dto";
import { StockTransferService } from "./stock-transfer.service";
import { Response } from "express";
import { Res } from "@nestjs/common";
import { NotificationQueueService } from "../notifications/notification.queue";
import { NotificationEventType } from "@/common/enums/notification-event.enum";
import { CacheService } from "@/services/cache.service";

@ApiTags("Inventory")
@ApiBearerAuth()
@RequirePermissions('inventory.view')
@Controller("inventory")
export class InventoryController {
  constructor(
    @InjectModel(ShopInventory) private inv: typeof ShopInventory,
    @InjectModel(StockMovement) private mov: typeof StockMovement,
    @InjectModel(ProductVariant) private variant: typeof ProductVariant,
    @InjectModel(Product) private product: typeof Product,
    @InjectModel(Category) private category: typeof Category,
    @InjectModel(Shop) private shopModel: typeof Shop,
    @InjectModel(User) private userModel: typeof User,
    private notificationQueue: NotificationQueueService,
    private eventEmitter: EventEmitter2,
    private stockTransfer: StockTransferService,
    private cacheService: CacheService,
  ) {}

  private guardScope(u: JwtPayload, shopId: string) {
    if (u.role === Role.SHOP_MANAGER && u.shopId !== shopId) throw new ForbiddenException("AUTH_FORBIDDEN");
  }

  private variantInclude(productWhere?: Record<string, unknown>, paranoid = true, forceRequired = false) {
    const productInclude: Record<string, unknown> = {
      model: this.product,
      as: "product",
      attributes: ["id", "title", "slug", "categoryId"],
      paranoid,
      include: [{
        model: this.category,
        as: "category",
        attributes: ["id", "name", "slug"],
      }],
    };
    if (productWhere && Object.keys(productWhere).length > 0) {
      productInclude.where = productWhere;
      productInclude.required = true;
    } else if (forceRequired) {
      productInclude.required = true;
    }

    return {
      model: this.variant,
      as: "variant",
      attributes: ["id", "sku", "defaultPrice", "mrp", "attributes"],
      required: forceRequired || !!(productWhere && Object.keys(productWhere).length > 0),
      paranoid,
      include: [productInclude],
    };
  }

  private buildInventoryWhere(shopId: string, status?: string) {
    const where: any = { shopId };

    if (status === "out") {
      where.quantity = { [Op.lte]: 0 };
    } else if (status === "low") {
      where[Op.and] = [
        { quantity: { [Op.gt]: 0 } },
        Sequelize.where(Sequelize.col("quantity"), Op.lte, Sequelize.col("lowStockThreshold")),
      ];
    } else if (status === "active") {
      where.isActive = true;
    }

    return where;
  }

  private flattenInventoryRow(row: ShopInventory) {
    const plain = row.get({ plain: true }) as Record<string, any>;
    const variant = plain.variant ?? plain.ProductVariant;
    const product = variant?.product ?? variant?.Product;
    const cat = product?.category ?? product?.Category;
    return {
      id: plain.id,
      shopId: plain.shopId,
      variantId: plain.variantId,
      quantity: plain.quantity,
      priceOverride: plain.priceOverride,
      lowStockThreshold: plain.lowStockThreshold,
      isActive: plain.isActive,
      sku: variant?.sku ?? null,
      title: product?.title ?? null,
      slug: product?.slug ?? null,
      categoryId: product?.categoryId ?? cat?.id ?? null,
      category: cat?.name ?? null,
      defaultPrice: variant?.defaultPrice ?? null,
      mrp: variant?.mrp ?? null,
      // The variant's own descriptor (e.g. { size: "Large" }). Already
      // selected by variantInclude but previously dropped here, so callers had no
      // way to tell two variants of the same product apart.
      variantAttributes: variant?.attributes ?? null,
    };
  }

  private flattenMovementRow(row: StockMovement) {
    const plain = row.get({ plain: true }) as Record<string, any>;
    const variant = plain.variant ?? plain.ProductVariant;
    const product = variant?.product ?? variant?.Product;
    const cat = product?.category ?? product?.Category;
    return {
      id: plain.id,
      shopId: plain.shopId,
      shopName: plain.shop?.name ?? null,
      variantId: plain.variantId,
      quantity: plain.quantity,
      reason: plain.reason,
      direction: plain.type,
      timestamp: plain.createdAt,
      referenceType: plain.referenceType ?? null,
      referenceId: plain.referenceId ?? null,
      createdBy: plain.creator?.name ?? plain.creator?.email ?? plain.createdBy ?? null,
      sku: variant?.sku ?? null,
      title: product?.title ?? null,
      categoryId: product?.categoryId ?? cat?.id ?? null,
      category: cat?.name ?? null,
    };
  }

  @Get("shops/:shopId")
  async list(
    @CurrentUser() u: JwtPayload,
    @Param("shopId") shopId: string,
    @Query() opts: PageOptionsDto,
    @Query("status") status?: string,
    @Query("category") category?: string,
  ) {
    this.guardScope(u, shopId);

    const productWhere: Record<string, unknown> = {};
    if (category) productWhere.categoryId = category;

    const where = this.buildInventoryWhere(shopId, status);

    // Free-text search matches the product NAME or the variant SKU. Resolving the
    // matching variant ids first keeps it a simple `variantId IN (...)` filter —
    // an OR spanning the variant and its joined product cannot be expressed in the
    // include's where clause without breaking paginate's counting.
    if (opts.q) {
      const term = `%${opts.q}%`;
      const [bySku, byTitle] = await Promise.all([
        this.variant.findAll({ attributes: ["id"], where: { sku: { [Op.iLike]: term } }, raw: true }),
        this.variant.findAll({
          attributes: ["id"],
          include: [{ model: this.product, as: "product", attributes: [], required: true, where: { title: { [Op.iLike]: term } } }],
          raw: true,
        }),
      ]);
      const ids = Array.from(new Set([...bySku, ...byTitle].map((v: any) => v.id)));
      // An impossible id yields a correctly-shaped empty page when nothing matches.
      where.variantId = { [Op.in]: ids.length ? ids : ["00000000-0000-0000-0000-000000000000"] };
    }

    const result = await paginate(
      this.inv,
      opts,
      where,
      [this.variantInclude(Object.keys(productWhere).length > 0 ? productWhere : undefined, true, true)],
    );
    return { items: result.items.map((row) => this.flattenInventoryRow(row as ShopInventory)), meta: result.meta };
  }

  @RequirePermissions('inventory.edit')
  @Patch("shops/:shopId/variants/:variantId")
  async update(@CurrentUser() u: JwtPayload, @Param("shopId") shopId: string, @Param("variantId") variantId: string, @Body() body: InventoryUpdateDto) {
    this.guardScope(u, shopId);
    const [row] = await this.inv.findOrCreate({ where: { shopId, variantId }, defaults: { shopId, variantId, quantity: 0 } as any });
    const prev = row.quantity;
    const prevActive = row.isActive;
    await row.update(body as any);

    /*
     * "Active for sale" is the switch that puts an item on or off the
     * storefront, so flipping it has to drop the cached rails and category
     * counts — otherwise the change sat behind a five-minute TTL and looked
     * like it had done nothing. Quantity changes invalidate too: the figure
     * reaches the card through the same cached payloads.
     */
    this.cacheService.invalidateStorefront();

    // Deactivation left no trace at all — the movement below is gated on a
    // quantity change. Taking an item off sale is exactly the kind of thing
    // someone later asks who did, and when.
    if (body.isActive !== undefined && body.isActive !== prevActive) {
      await this.mov.create({
        shopId,
        variantId,
        type: "ADJUSTMENT",
        quantity: 0,
        reason: body.isActive ? "Listed for sale" : "Withdrawn from sale",
        referenceType: "MANUAL",
        referenceId: `MANUAL_ACTIVE_${Date.now()}`,
        createdBy: u.sub,
      } as any);
    }

    if (body.quantity !== undefined && body.quantity !== prev) {
      await this.mov.create({
        shopId,
        variantId,
        type: "ADJUSTMENT",
        // signed: + received, − removed (the absolute value hid which way stock moved)
        quantity: body.quantity - prev,
        reason: body.quantity > prev ? "Manual Restock (Increase)" : "Manual Shrinkage/Correction (Decrease)",
        referenceType: "MANUAL",
        referenceId: `MANUAL_UPDATE_${Date.now()}`,
        createdBy: u.sub,
      } as any);


      this.eventEmitter.emit("admin.notify", {
        eventType: NotificationEventType.INVENTORY_ADJUSTMENT,
        variables: { variantId, quantity: body.quantity, previous: prev, shopId }
      });
      const managers = await this.userModel.findAll({ where: { role: Role.SHOP_MANAGER, shopId } });
      for (const m of managers) {
        await this.notificationQueue.enqueue(m.id, NotificationEventType.INVENTORY_ADJUSTMENT, { variantId, quantity: body.quantity, previous: prev });
      }

      // --- Trigger Notifications ---
      if (body.quantity <= row.lowStockThreshold) {
        const eventType = body.quantity === 0 ? NotificationEventType.OUT_OF_STOCK : NotificationEventType.LOW_STOCK;
        const shop = await this.shopModel.findByPk(shopId);
        
        // Notify Shop Manager
        for (const m of managers) {
          await this.notificationQueue.enqueue(m.id, eventType, { 
            productId: variantId, 
            shopId, 
            shopName: shop?.name || "your shop",
            quantity: body.quantity,
            threshold: row.lowStockThreshold
          });
        }
        
        // Notify Admins
        this.eventEmitter.emit("admin.notify", {
          eventType,
          variables: { 
            productId: variantId, 
            shopId, 
            shopName: shop?.name || "a shop",
            quantity: body.quantity,
            threshold: row.lowStockThreshold
          }
        });
      }
      
      return { success: true, updated: row.quantity };
    }
    return { success: true, updated: prev };
  }

  @RequirePermissions('inventory.adjust')
  @Post("bulk-import")
  async bulkImport(@CurrentUser() u: JwtPayload) {
    // Mock bulk import
    this.eventEmitter.emit("admin.notify", {
      eventType: NotificationEventType.BULK_STOCK_IMPORT_COMPLETED,
      variables: { totalItems: 100 }
    });
    return { success: true };
  }

  /**
   * Inter-shop stock transfer. Previously a mock that emitted notifications and
   * reported success while moving no stock at all; it now runs the same
   * transactional StockTransferService as POST /shops/transfer. Accepts the
   * legacy fromShopId/toShopId names as well as the canonical ones.
   *
   * A shop manager may only move stock OUT of their own shop.
   */
  @RequirePermissions('inventory.adjust')
  @Post("transfer")
  async transferStock(@CurrentUser() u: JwtPayload, @Body() body: InventoryTransferDto) {
    const sourceShopId = body.sourceShopId ?? body.fromShopId!;
    const destinationShopId = body.destinationShopId ?? body.toShopId!;
    if (!sourceShopId || !destinationShopId) {
      throw new BadRequestException("VALIDATION_FAILED", "sourceShopId and destinationShopId are required");
    }
    this.guardScope(u, sourceShopId);
    const result = await this.stockTransfer.transfer(u.sub, {
      sourceShopId, destinationShopId,
      variantId: body.variantId,
      quantity: body.quantity,
      reason: body.reason,
    });
    // A transfer moves units between shops, which changes what each shop can
    // sell — the storefront has to be told.
    this.cacheService.invalidateStorefront();
    return result;
  }

  @RequirePermissions('inventory.adjust')
  @Post("shops/:shopId/bulk-update")
  async bulk(@CurrentUser() u: JwtPayload, @Param("shopId") shopId: string, @Body() body: InventoryBulkDto) {
    this.guardScope(u, shopId);

    // Resolve SKUs to variantIds
    const skus = body.items.map(it => it.sku).filter((sku): sku is string => !!sku);
    const variants = skus.length > 0 ? await this.variant.findAll({ where: { sku: skus } }) : [];
    const skuMap = new Map(variants.map(v => [v.sku, v.id]));

    let updatedCount = 0;
    await this.mov.sequelize?.transaction(async (t) => {
      for (const it of body.items) {
        const variantId = it.variantId || (it.sku ? skuMap.get(it.sku) : undefined);
        if (!variantId) continue;

        const [invItem, created] = await this.inv.findOrCreate({
          where: { shopId, variantId },
          defaults: { shopId, variantId, quantity: 0 } as any,
          transaction: t
        });

        const prev = invItem.quantity;
        await invItem.update({
          quantity: it.quantity,
          priceOverride: it.priceOverride,
        } as any, { transaction: t });

        if (it.quantity !== prev) {
          await this.mov.create({
            shopId,
            variantId,
            type: "BULK_IMPORT",
            quantity: it.quantity - prev, // signed, like ADJUSTMENT
            reason: "Bulk CSV import adjustment",
            referenceType: "BULK",
            referenceId: "CSV_IMPORT",
            createdBy: u.sub,
          } as any, { transaction: t });
        }

        updatedCount++;
      }
    });

    // Same reason as the single-item PATCH: these quantities reach the
    // storefront through cached payloads. Leaving the bulk path out would make
    // a CSV import behave differently from editing one row by hand.
    this.cacheService.invalidateStorefront();

    return { updated: updatedCount };
  }

  @Get("movements")
  async movements(
    @CurrentUser() u: JwtPayload,
    @Query() opts: PageOptionsDto,
    @Query("shopId") shopId?: string,
    @Query("type") type?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const where: any = {};
    if (u.role === Role.SHOP_MANAGER) {
      where.shopId = u.shopId;
    } else if (shopId) {
      where.shopId = shopId;
    }

    if (type && type !== "ALL") {
      where.type = type;
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        where.createdAt[Op.gte] = new Date(startDate);
      }
      if (endDate) {
        where.createdAt[Op.lte] = new Date(endDate);
      }
    }

    const includes: any[] = [
      this.variantInclude(undefined, false, true),
      {
        model: this.shopModel,
        as: "shop",
        attributes: ["id", "name"]
      },
      {
        model: this.userModel,
        as: "creator",
        attributes: ["id", "name", "email"],
        constraints: false
      }
    ];

    if (opts.q) {
      const qLower = `%${opts.q.toLowerCase()}%`;
      where[Op.or] = [
        { referenceId: { [Op.iLike]: qLower } },
        Sequelize.literal(`LOWER("variant"."sku") LIKE ${this.mov.sequelize?.escape(qLower)}`),
        Sequelize.literal(`LOWER("variant->product"."title") LIKE ${this.mov.sequelize?.escape(qLower)}`),
      ];
    }

    const result = await paginate(this.mov, opts, where, includes, [['createdAt', 'DESC']]);
    return { items: result.items.map((row) => this.flattenMovementRow(row as StockMovement)), meta: result.meta };
  }

  @RequirePermissions('inventory.export')
  @Get("movements/export")
  async exportMovements(
    @CurrentUser() u: JwtPayload,
    @Res() res: Response,
    @Query("shopId") shopId?: string,
    @Query("type") type?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("q") q?: string,
  ) {
    const where: any = {};
    if (u.role === Role.SHOP_MANAGER) {
      where.shopId = u.shopId;
    } else if (shopId) {
      where.shopId = shopId;
    }

    if (type && type !== "ALL") {
      where.type = type;
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        where.createdAt[Op.gte] = new Date(startDate);
      }
      if (endDate) {
        where.createdAt[Op.lte] = new Date(endDate);
      }
    }

    const includes: any[] = [
      this.variantInclude(undefined, false, true),
      {
        model: this.shopModel,
        as: "shop",
        attributes: ["id", "name"]
      },
      {
        model: this.userModel,
        as: "creator",
        attributes: ["id", "name", "email"],
        constraints: false
      }
    ];

    if (q) {
      const qLower = `%${q.toLowerCase()}%`;
      where[Op.or] = [
        { referenceId: { [Op.iLike]: qLower } },
        Sequelize.literal(`LOWER("variant"."sku") LIKE ${this.mov.sequelize?.escape(qLower)}`),
        Sequelize.literal(`LOWER("variant->product"."title") LIKE ${this.mov.sequelize?.escape(qLower)}`),
      ];
    }

    /*
     * Capped.
     *
     * `stock_movements` is append-only and grows with every adjustment, sale
     * and transfer, and this had no `limit` at all — one request loaded the
     * entire history, with three includes, into memory before writing a byte.
     * 50,000 rows is a generous export and a bounded one; anything larger is
     * a reporting job, not an HTTP response.
     */
    const EXPORT_MAX_ROWS = 50_000;
    const movements = await this.mov.findAll({
      where,
      include: includes,
      order: [['createdAt', 'DESC']],
      limit: EXPORT_MAX_ROWS,
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=stock-movements-${Date.now()}.csv`);

    // Write header
    res.write("Timestamp,SKU,Product Title,Shop Name,Type,Quantity,Reason,Reference Type,Reference ID,Performed By\n");

    for (const mov of movements) {
      const row = this.flattenMovementRow(mov);
      // A leading = + - or @ is executed as a formula by Excel and Sheets.
      // `reason` and the reference fields are operator-supplied text.
      const guard = (v: unknown) => {
        const text = String(v ?? "");
        return /^[=+\-@]/.test(text) ? "'" + text : text;
      };
      const sku = guard(row.sku).replace(/"/g, '""');
      const title = guard(row.title).replace(/"/g, '""');
      const shopName = guard(row.shopName).replace(/"/g, '""');
      const reason = guard(row.reason).replace(/"/g, '""');
      const refType = guard(row.referenceType).replace(/"/g, '""');
      const refId = guard(row.referenceId).replace(/"/g, '""');
      const createdBy = guard(row.createdBy).replace(/"/g, '""');

      res.write(`"${row.timestamp}","${sku}","${title}","${shopName}","${row.direction}",${row.quantity},"${reason}","${refType}","${refId}","${createdBy}"\n`);
    }

    res.end();
  }

  /**
   * Barcode scan — applies a real stock movement to the scanning manager's shop.
   * `direction` is IN (receive) or OUT (dispatch/shrinkage); ADJUSTMENT sets a delta.
   */
  @RequirePermissions('inventory.adjust')
  @Post("scan")
  async scan(@CurrentUser() u: JwtPayload, @Body() body: ScanDto) {
    const shopId = u.shopId;
    if (!shopId) throw new ForbiddenException("AUTH_FORBIDDEN", "Scanning is scoped to a shop manager's shop");

    const variant = await this.variant.findOne({ where: { barcode: body.barcode } });
    if (!variant) throw new NotFoundException("NOT_FOUND", "No variant matches this barcode");

    const qty = body.quantity ?? 1;
    const dir = body.direction.toUpperCase();
    // One transaction, and the movement is a SCAN with a signed quantity. The
    // type used to be written as "IN"/"OUT", which the movement-type enum does
    // not allow — every scan failed with a 500 after the stock had already moved.
    const row = await this.inv.sequelize!.transaction(async (t) => {
      const [r] = await this.inv.findOrCreate({ where: { shopId, variantId: variant.id }, defaults: { shopId, variantId: variant.id, quantity: 0 } as any, transaction: t });
      await r.reload({ lock: t.LOCK.UPDATE, transaction: t });
      if (dir === "OUT") {
        if (r.quantity < qty) throw new OutOfStockException({ variantId: variant.id, shopId });
        await r.decrement("quantity", { by: qty, transaction: t });
      } else {
        await r.increment("quantity", { by: qty, transaction: t });
      }
      await this.mov.create({ shopId, variantId: variant.id, type: "SCAN", quantity: dir === "OUT" ? -qty : qty, reason: `scan ${dir.toLowerCase()}`, createdBy: u.sub } as any, { transaction: t });
      return r;
    });
    await row.reload();
    this.cacheService.invalidateStorefront();
    return { variantId: variant.id, sku: variant.sku, shopId, direction: dir, quantity: row.quantity };
  }
}
