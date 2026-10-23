import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { Server, Socket } from "socket.io";
import * as jwt from "jsonwebtoken";
import { env } from "@/config/env";
import { logger } from "@/common/utils/logger";
import { Role } from "@/common/enums/role.enum";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { DeliveryAssignment, DeliveryLocationPing, DeliveryPartner, Order, OrderShipment, OrderStatusHistory, User } from "@/models";
import { expandCorsOrigins } from "@/common/utils/cors-origins.util";
import { ShipmentAccessModule, ShipmentAccessService } from "@/common/services/shipment-access.service";
import { RbacCacheService } from "@/modules/rbac/rbac-cache.service";
import { hasPermission } from "@/common/utils/permission.util";
import { OrderStatus } from "@/common/enums/order-status.enum";

/** The statuses a shipment can actually be in — the only ones worth announcing. */
const SHIPMENT_STATUSES = new Set<string>(Object.values(OrderStatus));

@Injectable()
@WebSocketGateway({ cors: { origin: expandCorsOrigins(env.CORS_ORIGINS), credentials: true } })
export class TrackingGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  @WebSocketServer() server!: Server;

  constructor(
    @InjectModel(Order) private order: typeof Order,
    @InjectModel(OrderShipment) private ship: typeof OrderShipment,
    @InjectModel(DeliveryPartner) private partner: typeof DeliveryPartner,
    @InjectModel(DeliveryAssignment) private assign: typeof DeliveryAssignment,
    @InjectModel(DeliveryLocationPing) private ping: typeof DeliveryLocationPing,
    @InjectModel(User) private users: typeof User,
    private access: ShipmentAccessService,
    private rbac: RbacCacheService,
  ) {}

  /**
   * Every shipment status change — shop accept/pack/dispatch, partner
   * pickup/deliver/fail, cancellations — writes one history row naming the
   * shipment. Pushing from that row reaches the order pages' live view
   * (`shipment:status`) once per real change, without each of those handlers
   * having to remember to.
   */
  onModuleInit() {
    OrderStatusHistory.onShipmentStatus = (row) => {
      this.server?.to(`shipment:${row.shipmentId}`).emit("shipment:status", {
        shipmentId: row.shipmentId,
        orderId: row.orderId,
        status: row.status,
        ts: Date.now(),
      });
    };
  }

  /**
   * Admit a socket only for a live account presenting a current access token.
   *
   * A valid signature is not enough. HTTP requests re-check the account on
   * every call (JwtStrategy: active, tokenVersion); this used to trust the
   * signature alone, so a deactivated account, or a session ended by logout or
   * a password reset, kept receiving every live update until the token
   * expired. Role, shop and permissions are read from the database, not from
   * claims in the token, so a demotion takes effect at the next connection.
   *
   * The token comes from the handshake `auth` payload or an Authorization
   * header — never the query string, which ends up in proxy and access logs.
   */
  async handleConnection(socket: Socket) {
    try {
      const header = socket.handshake.headers?.authorization;
      const token = socket.handshake.auth?.token || (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
      if (!token || typeof token !== "string") throw new Error("missing token");
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload & { type?: string };
      if (payload.type && payload.type !== "access") throw new Error("not an access token");

      const account = await this.users.findByPk(payload.sub, { attributes: ["id", "role", "roleId", "shopId", "email", "isActive", "tokenVersion"] });
      if (!account || !account.isActive) throw new Error("inactive account");
      if ((payload.tv ?? 0) !== (account.tokenVersion ?? 0)) throw new Error("revoked session");
      const { permissions } = await this.rbac.getPermissionsForUser(account);

      const user: JwtPayload = { sub: account.id, role: account.role, email: account.email, shopId: account.shopId ?? undefined, tv: account.tokenVersion, permissions } as JwtPayload;
      (socket.data as any).user = user;
      logger.info(`Socket connected: ${socket.id} (user ${user.sub})`);

      socket.join(`user:${user.sub}`);
      if (user.role === Role.ADMIN) socket.join("admin:all");
      if (user.role === Role.SHOP_MANAGER && user.shopId) socket.join(`shop:${user.shopId}`);
    } catch (err) {
      logger.warn(`Socket rejected (${(err as Error).message}): ${socket.id}`);
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket) { logger.info(`Socket disconnected: ${socket.id}`); }

  private user(socket: Socket): JwtPayload | undefined {
    return (socket.data as any).user as JwtPayload | undefined;
  }

  /**
   * Delegates to the shared service. This logic used to live here and only
   * here, which is why the REST controller for the same data shipped with no
   * check at all — there was nothing to reuse.
   */
  private canViewShipment(u: JwtPayload, shipmentId: string): Promise<boolean> {
    return this.access.canView(u, shipmentId);
  }

  /** Staff who administer partners, or the partner themselves. */
  private async ownsPartner(u: JwtPayload, partnerId: string): Promise<boolean> {
    if (hasPermission(u, "deliveryPartners.view")) return true;
    const me = await this.partner.findByPk(partnerId, { attributes: ["id", "userId"] });
    return !!me && me.userId === u.sub;
  }

  @SubscribeMessage("shipment:subscribe")
  async subShip(@ConnectedSocket() s: Socket, @MessageBody() shipmentId: string) {
    const u = this.user(s);
    if (!u || !(await this.canViewShipment(u, shipmentId))) {
      s.emit("error", { event: "shipment:subscribe", message: "not authorized" });
      return;
    }
    s.join(`shipment:${shipmentId}`);
    s.emit("shipment:subscribed", { shipmentId });
  }

  @SubscribeMessage("partner:subscribe")
  async subPartner(@ConnectedSocket() s: Socket, @MessageBody() partnerId: string) {
    const u = this.user(s);
    // Staff and the partner themselves may watch a partner's live location.
    if (!u || !(await this.ownsPartner(u, partnerId))) {
      s.emit("error", { event: "partner:subscribe", message: "not authorized" });
      return;
    }
    s.join(`partner:${partnerId}`);
    s.emit("partner:subscribed", { partnerId });
  }

  @SubscribeMessage("partner:ping")
  async ping1(@ConnectedSocket() s: Socket, @MessageBody() data: { lat: number; lng: number }) {
    const u = this.user(s);
    if (!u || u.role !== Role.DELIVERY_PARTNER) return;
    // Every ping writes a row and fans out to customers' maps: a real
    // coordinate only, and at most one every two seconds per connection.
    const lat = Number(data?.lat), lng = Number(data?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    const now = Date.now();
    if (now - ((s.data as any).lastPingAt ?? 0) < 2000) return;
    (s.data as any).lastPingAt = now;
    data = { lat, lng };
    const me = await this.partner.findOne({ where: { userId: u.sub } });
    if (!me) return;
    await me.update({ currentLat: data.lat, currentLng: data.lng });
    await this.ping.create({ partnerId: me.id, lat: data.lat, lng: data.lng } as any);
    await this.broadcastPartnerLocation(me.id, data.lat, data.lng);
  }

  /**
   * Fan a rider's position out to whoever may watch it. Shared by the socket
   * ping above and the partner app's HTTP ping (POST partners/me/ping), which
   * used to store the position and tell nobody.
   */
  async broadcastPartnerLocation(partnerId: string, lat: number, lng: number) {
    if (!this.server) return;
    const at = { partnerId, lat, lng, ts: Date.now() };

    // The partner room, for anyone watching this rider specifically (ops).
    this.server.to(`partner:${partnerId}`).emit("partner:location", at);

    // And the room for each shipment they are currently carrying.
    //
    // This is the half that was missing, and why live tracking never worked:
    // customers join `shipment:{id}` (that is the only room `shipment:subscribe`
    // offers them) and both tracking pages discard any location without a
    // `shipmentId`. The ping only ever reached `partner:{id}`, which no
    // customer can join, carrying a payload with no `shipmentId` in it — so
    // every pin fell back to the static drop-off marker.
    // "accepted" and "picked" are the in-transit states in the assignment enum
    // (delivery.model.ts) — the rider is on the way, so the customer's map
    // should move.
    const carrying = await this.assign.findAll({
      where: { partnerId, status: ["accepted", "picked"] as any },
      attributes: ["shipmentId"],
    });
    for (const a of carrying) {
      if (!a.shipmentId) continue;
      this.server.to(`shipment:${a.shipmentId}`).emit("partner:location", { ...at, shipmentId: a.shipmentId });
    }
  }

  @SubscribeMessage("shipment:status")
  async status(@ConnectedSocket() s: Socket, @MessageBody() data: { shipmentId: string; status: string }) {
    const u = this.user(s);
    // Only those who may CHANGE the shipment (its shop, fulfilment staff, the
    // assigned rider) may announce a status into its room — not everyone who
    // can view it — and only a real status: the payload used to be spread
    // through as sent, so any field reached every customer watching.
    if (!u || typeof data?.shipmentId !== "string" || !SHIPMENT_STATUSES.has(data?.status)) return;
    if (!(await this.access.canAct(u, data.shipmentId))) return;
    this.server.to(`shipment:${data.shipmentId}`).emit("shipment:status", { shipmentId: data.shipmentId, status: data.status, ts: Date.now() });
  }

  // --- Real-time Push Helper Methods ---

  emitToUser(userId: string, event: string, data: any) {
    if (this.server) {
      this.server.to(`user:${userId}`).emit(event, data);
    }
  }

  emitToAdmins(event: string, data: any) {
    if (this.server) {
      this.server.to("admin:all").emit(event, data);
    }
  }

  emitToShop(shopId: string, event: string, data: any) {
    if (this.server) {
      this.server.to(`shop:${shopId}`).emit(event, data);
    }
  }
}

@Module({
  imports: [SequelizeModule.forFeature([Order, OrderShipment, DeliveryPartner, DeliveryAssignment, DeliveryLocationPing, User]), ShipmentAccessModule],
  providers: [TrackingGateway],
  exports: [TrackingGateway],
})
export class TrackingModule {}
