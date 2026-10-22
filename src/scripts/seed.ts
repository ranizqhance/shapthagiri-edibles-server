import "reflect-metadata";
import { sequelize } from "@/config/database";
import {
  User, Shop, Category, Brand, DeliveryZone,
  Product, ProductVariant, ProductMedia, ShopInventory,
  DeliveryPartner, LoyaltyAccount, LoyaltyTransaction, GlobalPolicy,
  Order, OrderShipment, OrderItem, OrderStatusHistory, RoutingDecision, Payment,
  Setting, FeatureFlag, AuditLog,
  ShippingCarrier, ShippingZone, ShippingRateBand,
  Role as RoleModel, Permission, RolePermission,
} from "@/models";
import { hashPassword } from "@/common/utils/password.util";
import { Role } from "@/common/enums/role.enum";
import { OrderStatus, PaymentMethod, PaymentStatus } from "@/common/enums/order-status.enum";
import {
  WILDCARD_PERMISSION, SYSTEM_ROLES, flattenCatalog, resolveGrant,
} from "@/modules/rbac/rbac.catalog";
import { logger } from "@/common/utils/logger";
import { isProd } from "@/config/env";
import { BRAND } from "@/common/brand";
import { computeLineAllocations } from "@/common/utils/order-allocation.util";

/**
 * Seeds the RBAC catalog: the wildcard permission, every permission in
 * RBAC_CATALOG, the system roles, and their grants. Must run before users are
 * created — User.syncRbacRole resolves `roleId` from the role key on insert.
 */
async function seedRbac() {
  await Permission.findOrCreate({
    where: { key: WILDCARD_PERMISSION },
    defaults: {
      key: WILDCARD_PERMISSION, module: "*", action: "*", label: "All Access",
      moduleLabel: "All Access", moduleGroup: "System", sortModule: -1, sortAction: 0, isActive: true,
    } as any,
  });

  for (const row of flattenCatalog()) {
    await Permission.findOrCreate({ where: { key: row.key }, defaults: { ...row, isActive: true } as any });
  }

  for (const def of SYSTEM_ROLES) {
    const [role] = await RoleModel.findOrCreate({
      where: { key: def.key },
      defaults: {
        key: def.key, name: def.name, description: def.description,
        isSystem: true, isActive: true,
      } as any,
    });

    const keys = resolveGrant(def.grants);
    if (!keys.length) continue;

    const perms = await Permission.findAll({ where: { key: keys } });
    for (const perm of perms) {
      await RolePermission.findOrCreate({
        where: { roleId: role.id, permissionId: perm.id },
        defaults: { roleId: role.id, permissionId: perm.id } as any,
      });
    }
  }

  const roleCount = await RoleModel.count();
  const permCount = await Permission.count();
  logger.info(`RBAC seeded — ${roleCount} roles, ${permCount} permissions`);
}

type SeedLine = { brand: "pooram" | "dhwani"; name: string; subtitle: string; description: string; specs: Record<string, string>; tags: string[] };

// The two brands, worded as on the company's own website (CONTENT.md in the old-website archive on S3).
const POORAM: SeedLine = {
  brand: "pooram",
  name: "Pooram Coconut Oil",
  subtitle: "Roasted coconut oil",
  description:
    "Pooram Coconut Oil is 100% pure and made out of superior quality Kerala coconuts. It is roasted coconut oil, which has a better aroma and taste — and, being roasted, a longer shelf life than normal coconut oil. Make your cooking a celebration.",
  specs: { Brand: "Pooram", Type: "Roasted coconut oil", "Made from": "Finest copra", "Made in": "Palakkad, Kerala" },
  tags: ["pooram", "roasted", "coconut oil"],
};
const DHWANI: SeedLine = {
  brand: "dhwani",
  name: "Dhwani Pure Coconut Oil",
  subtitle: "Pure coconut oil",
  description:
    "Dhwani Pure Coconut Oil is pure, transparent and clean — your ideal taste and health partner in the kitchen. It is also an excellent base for hair oil. The pure taste of life.",
  specs: { Brand: "Dhwani", Type: "Pure coconut oil", "Made in": "Palakkad, Kerala" },
  tags: ["dhwani", "pure", "coconut oil", "hair oil"],
};

