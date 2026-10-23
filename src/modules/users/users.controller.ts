import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectModel } from "@nestjs/sequelize";
import { Op } from "sequelize";
import { User, UserAddress, UserPaymentMethod } from "@/models";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { JwtPayload } from "@/modules/auth/jwt.strategy";
import { PageOptionsDto } from "@/common/dto/page-options.dto";
import { paginate, findOr404 } from "@/common/utils/crud.util";
import { AddressDto, UpdateAddressDto, PaymentMethodDto, UpdateProfileDto } from "@/common/dto/common.dto";
import { normalizeEmail } from "@/common/utils/email.util";
import { ConflictException, NotFoundException } from "@/common/errors/http";

@ApiTags("Users")
@ApiBearerAuth()
@Controller("users")
export class UsersController {
  constructor(
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(UserAddress) private addressModel: typeof UserAddress,
    @InjectModel(UserPaymentMethod) private pmModel: typeof UserPaymentMethod,
  ) {}

  @Get("me")
  me(@CurrentUser() u: JwtPayload) { return findOr404(this.userModel, u.sub, "User"); }

  @Patch("me")
  async update(@CurrentUser() u: JwtPayload, @Body() body: UpdateProfileDto) {
    const patch: Record<string, unknown> = { ...body };

    // Email is not just another string on this form. It is the identity the
    // customer signs in with, `users.email` is NOT NULL and UNIQUE, and every
    // auth lookup keys on the lowercased form — so it is normalised, checked
    // for a clash, and re-verified here rather than written through blindly.
    if (typeof body.email === "string") {
      const email = normalizeEmail(body.email);
      const current = await this.userModel.findByPk(u.sub);

      if (!current || email === normalizeEmail(current.email ?? "")) {
        // Nothing actually changed. Dropped so that re-saving the form does not
        // clear emailVerified for an address the customer already proved.
        delete patch.email;
      } else {
        const taken = await this.userModel.findOne({
          where: { email, id: { [Op.ne]: u.sub } },
        });
        if (taken) {
          throw new ConflictException(
            "AUTH_EMAIL_TAKEN",
            "That email is already used by another account.",
          );
        }
        patch.email = email;
        // A newly typed address is unproven. Leaving the old flag set would
        // mark mail to an unconfirmed mailbox as verified.
        patch.emailVerified = false;
      }
    }

    // The phone is proof of identity too: phone OTP signs in to whichever
    // account holds the number, and cash on delivery trusts phoneVerified. A
    // number typed here is unproven, so it clears the flag — it used to carry
    // the old number's verification over to any number the customer chose.
    if (typeof body.phone === "string") {
      const phone = body.phone.trim() || null;
      const current = await this.userModel.findByPk(u.sub);
      if (!current || phone === (current.phone ?? null)) {
        delete patch.phone;
      } else {
        if (phone && (await this.userModel.findOne({ where: { phone, id: { [Op.ne]: u.sub } } }))) {
          throw new ConflictException("CONFLICT", "That mobile number is already used by another account.");
        }
        patch.phone = phone;
        patch.phoneVerified = false;
      }
    }

    if (Object.keys(patch).length === 0) return this.userModel.findByPk(u.sub);

    try {
      await this.userModel.update(patch, { where: { id: u.sub } });
    } catch (e: any) {
      // Two people submitting the same new address or number at once lose the
      // race on the unique index instead of the checks above. Same answer, not a 500.
      if (e?.name === "SequelizeUniqueConstraintError") {
        if (e?.fields && "phone" in e.fields) {
          throw new ConflictException("CONFLICT", "That mobile number is already used by another account.");
        }
        throw new ConflictException(
          "AUTH_EMAIL_TAKEN",
          "That email is already used by another account.",
        );
      }
      throw e;
    }
    return this.userModel.findByPk(u.sub);
  }

  @Get("me/addresses")
  addresses(@CurrentUser() u: JwtPayload, @Query() opts: PageOptionsDto) {
    return paginate(this.addressModel, opts, { userId: u.sub });
  }

  @Post("me/addresses")
  async addAddress(@CurrentUser() u: JwtPayload, @Body() body: AddressDto) {
    const sequelize = this.addressModel.sequelize!;
    return sequelize.transaction(async (t) => {
      // Only one default per user: clear the previous default before adding a
      // new one flagged default.
      if (body.isDefault) {
        await this.addressModel.update({ isDefault: false }, { where: { userId: u.sub }, transaction: t });
      }
      return this.addressModel.create({ ...body, userId: u.sub } as any, { transaction: t });
    });
  }

  @Patch("me/addresses/:id")
  async updateAddress(@CurrentUser() u: JwtPayload, @Param("id") id: string, @Body() body: UpdateAddressDto) {
    const sequelize = this.addressModel.sequelize!;
    return sequelize.transaction(async (t) => {
      // The update below was already scoped to the caller, but the row it
      // returned was read by id alone — so PATCHing any address id returned
      // that stranger's full address. Resolve ownership first; "not yours"
      // and "no such address" are the same 404.
      const own = await this.addressModel.findOne({ where: { id, userId: u.sub }, transaction: t });
      if (!own) throw new NotFoundException("NOT_FOUND", "Address not found");
      // Promoting this address to default demotes every other one. Covers the
      // "Set default" action too (it PATCHes isDefault: true here).
      if (body.isDefault) {
        await this.addressModel.update(
          { isDefault: false },
          { where: { userId: u.sub, id: { [Op.ne]: id } }, transaction: t },
        );
      }
      await this.addressModel.update(body, { where: { id, userId: u.sub }, transaction: t });
      return this.addressModel.findOne({ where: { id, userId: u.sub }, transaction: t });
    });
  }

  @Delete("me/addresses/:id")
  async deleteAddress(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    await this.addressModel.destroy({ where: { id, userId: u.sub } });
    return { removed: true };
  }

  /**
   * Saved cards, minus the token.
   *
   * `gatewayToken` is the value that lets the holder charge the card again; it
   * belongs on the server and nowhere else. The whole row was being returned,
   * so the browser — and anything with XSS on the page — held a reusable
   * payment credential. The card label is all the UI ever renders.
   */
  @Get("me/payment-methods")
  pms(@CurrentUser() u: JwtPayload) {
    return this.pmModel.findAll({
      where: { userId: u.sub },
      attributes: ["id", "type", "brand", "last4", "expiryMonthYear", "upiId", "isDefault", "createdAt"],
    });
  }

  @Post("me/payment-methods")
  async addPm(@CurrentUser() u: JwtPayload, @Body() body: PaymentMethodDto) {
    const pm = await this.pmModel.create({ ...body, userId: u.sub } as any);
    // Same columns the list returns: the gateway token stays server-side.
    const { gatewayToken, ...safe } = pm.toJSON() as any;
    return safe;
  }

  @Delete("me/payment-methods/:id")
  async delPm(@CurrentUser() u: JwtPayload, @Param("id") id: string) {
    await this.pmModel.destroy({ where: { id, userId: u.sub } });
    return { removed: true };
  }
}
