/**
 * Which routes are allowed to be reachable by any authenticated user.
 *
 * THE PROBLEM THIS SOLVES
 *
 * `PermissionsGuard` returns true when a route carries no permission metadata
 * (permissions.guard.ts). That default is not wrong — most customer-facing
 * routes are not RBAC-gated at all; they are scoped by ownership inside the
 * handler, e.g. `where: { id, userId: u.sub }`. A customer has no permission
 * keys, so requiring them would lock customers out of their own cart.
 *
 * But it fails OPEN, and silently. Add a route, forget `@RequirePermissions`,
 * and it is immediately reachable by anyone with an account — including an
 * account registered seconds earlier. That is exactly how `/shipments/:id`,
 * `/shipments/:id/pod` and `/partners/:id/documents` ended up exposed: nobody
 * decided they should be open, the default decided for them.
 *
 * WHY AN ALLOWLIST RATHER THAN DENY-BY-DEFAULT AT REQUEST TIME
 *
 * Denying ungated requests would mean marking all 111 self-service routes
 * with a decorator. For those routes the denial changes nothing — they are
 * already ownership-checked and would simply be marked and allowed. All the
 * protective value is in noticing a NEW ungated route, and a boot-time check
 * does that at deploy, loudly, instead of as a 403 storm against live
 * customers. Same protection, far smaller blast radius.
 *
 * ADDING A ROUTE
 *
 * If the API refuses to start naming your new route, that is the question
 * being asked deliberately: should this be permission-gated, or is it
 * genuinely self-service? Add `@RequirePermissions(...)` if the former. If the
 * latter, add it below AND make sure the handler scopes by the caller — this
 * list is a record that someone decided, not a way to skip deciding.
 *
 * Generated from the live route table; see the audit below.
 */
export const SELF_SERVICE_ROUTES: ReadonlySet<string> = new Set([
  "GET /auth/me",
  "POST /auth/logout",
  "DELETE /cart/coupon",
  "DELETE /cart/gift-card",
  "DELETE /cart/items/:id",
  "GET /cart",
  "PATCH /cart/items/:id",
  "POST /cart/checkout-validate",
  "POST /cart/coupon",
  "POST /cart/delivery-mode",
  "POST /cart/gift-card",
  "POST /cart/items",
  "POST /cart/merge",
  "POST /cart/reprice",
  "GET /disputes/:id",
  "GET /disputes/:id/messages",
  "GET /disputes/me",
  "POST /disputes",
  "POST /disputes/:id/messages",
  "DELETE /notifications/inbox/:id",
  "GET /notifications/inbox",
  "GET /notifications/inbox/:id/timeline",
  "GET /notifications/inbox/summary",
  "GET /notifications/me",
  "GET /notifications/preferences",
  "PATCH /notifications/inbox/:id/archive",
  "PATCH /notifications/inbox/:id/assign",
  "PATCH /notifications/inbox/:id/click",
  "PATCH /notifications/inbox/:id/read",
  "PATCH /notifications/inbox/:id/resolve",
  "PATCH /notifications/inbox/:id/snooze",
  "PATCH /notifications/inbox/read-all",
  "PATCH /notifications/preferences",
  "POST /notifications/inbox/bulk",
  "POST /notifications/me/:id/read",
  "POST /notifications/me/fcm",
  "POST /notifications/me/read-all",
  "GET /orders/me",
  "GET /orders/me/:id",
  "GET /orders/me/:id/invoice.pdf",
  "POST /orders",
  "POST /orders/me/:id/cancel",
  "POST /orders/me/:id/reorder",
  "GET /partners/me/assignments",
  "GET /partners/me/earnings",
  "GET /partners/me/payouts",
  "GET /partners/me/performance",
  "POST /partners/:id/documents",
  "POST /partners/assignments/:id/accept",
  "POST /partners/assignments/:id/decline",
  "POST /partners/assignments/:id/deliver",
  "POST /partners/assignments/:id/fail",
  "POST /partners/assignments/:id/pickup",
  "POST /partners/me/online",
  "POST /partners/me/ping",
  "GET /payments/invoices/:orderId",
  "GET /payments/invoices/:orderId/pdf",
  "GET /payments/me",
  "POST /payments/:orderId/retry",
  "POST /payments/intent",
  "POST /payments/verify",
  "GET /promotions/coupons/auto-apply-best",
  "GET /promotions/gift-cards/my-cards",
  "GET /promotions/me/loyalty",
  "POST /promotions/coupons/apply",
  "POST /promotions/coupons/eligible",
  "POST /promotions/gift-cards/claim",
  "POST /promotions/gift-cards/validate",
  "POST /promotions/me/loyalty/redeem",
  "POST /promotions/me/referral",
  "POST /promotions/pricing/preview",
  "POST /promotions/promotions/resolve",
  "GET /returns/me",
  "GET /returns/replacement-availability/:orderItemId",
  "POST /returns",
  "POST /returns/:id/exchange",
  "POST /returns/:id/media",
  "POST /returns/batch",
  "DELETE /reviews/:id",
  "GET /reviews/me",
  "GET /reviews/my-votes",
  "PATCH /reviews/:id",
  "POST /reviews/:id/helpful",
  "POST /reviews/delivery/:shipmentId",
  "POST /reviews/products/:variantId",
  "GET /shipments/:id",
  "GET /shipments/:id/location",
  "POST /shipments/:id/drop-pin",
  "POST /shipments/:id/pod",
  "GET /support/tickets/:id/messages",
  "GET /support/tickets/me",
  "POST /support/tickets",
  "POST /support/tickets/:id/message",
  "POST /uploads",
  "DELETE /users/me/addresses/:id",
  "DELETE /users/me/payment-methods/:id",
  "GET /users/me",
  "GET /users/me/addresses",
  "GET /users/me/payment-methods",
  "PATCH /users/me",
  "PATCH /users/me/addresses/:id",
  "POST /users/me/addresses",
  "POST /users/me/payment-methods",
  "GET /wallet/me",
  "GET /wallet/me/transactions",
  "DELETE /wishlist/items/:id",
  "GET /wishlist",
  "POST /wishlist/back-in-stock-alerts",
  "POST /wishlist/items",
  "POST /wishlist/price-drop-alerts",
  "POST /wishlist/toggle",
]);

