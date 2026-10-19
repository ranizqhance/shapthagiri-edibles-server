/**
 * RBAC permission catalog — the SINGLE SOURCE OF TRUTH for the default permission
 * universe. The seed migration upserts these rows into the `permissions` table
 * (idempotent, by `key`); the RBAC API reads the same list to render the matrix.
 *
 * Nothing here is hardcoded into business logic: controllers reference permission
 * KEYS (e.g. "products.create"), this file DEFINES those keys, and role→permission
 * assignments live entirely in the `role_permissions` DB table (runtime-editable).
 *
 * The catalog is additive: append modules/actions and re-run `db:migrate` — the
 * upsert grows the catalog without duplicating or destroying assignments.
 */

/** Synthetic all-access permission. Held only by super_admin / admin. */
export const WILDCARD_PERMISSION = "*";

export interface CatalogAction {
  action: string;
  label: string;
}

export interface CatalogModule {
  /** machine key, e.g. "products" */
  module: string;
  /** display, e.g. "Products" */
  moduleLabel: string;
  /** sidebar section, e.g. "Catalog" */
  group: string;
  actions: CatalogAction[];
}

const a = (action: string, label: string): CatalogAction => ({ action, label });

/**
 * Ordered by sidebar section. Order here defines `sortModule` / `sortAction`.
 * Every admin dashboard module is represented so the whole panel can be gated.
 */