/** The pack photos, on S3 (uploaded through the API's upload service), keyed by pack. */
const PACK_IMAGES: Record<string, string> = {
  "pooram-1ltr": "https://general-qts-public.s3.us-east-1.amazonaws.com/products/93f33248-c80c-4d94-8f47-b631988c54b6.webp",
  "pooram-500ml": "https://general-qts-public.s3.us-east-1.amazonaws.com/products/4c247253-9a54-4e79-b768-686a231619d2.webp",
  "pooram-250ml": "https://general-qts-public.s3.us-east-1.amazonaws.com/products/0e0b4055-ae79-4ec1-9b5f-50a4680555bf.webp",
  "pooram-1ltr-pet-bottle": "https://general-qts-public.s3.us-east-1.amazonaws.com/products/eb249bea-61fd-493a-ad3d-c57a7c567b54.webp",
  "pooram-500ml-pet-bottle": "https://general-qts-public.s3.us-east-1.amazonaws.com/products/826f175c-a6cc-4da2-81d0-15e9e9f0e12b.webp",
  "pooram-1ltr-hdpe-bottle": "https://general-qts-public.s3.us-east-1.amazonaws.com/products/21ddaa6b-4fc9-4b72-8657-568f25a6a550.webp",
  "pooram-500ml-hdpe-bottle": "https://general-qts-public.s3.us-east-1.amazonaws.com/products/9bec754a-bb43-42db-9d26-fec83d1d4010.webp",
  "pooram-5ltr": "https://general-qts-public.s3.us-east-1.amazonaws.com/products/0aa3c817-d695-4660-85c0-0dfd4f26f5f7.webp",
  "dhw-1ltr": "https://general-qts-public.s3.us-east-1.amazonaws.com/products/dbd0047e-73b5-498b-823b-a2da790c82c7.webp",
  "dhw-500ml": "https://general-qts-public.s3.us-east-1.amazonaws.com/products/ff1edda9-08e9-4d0b-87d7-7fec16672bf0.webp",
};

type SeedPack = {
  /** Key of the pack photo in PACK_IMAGES, and the SKU stem. */
  key: string;
  line: SeedLine;
  size: string;
  pack: string;
  /** Packed weight for courier pricing — oil at ~0.92 kg/L plus the pack. TODO: confirm. */
  kg: number;
  price: number;
  mrp: number;
};

/*
 * One product per pack: Pooram in eight packs, Dhwani in two pouches — the
 * company's real range. Titles, slugs and copy match the storefront's sample
 * catalogue (ecommerce-web/lib/demo-catalog.ts), so links keep working when
 * the shop switches from the sample to this data.
 *
 * TODO: prices are PLACEHOLDERS — the old website published none. Replace them
 * in Dashboard → Products (or here, then re-seed a fresh database).
 */
