import { Body, Controller, Get, Module, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { DeliveryAssignment, DeliveryLocationPing, OrderShipment, OrderStatusHistory, ProofOfDelivery } from "@/models";
import { findOr404 } from "@/common/utils/crud.util";
import { DropPinDto, PodDto } from "@/common/dto/common.dto";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { ForbiddenException } from "@/common/errors/http";
import { ShipmentAccessModule, ShipmentAccessService } from "@/common/services/shipment-access.service";

/**
 * Every route here is authenticated and ownership-checked.
 *
 * `GET :id` and `GET :id/location` used to be `@Public()` with no check of any
 * kind, so a shipment UUID was the only thing standing between an outsider and
 * the full shipment record — status history, proof of delivery, and the
 * delivery rider's last known GPS position. The two POST routes were
 * authenticated but equally unscoped: any account, including one registered a
 * minute earlier, could file a proof of delivery against someone else's parcel
 * or move its drop pin.
 *
 * Customers who are not signed in still track orders through
 * `GET /orders/lookup/:token`, which carries an HMAC-signed token instead of
 * relying on a UUID being hard to guess.
 */
@ApiTags("Shipments")
@ApiBearerAuth()
@Controller("shipments")
export class ShipmentsController {
  constructor(
    @InjectModel(OrderShipment) private ship: typeof OrderShipment,
    @InjectModel(OrderStatusHistory) private hist: typeof OrderStatusHistory,
    @InjectModel(ProofOfDelivery) private pod: typeof ProofOfDelivery,
    @InjectModel(DeliveryAssignment) private assign: typeof DeliveryAssignment,
    @InjectModel(DeliveryLocationPing) private ping: typeof DeliveryLocationPing,
    private access: ShipmentAccessService,
  ) {}

  /**
   * Answer 403 rather than 404 for a shipment the caller may not see.
   *
   * `canView` returns false both for "does not exist" and "not yours", and
   * `findOr404` below turns the first into a 404 anyway — so distinguishing
   * them here would hand an attacker a shipment-id oracle.
   */
  private async assertCanView(u: JwtPayload, id: string) {
    if (!(await this.access.canView(u, id))) throw new ForbiddenException("AUTH_FORBIDDEN");
  }

  private async assertCanAct(u: JwtPayload, id: string) {
    if (!(await this.access.canAct(u, id))) throw new ForbiddenException("AUTH_FORBIDDEN");
  }

  @Get(":id") async detail(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    await this.assertCanView(u, id);
    const shipment = await findOr404<OrderShipment>(this.ship, id, "Shipment");
    return {
      shipment,
      history: await this.hist.findAll({ where: { shipmentId: id }, order: [["createdAt","ASC"]] }),
      pod: await this.pod.findOne({ where: { shipmentId: id } }),
    };
  }

  @Get(":id/location") async location(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    await this.assertCanView(u, id);
    const a = await this.assign.findOne({ where: { shipmentId: id } });
    if (!a) return null;
    return this.ping.findOne({ where: { partnerId: a.partnerId }, order: [["createdAt","DESC"]] });
  }

  @Post(":id/pod") async pod1(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: PodDto) {
    await this.assertCanAct(u, id);
    await findOr404<OrderShipment>(this.ship, id, "Shipment");
    return this.pod.create({ shipmentId: id, ...b } as any);
  }

  @Post(":id/drop-pin") async drop(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() b: DropPinDto) {
    await this.assertCanAct(u, id);
    const shipment = await findOr404<OrderShipment>(this.ship, id, "Shipment");
    await shipment.update({ dropLat: b.lat, dropLng: b.lng });
    return { shipmentId: id, dropLat: b.lat, dropLng: b.lng, accepted: true };
  }
}

@Module({
  imports: [
    SequelizeModule.forFeature([OrderShipment, OrderStatusHistory, ProofOfDelivery, DeliveryAssignment, DeliveryLocationPing]),
    ShipmentAccessModule,
  ],
  controllers: [ShipmentsController],
})
export class ShipmentsModule {}