export const RBAC_CATALOG: CatalogModule[] = [
  // ── Overview ───────────────────────────────────────────────────────────
  { group: "Overview", module: "dashboard", moduleLabel: "Dashboard", actions: [a("view", "View")] },

  // ── Catalog ────────────────────────────────────────────────────────────
  {
    group: "Catalog", module: "products", moduleLabel: "Products",
    actions: [
      a("view", "View"), a("create", "Create"), a("edit", "Edit"), a("delete", "Delete"),
      a("publish", "Publish"), a("import", "Import"), a("export", "Export"), a("approve", "Approve"),
      a("manageImages", "Manage Images"), a("manageInventory", "Manage Inventory"), a("manageVariants", "Manage Variants"),
    ],
  },
  {
    group: "Catalog", module: "categories", moduleLabel: "Categories",
    actions: [a("view", "View"), a("create", "Create"), a("edit", "Edit"), a("delete", "Delete")],
  },
  {
    group: "Catalog", module: "brands", moduleLabel: "Brands",
    actions: [a("view", "View"), a("create", "Create"), a("edit", "Edit"), a("delete", "Delete")],
  },
  {
    group: "Catalog", module: "inventory", moduleLabel: "Inventory",
    actions: [a("view", "View"), a("edit", "Edit"), a("adjust", "Adjust Stock"), a("export", "Export")],
  },

  // ── Sales ──────────────────────────────────────────────────────────────
  {
    group: "Sales", module: "orders", moduleLabel: "Orders",
    actions: [
      a("view", "View"), a("create", "Create"), a("edit", "Edit"), a("cancel", "Cancel"),
      a("refund", "Refund"), a("return", "Return"), a("export", "Export"), a("printInvoice", "Print Invoice"),
    ],
  },
  {
    group: "Sales", module: "fulfillment", moduleLabel: "Fulfillment",
    actions: [a("view", "View"), a("ship", "Ship"), a("assign", "Assign"), a("export", "Export")],
  },
  {
    group: "Sales", module: "returns", moduleLabel: "Returns",
    actions: [a("view", "View"), a("approve", "Approve"), a("reject", "Reject"), a("refund", "Refund"), a("export", "Export")],
  },
  {
    group: "Sales", module: "reviews", moduleLabel: "Reviews",
    actions: [a("view", "View"), a("moderate", "Moderate"), a("reply", "Reply"), a("delete", "Delete")],
  },
  {
    group: "Sales", module: "support", moduleLabel: "Support",
    actions: [a("view", "View"), a("respond", "Respond"), a("close", "Close")],
  },

  // ── People ─────────────────────────────────────────────────────────────
  {
    group: "People", module: "customers", moduleLabel: "Customers",
    actions: [a("view", "View"), a("create", "Create"), a("edit", "Edit"), a("deactivate", "Deactivate"), a("export", "Export")],
  },
  {
    group: "People", module: "users", moduleLabel: "Admin Users",
    actions: [a("view", "View"), a("create", "Create"), a("editRole", "Edit Role"), a("deactivate", "Deactivate"), a("export", "Export")],
  },
  {
    group: "People", module: "shops", moduleLabel: "Shops",
    actions: [a("view", "View"), a("create", "Create"), a("edit", "Edit"), a("approve", "Approve"), a("deactivate", "Deactivate")],
  },

  // ── Marketing ──────────────────────────────────────────────────────────
  {
    group: "Marketing", module: "marketing", moduleLabel: "Marketing",
    actions: [a("view", "View"), a("create", "Create"), a("edit", "Edit"), a("delete", "Delete")],
  },
  {
    group: "Marketing", module: "coupons", moduleLabel: "Coupons",
    actions: [a("view", "View"), a("create", "Create"), a("edit", "Edit"), a("delete", "Delete")],
  },
  {
    group: "Marketing", module: "giftcards", moduleLabel: "Gift Cards",
    actions: [a("view", "View"), a("create", "Create"), a("edit", "Edit"), a("disable", "Disable")],
  },
  {
    group: "Marketing", module: "loyalty", moduleLabel: "Loyalty",
    actions: [a("view", "View"), a("adjust", "Adjust Points"), a("configure", "Configure")],
  },
  {
    group: "Marketing", module: "notifications", moduleLabel: "Notifications",
    actions: [a("view", "View"), a("send", "Send"), a("configure", "Configure")],
  },
  {
    group: "Marketing", module: "alerts", moduleLabel: "Alerts",
    actions: [a("view", "View"), a("configure", "Configure")],
  },

  // ── Finance ────────────────────────────────────────────────────────────
  {
    group: "Finance", module: "finance", moduleLabel: "Finance",
    actions: [a("view", "View"), a("downloadReports", "Download Reports"), a("manageWallet", "Manage Wallet"), a("export", "Export")],
  },
  {
    group: "Finance", module: "settlement", moduleLabel: "Settlement",
    actions: [a("view", "View"), a("generate", "Generate Settlement"), a("approve", "Approve Settlement"), a("payout", "Process Payout"), a("export", "Export")],
  },
  {
    group: "Finance", module: "taxes", moduleLabel: "Taxes",
    actions: [a("view", "View"), a("remit", "Remit"), a("export", "Export")],
  },
  {
    group: "Finance", module: "wallet", moduleLabel: "Wallet",
    actions: [a("view", "View"), a("credit", "Credit"), a("debit", "Debit"), a("adjust", "Adjust")],
  },

  // ── Delivery ───────────────────────────────────────────────────────────
  {
    group: "Delivery", module: "delivery", moduleLabel: "Delivery",
    actions: [a("view", "View"), a("edit", "Edit"), a("configure", "Configure")],
  },
  {
    group: "Delivery", module: "deliveryEngine", moduleLabel: "Delivery Engine",
    actions: [a("view", "View"), a("configure", "Configure"), a("simulate", "Simulate")],
  },
  {
    group: "Delivery", module: "deliveryPartners", moduleLabel: "Delivery Partners",
    actions: [a("view", "View"), a("create", "Create"), a("edit", "Edit"), a("approve", "Approve"), a("deactivate", "Deactivate")],
  },
  {
    group: "Delivery", module: "disputes", moduleLabel: "Disputes",
    actions: [a("view", "View"), a("resolve", "Resolve"), a("escalate", "Escalate"), a("export", "Export")],
  },

  // ── Insights ───────────────────────────────────────────────────────────
  {
    group: "Insights", module: "analytics", moduleLabel: "Analytics",
    actions: [a("view", "View"), a("export", "Export")],
  },
  {
    group: "Insights", module: "reports", moduleLabel: "Reports",
    actions: [a("view", "View"), a("generate", "Generate"), a("schedule", "Schedule"), a("export", "Export")],
  },

  // ── System ─────────────────────────────────────────────────────────────
  {
    group: "System", module: "settings", moduleLabel: "Settings",
    actions: [a("view", "View"), a("edit", "Edit")],
  },
  {
    group: "System", module: "audit", moduleLabel: "Audit Trail",
    actions: [a("view", "View"), a("export", "Export")],
  },
  {
    group: "System", module: "roles", moduleLabel: "Roles & Permissions",
    actions: [
      a("view", "View"), a("create", "Create"), a("edit", "Edit"),
      a("delete", "Delete"), a("duplicate", "Duplicate"), a("assignUsers", "Assign Users"),
    ],
  },
];