const PACKS: SeedPack[] = [
  { key: "pooram-1ltr", line: POORAM, size: "1 L", pack: "Pouch", kg: 0.95, price: 289, mrp: 320 },
  { key: "pooram-500ml", line: POORAM, size: "500 ml", pack: "Pouch", kg: 0.48, price: 149, mrp: 165 },
  { key: "pooram-250ml", line: POORAM, size: "250 ml", pack: "Pouch", kg: 0.24, price: 79, mrp: 85 },
  { key: "pooram-1ltr-pet-bottle", line: POORAM, size: "1 L", pack: "PET Bottle", kg: 1.0, price: 309, mrp: 340 },
  { key: "pooram-500ml-pet-bottle", line: POORAM, size: "500 ml", pack: "PET Bottle", kg: 0.51, price: 159, mrp: 175 },
  { key: "pooram-1ltr-hdpe-bottle", line: POORAM, size: "1 L", pack: "HDPE Bottle", kg: 1.0, price: 305, mrp: 335 },
  { key: "pooram-500ml-hdpe-bottle", line: POORAM, size: "500 ml", pack: "HDPE Bottle", kg: 0.51, price: 155, mrp: 170 },
  { key: "pooram-5ltr", line: POORAM, size: "5 L", pack: "Can", kg: 4.9, price: 1399, mrp: 1550 },
  { key: "dhw-1ltr", line: DHWANI, size: "1 L", pack: "Pouch", kg: 0.95, price: 279, mrp: 299 },
  { key: "dhw-500ml", line: DHWANI, size: "500 ml", pack: "Pouch", kg: 0.48, price: 145, mrp: 155 },
];

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const packTitle = (p: SeedPack) => `${p.line.name} ${p.size} ${p.pack}`;
const packSku = (p: SeedPack) => `SHG-${p.key.toUpperCase()}`;

/*
 * Courier rate card. Checkout prices delivery from the active carrier's card
 * (weight band × destination state) and refuses with SHIPPING_RATE_MISSING
 * when there is none, so a shop without one cannot take a single order.
 *
 * TODO: PLACEHOLDER rates — Shapthagiri has not published a tariff. Replace
 * them with the courier's card in Dashboard → Delivery Engine → Shipping rates.
 * Orders at or above `delivery.freeThreshold` ship free whatever the card says.
 */
const RATE_CARD = {
  carrier: { code: "COURIER", name: "Courier (placeholder rates)", note: "Placeholder rates seeded at setup — replace with the courier's actual tariff before launch." },
  zones: [
    { code: "KL", name: "Kerala", states: ["Kerala"], isDefault: false, perKgAboveTopBand: 20, charges: [40, 50, 70, 110, 180] },
    {
      code: "SOUTH",
      name: "South India",
      states: ["Tamil Nadu", "Karnataka", "Andhra Pradesh", "Telangana", "Puducherry", "Lakshadweep"],
      isDefault: false,
      perKgAboveTopBand: 30,
      charges: [60, 75, 100, 160, 260],
    },
    { code: "ROI", name: "Rest of India", states: [], isDefault: true, perKgAboveTopBand: 40, charges: [80, 100, 140, 220, 380] },
  ],
  /** Upper-inclusive weight bands in grams; each zone's `charges` line up with these. */
  bandsG: [
    [0, 500],
    [500, 1000],
    [1000, 2000],
    [2000, 5000],
    [5000, 10000],
  ] as Array<[number, number]>,
};

async function seedRateCard() {
  const [carrier] = await ShippingCarrier.findOrCreate({
    where: { code: RATE_CARD.carrier.code },
    defaults: { ...RATE_CARD.carrier, isActive: false } as any,
  });
  // Only one carrier may be active (partial unique index) — activate this one
  // only when nothing else already is, so re-seeding never overrides a real card.
  if (!(await ShippingCarrier.count({ where: { isActive: true } }))) await carrier.update({ isActive: true });

  for (const z of RATE_CARD.zones) {
    const [zone, created] = await ShippingZone.findOrCreate({
      where: { carrierId: carrier.id, code: z.code },
      defaults: { carrierId: carrier.id, code: z.code, name: z.name, states: z.states, isDefault: z.isDefault, perKgAboveTopBand: z.perKgAboveTopBand, isActive: true } as any,
    });
    if (!created) continue;
    for (const [i, [minG, maxG]] of RATE_CARD.bandsG.entries()) {
      await ShippingRateBand.create({ zoneId: zone.id, minG, maxG, charge: z.charges[i] } as any);
    }
  }
}

/**
 * Logins for trying the dashboard locally: admin, shop manager, customer,
 * delivery partner — each with its role name as the password. Never created in
 * production, where the passwords would be public knowledge.
 */
