import { Injectable, Module } from "@nestjs/common";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { DeliveryAssignment, DeliveryPartner, Order, OrderShipment } from "@/models";
import { Role } from "@/common/enums/role.enum";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { hasPermission } from "@/common/utils/permission.util";

/**
 * Who may see, and who may act on, a shipment.
 *
 * This logic already existed and was already correct — on the WebSocket
 * gateway, as `canViewShipment`. The REST controller for the same data simply
 * never called it: `GET /shipments/:id` and `/:id/location` were `@Public()`,
 * so a bare UUID returned the whole shipment row, its status history, the
 * proof of delivery and the delivery rider's last GPS ping to anyone. Live, an
 * unknown id answered 404 rather than 401, which is how you can tell the route
 * was open rather than merely failing.
 *
 * Extracted here rather than copied so the socket and the HTTP route can never
 * drift into two different answers to the same question.
 *
 * Public order tracking is unaffected: it goes through the HMAC-signed
 * `GET /orders/lookup/:token` route, which carries its own proof and is
 * already correct.
 */
@Injectable()
export class ShipmentAccessService {
  constructor(
    @InjectModel(Order) private order: typeof Order,
    @InjectModel(OrderShipment) private ship: typeof OrderShipment,
    @InjectModel(DeliveryPartner) private partner: typeof DeliveryPartner,
    @InjectModel(DeliveryAssignment) private assign: typeof DeliveryAssignment,
  ) {}

  /** May this caller READ the shipment? */
  async canView(u: JwtPayload, shipmentId: string): Promise<boolean> {
    const shipment = await this.ship.findByPk(shipmentId);
    if (!shipment) return false;

    // Shop-scoped staff see their own shop, whatever else they hold.
    if (u.role === Role.SHOP_MANAGER || u.shopId) return !!u.shopId && shipment.shopId === u.shopId;
    // Platform staff: judged by RBAC permission, not by the legacy role enum.
    // Every custom role is stored with the enum value `support`, so the old
    // role list let any custom role see every shipment on the platform.
    if (hasPermission(u, "fulfillment.view", "orders.view")) return true;

    // The customer who ordered it, and the rider assigned to it — by fact, not
    // by role.
    const order = await this.order.findByPk(shipment.orderId, { attributes: ["id", "userId"] });
    if (order && order.userId === u.sub) return true;
    return this.isAssigned(u, shipmentId);
  }

  /**
   * May this caller CHANGE the shipment — record a proof of delivery, move the
   * drop pin?
   *
   * Narrower than `canView` on purpose. A customer can watch their parcel; they
   * must not be able to mark it delivered. Both routes previously accepted any
   * authenticated user at all, so a freshly registered account could forge a
   * POD against any shipment on the platform, or move its delivery
   * coordinates.
   */
  async canAct(u: JwtPayload, shipmentId: string): Promise<boolean> {
    if (u.role === Role.SHOP_MANAGER || u.shopId) {
      const shipment = await this.ship.findByPk(shipmentId, { attributes: ["id", "shopId"] });
      return !!shipment && !!u.shopId && shipment.shopId === u.shopId;
    }
    if (hasPermission(u, "fulfillment.ship")) return true;
    return this.isAssigned(u, shipmentId);
  }

  private async isAssigned(u: JwtPayload, shipmentId: string): Promise<boolean> {
    const me = await this.partner.findOne({ where: { userId: u.sub } });
    if (!me) return false;
    const assignment = await this.assign.findOne({ where: { shipmentId, partnerId: me.id } });
    return !!assignment;
  }
}

@Module({
  imports: [SequelizeModule.forFeature([Order, OrderShipment, DeliveryPartner, DeliveryAssignment])],
  providers: [ShipmentAccessService],
  exports: [ShipmentAccessService],
})
export class ShipmentAccessModule {}
