import { Injectable, Module } from "@nestjs/common";
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { InjectModel, SequelizeModule } from "@nestjs/sequelize";
import { Server, Socket } from "socket.io";
import * as jwt from "jsonwebtoken";
import { env } from "@/config/env";
import { logger } from "@/common/utils/logger";
import { Role } from "@/common/enums/role.enum";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { DeliveryAssignment, DeliveryLocationPing, DeliveryPartner, Order, OrderShipment } from "@/models";
import { ShipmentAccessModule, ShipmentAccessService } from "@/common/services/shipment-access.service";

const STAFF_ROLES = [Role.ADMIN, Role.OPERATIONS, Role.SUPPORT];

@Injectable()
@WebSocketGateway({ cors: { origin: env.CORS_ORIGINS.split(",").map((s) => s.trim()), credentials: true } })
export class TrackingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  constructor(
    @InjectModel(Order) private order: typeof Order,
    @InjectModel(OrderShipment) private ship: typeof OrderShipment,
    @InjectModel(DeliveryPartner) private partner: typeof DeliveryPartner,
    @InjectModel(DeliveryAssignment) private assign: typeof DeliveryAssignment,
    @InjectModel(DeliveryLocationPing) private ping: typeof DeliveryLocationPing,
    private access: ShipmentAccessService,
  ) {}

  /** Reject any socket that does not present a valid access token. */
  handleConnection(socket: Socket) {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) throw new Error("missing token");
      const payload = jwt.verify(token as string, env.JWT_ACCESS_SECRET) as JwtPayload;
      (socket.data as any).user = payload;
      logger.info(`Socket connected: ${socket.id} (user ${payload.sub})`);

      // Safe Auto-Join Rooms based on verified JWT token
      socket.join(`user:${payload.sub}`);
      
      if (payload.role === Role.ADMIN) {
        socket.join("admin:all");
        logger.info(`Socket ${socket.id} joined room admin:all`);
      }
      
      if (payload.role === Role.SHOP_MANAGER && payload.shopId) {
        socket.join(`shop:${payload.shopId}`);
        logger.info(`Socket ${socket.id} joined room shop:${payload.shopId}`);
      }
    } catch (err) {
      logger.warn(`Socket rejected (no/invalid token): ${socket.id}`);
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

  private async ownsPartner(u: JwtPayload, partnerId: string): Promise<boolean> {
    if (STAFF_ROLES.includes(u.role)) return true;
    if (u.role === Role.DELIVERY_PARTNER) {
      const me = await this.partner.findByPk(partnerId);
      return !!me && me.userId === u.sub;
    }
    return false;
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
    const me = await this.partner.findOne({ where: { userId: u.sub } });
    if (!me) return;
    await me.update({ currentLat: data.lat, currentLng: data.lng });
    await this.ping.create({ partnerId: me.id, lat: data.lat, lng: data.lng } as any);

    const at = { partnerId: me.id, lat: data.lat, lng: data.lng, ts: Date.now() };

    // The partner room, for anyone watching this rider specifically (ops).
    this.server.to(`partner:${me.id}`).emit("partner:location", at);

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
      where: { partnerId: me.id, status: ["accepted", "picked"] as any },
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
    // Only staff and the assigned partner may push status into a shipment room.
    if (!u || !(await this.canViewShipment(u, data.shipmentId)) || u.role === Role.CUSTOMER) return;
    this.server.to(`shipment:${data.shipmentId}`).emit("shipment:status", { ...data, ts: Date.now() });
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
  imports: [SequelizeModule.forFeature([Order, OrderShipment, DeliveryPartner, DeliveryAssignment, DeliveryLocationPing]), ShipmentAccessModule],
  providers: [TrackingGateway],
  exports: [TrackingGateway],
})
export class TrackingModule {}