async function seedDemoUsers(shop: Shop) {
  const [adminPw, managerPw, customerPw, partnerPw] = await Promise.all([
    hashPassword("admin"), hashPassword("manager"), hashPassword("customer"), hashPassword("partner"),
  ]);

  const [admin] = await User.findOrCreate({
    where: { email: "admin@shapthagiri-edibles.com" },
    defaults: { name: "Shapthagiri Admin", email: "admin@shapthagiri-edibles.com", phone: "+919900000001", passwordHash: adminPw, role: Role.ADMIN, isActive: true, emailVerified: true } as any,
  });

  const [manager] = await User.findOrCreate({
    where: { email: "manager@shapthagiri-edibles.com" },
    defaults: { name: "Vannamada Unit Manager", email: "manager@shapthagiri-edibles.com", phone: "+919900000002", passwordHash: managerPw, role: Role.SHOP_MANAGER, shopId: shop.id, isActive: true, emailVerified: true } as any,
  });
  if (!manager.shopId) await manager.update({ shopId: shop.id });
  if (!shop.managerId) await shop.update({ managerId: manager.id });

  const [customer] = await User.findOrCreate({
    where: { email: "customer@shapthagiri-edibles.com" },
    defaults: { name: "Demo Customer", email: "customer@shapthagiri-edibles.com", phone: "+919900000003", passwordHash: customerPw, role: Role.CUSTOMER, isActive: true, emailVerified: true } as any,
  });

  const [partnerUser] = await User.findOrCreate({
    where: { email: "partner@shapthagiri-edibles.com" },
    defaults: { name: "Demo Delivery Partner", email: "partner@shapthagiri-edibles.com", phone: "+919900000004", passwordHash: partnerPw, role: Role.DELIVERY_PARTNER, isActive: true, emailVerified: true } as any,
  });
  await DeliveryPartner.findOrCreate({
    where: { phone: "+919900000004" },
    defaults: { userId: partnerUser.id, name: "Demo Delivery Partner", phone: "+919900000004", vehicle: "Motorcycle", vehicleNumber: "KL-09-AA-0001", status: "approved", rating: 4.8, isOnline: true } as any,
  });

  // The opening balance is backed by a ledger row, so balance = Σ transactions from day one.
  const [loyalty, loyaltyCreated] = await LoyaltyAccount.findOrCreate({ where: { userId: customer.id }, defaults: { userId: customer.id, pointsBalance: 120, lifetimePoints: 120, tier: "bronze" } as any });
  if (loyaltyCreated) await LoyaltyTransaction.create({ accountId: loyalty.id, points: 120, reason: "Welcome bonus" } as any);
  return { admin, manager, customer };
}

/**
 * The production administrator, from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD.
 * Skipped (with a warning) when either is missing — create one by hand then.
 */
async function seedProductionAdmin() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "";
  if (!email || !password) {
    logger.warn("Production seed: SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — no administrator created.");
    return;
  }
  if (password.length < 12) throw new Error("SEED_ADMIN_PASSWORD must be at least 12 characters.");
  const [, created] = await User.findOrCreate({
    where: { email },
    defaults: { name: `${BRAND.name} Admin`, email, passwordHash: await hashPassword(password), role: Role.ADMIN, isActive: true, emailVerified: true } as any,
  });
  logger.info(created ? `Production seed: administrator ${email} created.` : `Production seed: administrator ${email} already exists — left unchanged.`);
}