/** A route the audit considers unaccounted for. */
export interface UngatedRoute {
  method: string;
  path: string;
  controller: string;
  handler: string;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD", "SEARCH"];

/**
 * Walk every registered route and return those that are neither public, nor
 * permission-gated, nor on the self-service list above.
 *
 * Reflection over the Nest container rather than a source-code scan, so it
 * sees what the application actually registered — decorators applied through
 * mixins, inherited controllers and all.
 */
export function auditRouteGates(app: { container: any }): UngatedRoute[] {
  // Imported lazily so this module stays cheap to require from tests.
  const { PATH_METADATA, METHOD_METADATA } = require("@nestjs/common/constants");
  const ungated: UngatedRoute[] = [];

  for (const [, mod] of app.container.getModules()) {
    for (const [, wrapper] of mod.controllers) {
      const Ctrl = wrapper.metatype;
      if (!Ctrl) continue;

      const basePaths = ([] as string[]).concat(Reflect.getMetadata(PATH_METADATA, Ctrl) ?? "");
      const clsPerm = Reflect.getMetadata("permissions", Ctrl);
      const clsAny = Reflect.getMetadata("any_permissions", Ctrl);
      const clsPublic = Reflect.getMetadata("isPublic", Ctrl);

      for (const name of Object.getOwnPropertyNames(Ctrl.prototype)) {
        if (name === "constructor") continue;
        const fn = (Ctrl.prototype as Record<string, unknown>)[name];
        const methodPath = Reflect.getMetadata(PATH_METADATA, fn as object);
        if (methodPath === undefined) continue;

        // Handler metadata wins over the controller's, matching how
        // `reflector.getAllAndOverride([handler, class])` resolves it.
        const perm = Reflect.getMetadata("permissions", fn as object) ?? clsPerm;
        const any = Reflect.getMetadata("any_permissions", fn as object) ?? clsAny;
        const isPublic = Reflect.getMetadata("isPublic", fn as object) ?? clsPublic;
        if (isPublic || perm?.length || any?.length) continue;

        const idx = Reflect.getMetadata(METHOD_METADATA, fn as object);
        const method = HTTP_METHODS[idx] ?? String(idx);

        for (const base of basePaths) {
          for (const mp of ([] as string[]).concat(methodPath)) {
            const path = `/${base}/${mp}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
            if (SELF_SERVICE_ROUTES.has(`${method} ${path}`)) continue;
            ungated.push({ method, path, controller: Ctrl.name, handler: name });
          }
        }
      }
    }
  }

  return ungated;
}