/** Flattened `{ key, module, action, label, moduleLabel, moduleGroup, sortModule, sortAction }` rows. */
export interface CatalogPermissionRow {
  key: string;
  module: string;
  action: string;
  label: string;
  moduleLabel: string;
  moduleGroup: string;
  sortModule: number;
  sortAction: number;
}

export function flattenCatalog(): CatalogPermissionRow[] {
  const rows: CatalogPermissionRow[] = [];
  RBAC_CATALOG.forEach((m, sortModule) => {
    m.actions.forEach((act, sortAction) => {
      rows.push({
        key: `${m.module}.${act.action}`,
        module: m.module,
        action: act.action,
        label: act.label,
        moduleLabel: m.moduleLabel,
        moduleGroup: m.group,
        sortModule,
        sortAction,
      });
    });
  });
  return rows;
}

/** All permission keys of a module, e.g. allKeys("products"). */
export function allKeys(module: string): string[] {
  const m = RBAC_CATALOG.find((x) => x.module === module);
  return m ? m.actions.map((act) => `${module}.${act.action}`) : [];
}

/**
 * Grant spec for a seeded system role.
 * "*"                              → the wildcard permission (all-access)
 * { module: "*" }                  → every action of that module
 * { module: ["view", "create"] }   → those specific actions
 */
export type RoleGrant = "*" | Record<string, "*" | string[]>;

export interface SystemRoleDef {
  key: string;
  name: string;
  description: string;
  grants: RoleGrant;
}

/**
 * Seeded system roles. `admin` / `super_admin` hold the wildcard. The rest are
 * seeded with a permission set equal to their CURRENT access so behaviour is
 * unchanged on day one; admins can freely edit them afterwards. These rows are
 * `isSystem = true`: not deletable, key immutable.
 */
export const SYSTEM_ROLES: SystemRoleDef[] = [
  { key: "super_admin", name: "Super Admin", description: "Unrestricted platform access.", grants: "*" },
  { key: "admin", name: "Admin", description: "Full administrative access.", grants: "*" },
  {
    key: "shop_manager", name: "Shop Manager", description: "Manages catalog, orders, returns and fulfilment for a shop.",
    grants: {
      dashboard: "*", products: "*", categories: ["view"], brands: ["view"], inventory: "*",
      orders: "*", fulfillment: "*", returns: "*", reviews: "*", support: ["view", "respond"],
      finance: ["view"], settlement: ["view"], analytics: ["view"], reports: ["view"],
    },
  },
  {
    key: "finance", name: "Finance", description: "Finance, settlements, taxes and wallet operations.",
    grants: {
      dashboard: ["view"], finance: "*", settlement: "*", taxes: "*", wallet: "*",
      orders: ["view"], reports: "*", analytics: ["view"],
    },
  },
  {
    key: "marketing", name: "Marketing", description: "Campaigns, coupons, gift cards, loyalty and notifications.",
    grants: {
      dashboard: ["view"], marketing: "*", coupons: "*", giftcards: "*", loyalty: "*",
      notifications: "*", alerts: "*", analytics: ["view"], reports: ["view"],
    },
  },
  {
    key: "support", name: "Support", description: "Customer support, disputes and read access to orders/returns.",
    grants: {
      dashboard: ["view"], support: "*", disputes: ["view"], reviews: ["view", "moderate", "reply"],
      orders: ["view"], returns: ["view"], customers: ["view"],
    },
  },
  {
    key: "operations", name: "Operations", description: "Fulfilment, delivery engine, partners and disputes.",
    grants: {
      dashboard: ["view"], fulfillment: "*", delivery: "*", deliveryEngine: "*",
      deliveryPartners: "*", disputes: "*", orders: ["view"],
    },
  },
  {
    key: "delivery_partner", name: "Delivery Partner", description: "Delivery app account — no admin panel access.",
    grants: {},
  },
  {
    key: "customer", name: "Customer", description: "Storefront account — no admin panel access.",
    grants: {},
  },
];

/** Resolves a RoleGrant to concrete permission keys ("*" stays as the wildcard key). */
export function resolveGrant(grant: RoleGrant): string[] {
  if (grant === "*") return [WILDCARD_PERMISSION];
  const keys: string[] = [];
  for (const [module, spec] of Object.entries(grant)) {
    if (spec === "*") keys.push(...allKeys(module));
    else for (const action of spec) keys.push(`${module}.${action}`);
  }
  return keys;
}
