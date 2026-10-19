import "reflect-metadata";
import { sequelize } from "@/config/database";
import {
  User, Shop, Category, Brand, DeliveryZone,
  Product, ProductVariant, ProductMedia, ShopInventory,
  DeliveryPartner, LoyaltyAccount,
  Order, OrderShipment, OrderItem, OrderStatusHistory, RoutingDecision, Payment,
  Setting, FeatureFlag, AuditLog,
  Role as RoleModel, Permission, RolePermission,
} from "@/models";
import { hashPassword } from "@/common/utils/password.util";
import { Role } from "@/common/enums/role.enum";
import { OrderStatus, PaymentMethod, PaymentStatus } from "@/common/enums/order-status.enum";
import {
  WILDCARD_PERMISSION, SYSTEM_ROLES, flattenCatalog, resolveGrant,
} from "@/modules/rbac/rbac.catalog";
import { logger } from "@/common/utils/logger";

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

type SeedProduct = {
  title: string; slug: string; cat: string; sku: string;
  weight: string; kg: number; price: number; mrp: number;
  /** File suffixes under web /public/shreshtam/products/<slug><suffix>; first = main image. */
  images: string[];
  subtitle: string; description: string;
};

// Catalogue mirrors https://www.shreshtam.in — names, prices, MRP, net weight,
// descriptions and product photos (served by the web app from /public/shreshtam).
const PRODUCTS: SeedProduct[] = [
  { title: "Andhra Avakkai", slug: "andhra-avakkai", cat: "pickles", sku: "SHR-AVAKKAI-250G", weight: "250 g", kg: 0.25, price: 130, mrp: 150, images: ["-1.jpeg", "-2.jpeg"],
    subtitle: "Andhra-style raw mango pickle in sesame oil",
    description: "Shreshtam Andhra Avakkai Pickle is a traditional Andhra-style mango pickle made from fresh raw mangoes, premium mustard seeds, red chilli powder, aromatic spices, and sesame oil. Prepared using authentic recipes and quality ingredients, it delivers a bold, tangy, and spicy flavor that perfectly complements rice, curd rice, dosa, idli, and other South Indian meals. Crafted with care, Shreshtam Andhra Avakkai Pickle brings the rich taste of homemade tradition to every meal." },
  { title: "Cut Mango Pickle", slug: "cut-mango-pickle", cat: "pickles", sku: "SHR-CUTMANGO-500G", weight: "500 g", kg: 0.5, price: 160, mrp: 180, images: ["-1.png", "-2.jpg"],
    subtitle: "Hand-cut raw mango pickle — no vinegar, no garlic",
    description: "Shreshtam Cut Mango Pickle is a traditional Kerala pickle made from hand-cut raw mangoes, blended with premium spices. Prepared without vinegar or garlic, it offers an authentic homemade taste that pairs perfectly with rice and everyday meals." },
  { title: "Dried Mango (Unakkumanga)", slug: "dried-mango-unakkumanga", cat: "pickles", sku: "SHR-UNAKKUMANGA-100G", weight: "100 g", kg: 0.1, price: 100, mrp: 110, images: ["-1.jpeg", "-2.jpeg"],
    subtitle: "Traditional sun-dried raw mango",
    description: "Shreshtam Unakkumanga is a traditional sun-dried raw mango delicacy, carefully prepared to preserve its authentic taste and natural goodness. Its rich, tangy flavor makes it a perfect ingredient for curries, chutneys, and traditional South Indian dishes." },
  { title: "Fried Lime Pickle (Varuthanaranga)", slug: "fried-lime-pickle-varuthanaranga", cat: "pickles", sku: "SHR-VARUTHANARANGA-250G", weight: "250 g", kg: 0.25, price: 110, mrp: 130, images: ["-1.jpeg", "-2.jpeg"],
    subtitle: "Lemons fried in gingelly oil, then spiced",
    description: "Shreshtam Varuthanaranga is a traditional Kerala delicacy made by first frying fresh lemons in gingelly (sesame) oil, then blending them with carefully selected spices and seasonings. This authentic preparation creates a rich, tangy, and flavorful accompaniment that pairs perfectly with rice, kanji, and traditional South Indian meals." },
  { title: "Kadumanga (Tender Mango Pickle)", slug: "kadumanga-tender-mango-pickle", cat: "pickles", sku: "SHR-KADUMANGA-500G", weight: "500 g", kg: 0.5, price: 225, mrp: 260, images: ["-1.png", "-2.jpg"],
    subtitle: "Kerala-style tender mango pickle — no vinegar, no oil",
    description: "Shreshtam Kadumanga is a traditional Kerala-style tender mango pickle made with fresh, handpicked mangoes. Prepared without vinegar or oil, it brings the authentic, bold tangy-spicy taste that's a must-have for everyday meals. Simple, pure, and packed with flavor — just like homemade." },
  { title: "Lime Pickle", slug: "lime-pickle", cat: "pickles", sku: "SHR-LIME-250G", weight: "250 g", kg: 0.25, price: 90, mrp: 100, images: ["-1.png", "-2.jpg", "-3.jpg"],
    subtitle: "Classic homemade lime pickle — no vinegar, no garlic",
    description: "Shreshtam Lime Pickle is made from carefully selected fresh limes, blended with the right mix of spices for a classic homemade taste. With no vinegar or garlic, it stays true to tradition and pairs beautifully with everyday meals." },
  { title: "Puliyinji", slug: "puliyinji", cat: "pickles", sku: "SHR-PULIYINJI-250G", weight: "250 g", kg: 0.25, price: 95, mrp: 105, images: ["-1.png"],
    subtitle: "Sweet, sour and mildly spicy tamarind-ginger relish",
    description: "Shreshtam Puliyinji is a sweet, sour, and mildly spicy delicacy made with tamarind, jaggery, and ginger. Prepared in the traditional Kerala style, it is an essential part of every sadhya, adding a burst of authentic flavor to the festive spread." },
  { title: "Sadyamanga", slug: "sadyamanga", cat: "pickles", sku: "SHR-SADYAMANGA-500G", weight: "500 g", kg: 0.5, price: 175, mrp: 200, images: ["-1.png", "-2.jpeg"],
    subtitle: "The festive sadhya mango pickle",
    description: "Shreshtam Sadyamanga is made with fresh, raw mangoes and handpicked spices to bring you the authentic taste of Kerala's festive feast. A must-have for your Onam Sadhya, this pickle carries the true flavors of tradition — prepared without vinegar or garlic, just the way our grandmothers made it." },
  { title: "Uluva Manga (Methi Mango Pickle)", slug: "uluva-manga-methi-mango-pickle", cat: "pickles", sku: "SHR-ULUVAMANGA-500G", weight: "500 g", kg: 0.5, price: 170, mrp: 195, images: ["-1.png", "-2.jpg"],
    subtitle: "Mango and fenugreek — no oil, vinegar or garlic",
    description: "Shreshtam Uluvamanga is a classic Kerala delicacy made with mangoes and fenugreek. Its unique mix of sourness and the earthy taste of uluva makes it stand out from regular pickles. True to tradition, it is prepared without oil, vinegar or garlic, bringing you pure, homely flavor in every bite." },
  { title: "Vadukapuli (Wild Lime Pickle)", slug: "vadukapuli-wild-lime-pickle", cat: "pickles", sku: "SHR-VADUKAPULI-250G", weight: "250 g", kg: 0.25, price: 100, mrp: 115, images: ["-1.jpg"],
    subtitle: "Thick wild lemon pickle, a sadhya favourite",
    description: "Shreshtam Vadukapuli Pickle is made using the traditional thick wild lemon, known for its bold tang and unique aroma. Blended with authentic spices and prepared without vinegar or garlic, it brings out the true Kerala taste. A perfect side for sadhya and daily meals alike." },
  { title: "Varuthamanga (Fried Mango)", slug: "varuthamanga-fried-mango", cat: "pickles", sku: "SHR-VARUTHAMANGA-250G", weight: "250 g", kg: 0.25, price: 170, mrp: 200, images: ["-1.png", "-2.jpeg"],
    subtitle: "Signature fried raw mango pickle",
    description: "Shreshtam Varuthamanga is a specialty Kerala pickle made from fried raw mango pieces. Crunchy, tangy, and spiced just right, it offers a unique taste unlike regular mango pickles. Prepared without vinegar or garlic, this rare delicacy is one of Shreshtam's most loved and signature products." },
  { title: "Chutney Powder", slug: "chutney-powder", cat: "powders", sku: "SHR-CHUTNEYPOWDER-100G", weight: "100 g", kg: 0.1, price: 125, mrp: 150, images: ["-1.png", "-2.jpg"],
    subtitle: "The perfect partner for idli and dosa",
    description: "The perfect blend for your idli and dosa – our Shreshtam Chutney Powder! Just a spoonful of this, and you'll be wondering how quickly the idlis and dosas disappeared! No need for anything else – this one powder does it all. Also ideal for making podi idli and podi dosa." },
  { title: "Coconut Chutney Powder (Chammanthi Podi)", slug: "coconut-chutney-powder-chammanthi-podi", cat: "powders", sku: "SHR-CHAMMANTHI-100G", weight: "100 g", kg: 0.1, price: 90, mrp: 105, images: ["-1.png"],
    subtitle: "Roasted coconut chammanthi — no preservatives",
    description: "Even without any side dishes, a little chammanthi podi can make a simple meal feel complete. That's the magic of this humble yet flavorful condiment. Made by roasting coconut and grinding it to perfection, it stays fresh for long without spoiling. Shreshtam's chammanthi podi is made at home using fresh coconuts—completely free from preservatives or any added chemicals." },
  { title: "Sambar Powder", slug: "sambar-powder", cat: "powders", sku: "SHR-SAMBAR-100G", weight: "100 g", kg: 0.1, price: 90, mrp: 105, images: ["-1.png", "-2.jpg"],
    subtitle: "Roasted spices and lentils for Kerala-style sambar",
    description: "Shreshtam Sambar Powder is a finely balanced blend of roasted spices and lentils, ground to perfection for rich aroma and authentic taste. Made without any preservatives, it brings out the true traditional flavor of Kerala-style sambar." },
  { title: "Bitter Gourd (Pavakka) Kondattam", slug: "bitter-gourd-pavakka-kondattam", cat: "kondattam", sku: "SHR-PAVAKKA-100G", weight: "100 g", kg: 0.1, price: 140, mrp: 150, images: ["-1.jpeg"],
    subtitle: "Spiced, sun-dried bitter gourd — fry till crisp",
    description: "Shreshtam Pavakka Kondattam is a traditional Kerala delicacy made from fresh bitter gourd, seasoned with spices, and sun-dried to preserve its authentic flavor. When fried until crisp, it becomes a delicious, crunchy side dish that pairs perfectly with rice and traditional South Indian meals." },
  { title: "Kondattam Mulak (Sun-Dried Curd Chilli)", slug: "kondattam-mulak-sun-dried-curd-chilli", cat: "kondattam", sku: "SHR-MULAK-50G", weight: "50 g", kg: 0.05, price: 60, mrp: 65, images: ["-1.jpg", "-2.jpg"],
    subtitle: "Green chillies soaked in curd and sun-dried",
    description: "Curd Chilli (Kondattam Mulak) is a traditional Kerala delicacy made from fresh green chillies soaked in curd and salt, then naturally sun-dried using time-honoured methods. Once fried, the chillies become crispy, tangy, and spicy, making them a perfect accompaniment to curd rice, kanji, dosa, and other South Indian meals. Prepared with natural ingredients and no artificial preservatives, Shreshtam Kondattam Mulak delivers an authentic homemade taste and the rich culinary heritage of Kerala." },
  { title: "Long Beans (Payar) Kondattam", slug: "long-beans-payar-kondattam", cat: "kondattam", sku: "SHR-PAYAR-100G", weight: "100 g", kg: 0.1, price: 80, mrp: 90, images: ["-1.png"],
    subtitle: "From chemical-free long beans grown on our own farm",
    description: "There's a special joy in harvesting crops grown on our own land—and an even greater joy in turning that into a product we can share with others. Shreshtam's Payar Kondattam is made from payar (long beans) cultivated right here on our land and completely chemical-free, carefully prepared and sun-dried using traditional methods to bring the authentic homemade taste of Kerala to your meals." },
];