async function seed() {
  await sequelize.authenticate();
  logger.info(`Seeding ${BRAND.name} data (${isProd ? "production" : "development"})...`);

  await seedRbac();

  /* ───────────────────────── Shop ───────────────────────── */
  // The refinery's own unit at Vannamada, Palakkad — the one place stock ships
  // from. It ships India-wide, so the delivery radius covers the whole country;
  // the engine's 15 km default would reject every order outside the town.
  // TODO: lat/lng are central Palakkad — set the unit's exact pin in Dashboard → Shops.
  const [shop] = await Shop.findOrCreate({
    where: { name: "Shapthagiri Refineries — Vannamada" },
    defaults: {
      name: "Shapthagiri Refineries — Vannamada", address: "Neelamkatchi, Vannamada", city: "Palakkad", state: "Kerala",
      country: "India", postalCode: "678555", lat: 10.7867, lng: 76.6548, phone: "+919446380334", email: BRAND.email,
      openingTime: "09:00", closingTime: "18:00", processingTimeMinutes: 1440, deliveryRadiusKm: 3500,
      isActive: true, pickupEnabled: true,
    } as any,
  });

  const demo = isProd ? null : await seedDemoUsers(shop);
  if (isProd) await seedProductionAdmin();

  /* ───────────────────────── Catalogue ───────────────────────── */
  const [category] = await Category.findOrCreate({
    where: { slug: "coconut-oil" },
    defaults: { name: "Coconut Oil", slug: "coconut-oil", imageUrl: PACK_IMAGES["pooram-1ltr"], sortOrder: 0, isActive: true } as any,
  });

  const brandIds = new Map<string, string>();
  for (const [slug, name] of [["pooram", "Pooram"], ["dhwani", "Dhwani"]]) {
    const [b] = await Brand.findOrCreate({ where: { slug }, defaults: { name, slug, logoUrl: null } as any });
    brandIds.set(slug, b.id);
  }

  // Distance bands decide which shop can serve an address (not what delivery
  // costs — that is the rate card below). One shop, nationwide: every band open.
  const ZONES = [
    { code: "A", label: "Local",    distanceMinKm: 0,   distanceMaxKm: 10,    deliveryFee: 49 },
    { code: "B", label: "Metro",    distanceMinKm: 10,  distanceMaxKm: 50,    deliveryFee: 49 },
    { code: "C", label: "Regional", distanceMinKm: 50,  distanceMaxKm: 200,   deliveryFee: 49 },
    { code: "D", label: "National", distanceMinKm: 200, distanceMaxKm: 500,   deliveryFee: 49 },
    { code: "E", label: "Remote",   distanceMinKm: 500, distanceMaxKm: 99999, deliveryFee: 49 },
  ];
  for (const z of ZONES) await DeliveryZone.findOrCreate({ where: { code: z.code }, defaults: z as any });

  await seedRateCard();

  const variantBySku = new Map<string, ProductVariant>();
  const productBySku = new Map<string, { id: string; title: string; image: string }>();
  for (const [i, p] of PACKS.entries()) {
    const title = packTitle(p);
    const sku = packSku(p);
    const image = PACK_IMAGES[p.key];
    const [product] = await Product.findOrCreate({
      where: { slug: slugify(title) },
      defaults: {
        title, slug: slugify(title), subtitle: p.line.subtitle, description: p.line.description,
        brandId: brandIds.get(p.line.brand), categoryId: category.id, status: "published",
        specifications: { ...p.line.specs, Pack: `${p.size} ${p.pack.toLowerCase()}` },
        // Newest first in the default listing keeps the range in catalogue order.
        createdAt: new Date(Date.now() - i * 60_000),
      } as any,
    });
    const [variant] = await ProductVariant.findOrCreate({
      where: { sku },
      defaults: { productId: product.id, sku, defaultPrice: p.price, mrp: p.mrp, weightKg: p.kg, attributes: { Size: p.size, Pack: p.pack } } as any,
    });
    variantBySku.set(sku, variant);
    productBySku.set(sku, { id: product.id, title: product.title, image });
    await ProductMedia.findOrCreate({
      where: { productId: product.id, url: image },
      defaults: { productId: product.id, variantId: null, url: image, type: "image", sortOrder: 0 } as any,
    });
    await ShopInventory.findOrCreate({
      where: { shopId: shop.id, variantId: variant.id },
      defaults: { shopId: shop.id, variantId: variant.id, quantity: 50, lowStockThreshold: 10, isActive: true } as any,
    });
  }

  /* ───────────────────────── Settings ───────────────────────── */
  // Registration numbers are not public yet: business.gst / business.fssai stay
  // empty, and the invoice prints each line only once it is filled in.
  const SETTINGS = [
    { key: "business.name", value: BRAND.name, scope: "general" },
    { key: "business.legalName", value: BRAND.legalName, scope: "general" },
    { key: "business.gst", value: "", scope: "general" },
    { key: "business.fssai", value: "", scope: "general" },
    { key: "business.supportEmail", value: BRAND.email, scope: "general" },
    { key: "business.phone", value: BRAND.phone, scope: "general" },
    { key: "business.landline", value: BRAND.landline, scope: "general" },
    // Digits only, no "+" — the form wa.me takes — for the storefront's
    // "chat with us" links.
    { key: "business.whatsappNumber", value: "919446380334", scope: "general" },
    { key: "business.address", value: BRAND.addressLine, scope: "general" },
    { key: "currency", value: "INR", scope: "general" },
    { key: "timezone", value: "Asia/Kolkata", scope: "general" },
    // Not charged to customers (shelf prices include tax) — the settlement
    // engine uses it for tax on the platform commission.
    { key: "tax.rate", value: 0.18, scope: "pricing" },
    { key: "delivery.fee", value: 49, scope: "pricing" },
    { key: "delivery.freeThreshold", value: 500, scope: "pricing" },
    { key: "delivery.expressSurcharge", value: 30, scope: "pricing" },
  ];
  for (const s of SETTINGS) {
    await Setting.findOrCreate({ where: { key: s.key }, defaults: s as any });
  }

  /* ───────────────────────── Feature Flags ───────────────────────── */
  const FLAGS = [
    { key: "express-delivery", enabled: true, rolloutPct: 100, conditions: {} },
    { key: "loyalty-points", enabled: true, rolloutPct: 100, conditions: {} },
    { key: "wallet-refunds", enabled: false, rolloutPct: 0, conditions: {} },
  ];
  for (const f of FLAGS) {
    await FeatureFlag.findOrCreate({ where: { key: f.key }, defaults: f as any });
  }

  /* ───────────────────────── Return policy ───────────────────────── */
  // Without a global row every product resolves to "not returnable", so a leaking can could never be returned.
  if (!(await GlobalPolicy.count())) {
    await GlobalPolicy.create({
      isReturnable: true, isReplaceable: true, returnWindowDays: 7, replacementWindowDays: 7,
      restockingFeeType: "NONE", restockingFeeValue: 0, requiresInspection: true,
    } as any);
  }

  if (demo) await seedDemoOrder(demo, shop, variantBySku, productBySku);

  logger.info(
    `Seed complete — ${PACKS.length} products (Pooram, Dhwani), 1 category, 1 shop, ${RATE_CARD.zones.length}-zone rate card` +
      (demo ? "; demo logins admin/manager/customer/partner @shapthagiri-edibles.com (password = role); 1 sample order" : ""),
  );
  await sequelize.close();
  process.exit(0);
}