async function seed() {
  await sequelize.authenticate();
  logger.info("Seeding Shreshtam data...");

  await seedRbac();

  /* ───────────────────────── Shop + users ───────────────────────── */
  const [adminPw, managerPw, customerPw, partnerPw] = await Promise.all([
    hashPassword("admin"), hashPassword("manager"), hashPassword("customer"), hashPassword("partner"),
  ]);

  const [admin] = await User.findOrCreate({
    where: { email: "admin@shreshtam.in" },
    defaults: { name: "Shreshtam Admin", email: "admin@shreshtam.in", phone: "+919900000001", passwordHash: adminPw, role: Role.ADMIN, isActive: true, emailVerified: true } as any,
  });

  // Single kitchen/store at Cherukara, Malappuram. Shreshtam ships India-wide
  // (7-day estimate), so the delivery radius covers the whole country — the
  // engine's 15 km default would reject every order outside the town.
  const [shop] = await Shop.findOrCreate({
    where: { name: "Shreshtam — Cherukara" },
    defaults: {
      name: "Shreshtam — Cherukara", address: "16/257A, Pulinkav, Cherukara PO", city: "Malappuram", state: "Kerala",
      country: "India", postalCode: "679340", lat: 10.9264, lng: 76.2275, phone: "+919902012150", email: "shreshtamgroup@gmail.com",
      openingTime: "08:30", closingTime: "17:00", processingTimeMinutes: 1440, deliveryRadiusKm: 3500,
      isActive: true, pickupEnabled: true,
    } as any,
  });

  const [manager] = await User.findOrCreate({
    where: { email: "manager@shreshtam.in" },
    defaults: { name: "Cherukara Store Manager", email: "manager@shreshtam.in", phone: "+919900000002", passwordHash: managerPw, role: Role.SHOP_MANAGER, shopId: shop.id, isActive: true, emailVerified: true } as any,
  });
  if (!manager.shopId) await manager.update({ shopId: shop.id });
  if (!shop.managerId) await shop.update({ managerId: manager.id });

  const [customer] = await User.findOrCreate({
    where: { email: "customer@shreshtam.in" },
    defaults: { name: "Demo Customer", email: "customer@shreshtam.in", phone: "+919900000003", passwordHash: customerPw, role: Role.CUSTOMER, isActive: true, emailVerified: true } as any,
  });

  const [partnerUser] = await User.findOrCreate({
    where: { email: "partner@shreshtam.in" },
    defaults: { name: "Demo Delivery Partner", email: "partner@shreshtam.in", phone: "+919900000004", passwordHash: partnerPw, role: Role.DELIVERY_PARTNER, isActive: true, emailVerified: true } as any,
  });
  await DeliveryPartner.findOrCreate({
    where: { phone: "+919900000004" },
    defaults: { userId: partnerUser.id, name: "Demo Delivery Partner", phone: "+919900000004", vehicle: "Motorcycle", vehicleNumber: "KL-10-AA-0001", status: "approved", rating: 4.8, isOnline: true } as any,
  });

  await LoyaltyAccount.findOrCreate({ where: { userId: customer.id }, defaults: { userId: customer.id, pointsBalance: 120, tier: "bronze" } as any });

  /* ───────────────────────── Catalog (Shreshtam) ───────────────────────── */
  // [name, slug, image]
  const CATS: Array<[string, string, string]> = [
    ["Pickles", "pickles", "/shreshtam/site/explore-1.png"],
    ["Powders", "powders", "/shreshtam/site/explore-2.png"],
    ["Kondattam", "kondattam", "/shreshtam/site/explore-3.png"],
  ];
  const catMap = new Map<string, string>();
  for (const [i, [name, slug, imageUrl]] of CATS.entries()) {
    const [c] = await Category.findOrCreate({ where: { slug }, defaults: { name, slug, imageUrl, sortOrder: i, isActive: true } as any });
    catMap.set(slug, c.id);
  }

  const [brand] = await Brand.findOrCreate({ where: { slug: "shreshtam" }, defaults: { name: "Shreshtam", slug: "shreshtam", logoUrl: "/shreshtam/logo.webp" } as any });

  // Every band needs a fee — PricingService treats a band with no fee as
  // "OUT_OF_ZONE" and blocks checkout. Shreshtam publishes no delivery tariff, so
  // a flat ₹49 (same as the delivery.fee setting; free above delivery.freeThreshold)
  // applies India-wide until real rates are set in Admin → Delivery Engine.
  const ZONES = [
    { code: "A", label: "Local",    distanceMinKm: 0,   distanceMaxKm: 10,    deliveryFee: 49 },
    { code: "B", label: "Metro",    distanceMinKm: 10,  distanceMaxKm: 50,    deliveryFee: 49 },
    { code: "C", label: "Regional", distanceMinKm: 50,  distanceMaxKm: 200,   deliveryFee: 49 },
    { code: "D", label: "National", distanceMinKm: 200, distanceMaxKm: 500,   deliveryFee: 49 },
    { code: "E", label: "Remote",   distanceMinKm: 500, distanceMaxKm: 99999, deliveryFee: 49 },
  ];
  for (const z of ZONES) await DeliveryZone.findOrCreate({ where: { code: z.code }, defaults: z as any });

  const variantBySku = new Map<string, ProductVariant>();
  const productBySku = new Map<string, { id: string; title: string; image: string }>();
  for (const p of PRODUCTS) {
    const [product] = await Product.findOrCreate({
      where: { slug: p.slug },
      defaults: {
        title: p.title, slug: p.slug, subtitle: p.subtitle, description: p.description,
        brandId: brand.id, categoryId: catMap.get(p.cat), status: "published",
        specifications: { "Net Weight": p.weight, "Made in": "Malappuram, Kerala" },
      } as any,
    });
    const [variant] = await ProductVariant.findOrCreate({
      where: { sku: p.sku },
      defaults: { productId: product.id, sku: p.sku, defaultPrice: p.price, mrp: p.mrp, weightKg: p.kg, attributes: { Weight: p.weight } } as any,
    });
    variantBySku.set(p.sku, variant);
    productBySku.set(p.sku, { id: product.id, title: product.title, image: `/shreshtam/products/${p.slug}${p.images[0]}` });
    // Product-level gallery (variantId null) — the storefront card and PDP use these.
    for (const [i, suffix] of p.images.entries()) {
      const url = `/shreshtam/products/${p.slug}${suffix}`;
      await ProductMedia.findOrCreate({
        where: { productId: product.id, url },
        defaults: { productId: product.id, variantId: null, url, type: "image", sortOrder: i } as any,
      });
    }
    await ShopInventory.findOrCreate({
      where: { shopId: shop.id, variantId: variant.id },
      defaults: { shopId: shop.id, variantId: variant.id, quantity: 50, lowStockThreshold: 10, isActive: true } as any,
    });
  }

  /* ───────────────────────── Sample delivered order ───────────────────────── */
  const v1 = variantBySku.get("SHR-VARUTHAMANGA-250G")!;
  const v2 = variantBySku.get("SHR-SAMBAR-100G")!;
  const subtotal = Number(v1.defaultPrice) + Number(v2.defaultPrice);
  const tax = Math.round(subtotal * 0.05);
  const deliveryFee = subtotal >= 500 ? 0 : 49;
  const total = subtotal + tax + deliveryFee;

  const [order, orderCreated] = await Order.findOrCreate({
    where: { orderNumber: "ORD-SHR-0001" },
    defaults: {
      orderNumber: "ORD-SHR-0001", userId: customer.id, status: OrderStatus.DELIVERED,
      subtotal, discount: 0, tax, deliveryFee, total,
      paymentMethod: PaymentMethod.UPI, paymentStatus: PaymentStatus.CAPTURED,
      addressSnapshot: { label: "Home", line1: "Near Bus Stand, Perinthalmanna", city: "Malappuram", state: "Kerala", pincode: "679322" },
      deliveryOption: "standard", placedAt: new Date(),
    } as any,
  });

  if (orderCreated) {
    const ship = await OrderShipment.create({
      orderId: order.id, shopId: shop.id, shipmentNumber: "ORD-SHR-0001-1", status: OrderStatus.DELIVERED,
      dispatchedAt: new Date(), deliveredAt: new Date(),
    } as any);
    for (const v of [v1, v2]) {
      // Same snapshot fields the live checkout writes, so analytics/bestsellers,
      // invoices and order pages can name the product.
      const prod = productBySku.get(v.sku)!;
      await OrderItem.create({
        shipmentId: ship.id, variantId: v.id, shopId: shop.id, quantity: 1,
        price: v.defaultPrice, unitPrice: v.defaultPrice, subtotal: v.defaultPrice,
        productId: prod.id, productName: prod.title, productImage: prod.image,
        sku: v.sku, variantAttributes: v.attributes, fulfillmentStatus: "delivered",
      } as any);
      await RoutingDecision.create({ orderId: order.id, variantId: v.id, chosenShopId: shop.id, distanceKm: 12.4, zone: "B", reason: "Closest shop with stock" } as any);
    }
    await OrderStatusHistory.create({ orderId: order.id, status: OrderStatus.DELIVERED, notes: "Sample order delivered", actorId: admin.id } as any);
    await Payment.create({ orderId: order.id, method: "upi", gateway: "mock", amount: total, status: "captured" } as any);
  }

  /* ───────────────────────── Settings ───────────────────────── */
  // Shreshtam publishes no GSTIN — business.gst stays empty until provided.
  const SETTINGS = [
    { key: "business.name", value: "Shreshtam", scope: "general" },
    { key: "business.gst", value: "", scope: "general" },
    { key: "business.supportEmail", value: "shreshtamgroup@gmail.com", scope: "general" },
    { key: "business.phone", value: "+91 99020 12150", scope: "general" },
    // Where cash-on-delivery orders go. Digits only, no "+" — that is the form
    // wa.me takes, and storing it pre-cleaned keeps the storefront from having
    // to guess how the number was typed.
    { key: "business.whatsappNumber", value: "919902012150", scope: "general" },
    { key: "business.address", value: "16/257A, Pulinkav, Cherukara PO, Malappuram Dist, Kerala 679340", scope: "general" },
    { key: "currency", value: "INR", scope: "general" },
    { key: "timezone", value: "Asia/Kolkata", scope: "general" },
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

  /* ───────────────────────── Audit Logs ───────────────────────── */
  const AUDITS = [
    { actorId: admin.id, action: "UPDATE", entity: "Setting", entityId: "tax.rate", before: { value: 0.05 }, after: { value: 0.18 }, ip: "192.168.1.1", correlationId: "c-12345" },
    { actorId: admin.id, action: "CREATE", entity: "Product", entityId: v1.productId, before: null, after: { sku: v1.sku, price: v1.defaultPrice }, ip: "192.168.1.1", correlationId: "c-12346" },
    { actorId: admin.id, action: "UPDATE", entity: "User", entityId: manager.id, before: { role: "customer" }, after: { role: "shop_manager" }, ip: "192.168.1.1", correlationId: "c-12347" },
    { actorId: admin.id, action: "UPDATE", entity: "FeatureFlag", entityId: "wallet-refunds", before: { enabled: true }, after: { enabled: false }, ip: "127.0.0.1", correlationId: "c-12348" },
  ];
  for (const a of AUDITS) {
    await AuditLog.findOrCreate({ where: { correlationId: a.correlationId }, defaults: a as any });
  }

  logger.info(`Seed complete — Shreshtam catalogue: ${PRODUCTS.length} products, ${CATS.length} categories, 1 shop; demo logins (admin/manager/customer/partner @shreshtam.in); 1 sample order`);
  await sequelize.close();
  process.exit(0);
}

seed().catch((e) => {
  logger.error("Seed failed", { error: e });
  process.exit(1);
});