/** A delivered order and a few audit rows, so the dashboard has something to show locally. */
async function seedDemoOrder(
  demo: { admin: User; manager: User; customer: User },
  shop: Shop,
  variantBySku: Map<string, ProductVariant>,
  productBySku: Map<string, { id: string; title: string; image: string }>,
) {
  const v1 = variantBySku.get("SHG-POORAM-1LTR")!;
  const v2 = variantBySku.get("SHG-DHW-500ML")!;
  // Shelf prices are tax-inclusive; Kerala, 1–2 kg parcel on the rate card above.
  const subtotal = Number(v1.defaultPrice) + Number(v2.defaultPrice);
  const deliveryFee = subtotal >= 500 ? 0 : 70;
  const total = subtotal + deliveryFee;

  const [order, orderCreated] = await Order.findOrCreate({
    where: { orderNumber: "ORD-DEMO-0001" },
    defaults: {
      orderNumber: "ORD-DEMO-0001", userId: demo.customer.id, status: OrderStatus.DELIVERED,
      subtotal, discount: 0, tax: 0, deliveryFee, total, payableAmount: total,
      paymentMethod: PaymentMethod.UPI, paymentStatus: PaymentStatus.CAPTURED,
      addressSnapshot: { label: "Home", line1: "Near Stadium Bus Stand", city: "Palakkad", state: "Kerala", pincode: "678001" },
      deliveryOption: "standard", placedAt: new Date(),
    } as any,
  });

  if (orderCreated) {
    const ship = await OrderShipment.create({
      orderId: order.id, shopId: shop.id, shipmentNumber: "ORD-DEMO-0001-1", status: OrderStatus.DELIVERED,
      dispatchedAt: new Date(), deliveredAt: new Date(),
    } as any);
    // Same per-line split the live checkout writes (delivery fee included), so refunds work on it.
    const lines = [v1, v2];
    const alloc = computeLineAllocations(
      lines.map((v) => ({ id: v.id, price: Number(v.defaultPrice), quantity: 1 })),
      { deliveryFee, payableAmount: total },
    );
    for (const v of lines) {
      // Same snapshot fields the live checkout writes, so analytics/bestsellers,
      // invoices and order pages can name the product.
      const prod = productBySku.get(v.sku)!;
      const a = alloc.get(v.id)!;
      await OrderItem.create({
        shipmentId: ship.id, variantId: v.id, shopId: shop.id, quantity: 1,
        price: v.defaultPrice, unitPrice: v.defaultPrice, subtotal: v.defaultPrice,
        allocatedCoupon: 0, allocatedLoyalty: 0, allocatedGiftCard: 0, allocatedTax: 0,
        allocatedDelivery: a.allocatedDelivery, allocatedWallet: a.allocatedWallet, allocatedCash: a.allocatedCash,
        lineRefundableBase: a.lineRefundableBase,
        productId: prod.id, productName: prod.title, productImage: prod.image,
        sku: v.sku, variantAttributes: v.attributes, fulfillmentStatus: "delivered",
      } as any);
      await RoutingDecision.create({ orderId: order.id, variantId: v.id, chosenShopId: shop.id, distanceKm: 18.6, zone: "B", reason: "Closest shop with stock" } as any);
    }
    await OrderStatusHistory.create({ orderId: order.id, status: OrderStatus.DELIVERED, notes: "Sample order delivered", actorId: demo.admin.id } as any);
    await Payment.create({ orderId: order.id, method: "upi", gateway: "mock", amount: total, status: "captured" } as any);
  }

  const AUDITS = [
    { actorId: demo.admin.id, action: "UPDATE", entity: "Setting", entityId: "tax.rate", before: { value: 0.05 }, after: { value: 0.18 }, ip: "192.168.1.1", correlationId: "c-12345" },
    { actorId: demo.admin.id, action: "CREATE", entity: "Product", entityId: v1.productId, before: null, after: { sku: v1.sku, price: v1.defaultPrice }, ip: "192.168.1.1", correlationId: "c-12346" },
    { actorId: demo.admin.id, action: "UPDATE", entity: "User", entityId: demo.manager.id, before: { role: "customer" }, after: { role: "shop_manager" }, ip: "192.168.1.1", correlationId: "c-12347" },
    { actorId: demo.admin.id, action: "UPDATE", entity: "FeatureFlag", entityId: "wallet-refunds", before: { enabled: true }, after: { enabled: false }, ip: "127.0.0.1", correlationId: "c-12348" },
  ];
  for (const a of AUDITS) {
    await AuditLog.findOrCreate({ where: { correlationId: a.correlationId }, defaults: a as any });
  }
}

seed().catch((e) => {
  logger.error("Seed failed", { error: e });
  process.exit(1);
});
