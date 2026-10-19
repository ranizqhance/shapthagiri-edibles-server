/**
 * Shared builder for delivery-partner creation attributes. Used by BOTH partner
 * creation paths — `AdminController.createUser` (Invite Member) and
 * `PartnersController.onboard` (self-serve) — so their field mapping and the
 * `bank` JSONB (which the UI reads) never drift apart.
 */
export interface DeliveryPartnerInput {
  userId: string;
  name?: string | null;
  phone?: string | null;
  vehicle?: string | null;
  vehicleNumber?: string | null;
  avatarUrl?: string | null;
  address?: string | null;
  city?: string | null;
  zoneId?: string | null;
  licenseNumber?: string | null;
  bankAccountNumber?: string | null;
  bankIfscCode?: string | null;
  bankName?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
}

/** The `bank` JSONB shape the Delivery Partner UI reads (bankName / accountNumber). */
export function buildPartnerBank(input: Pick<DeliveryPartnerInput, "bankAccountNumber" | "bankIfscCode" | "bankName">) {
  if (!input.bankAccountNumber && !input.bankName && !input.bankIfscCode) return null;
  return {
    bankName: input.bankName ?? null,
    accountNumber: input.bankAccountNumber ?? null,
    ifsc: input.bankIfscCode ?? null,
  };
}

/** A document to attach to a partner at creation time. */
export interface PartnerDocumentInput {
  type: string;
  url: string;
  expiresAt?: string | null;
}

/**
 * Insert partner documents inside the caller's transaction. Shared by both the
 * Invite (`createUser`) and self-serve (`onboard`) paths so document rows are
 * created identically. Documents are always created as `pending` — an admin
 * verifies them afterwards through the existing partner drawer.
 */
export async function createPartnerDocuments(
  docModel: any,
  partnerId: string,
  documents: PartnerDocumentInput[] | undefined | null,
  transaction: any,
) {
  for (const d of documents ?? []) {
    await docModel.create(
      { partnerId, type: d.type, url: d.url, status: "pending", expiresAt: d.expiresAt ?? null },
      { transaction },
    );
  }
}

/** Default attributes for a newly created (pending) delivery partner. */
export function buildDeliveryPartnerDefaults(input: DeliveryPartnerInput) {
  return {
    userId: input.userId,
    name: input.name ?? "",
    phone: (input.phone ?? "").trim(),
    vehicle: input.vehicle ?? null,
    vehicleNumber: input.vehicleNumber ?? null,
    avatarUrl: input.avatarUrl ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    zoneId: input.zoneId ?? null,
    licenseNumber: input.licenseNumber ?? null,
    bankAccountNumber: input.bankAccountNumber ?? null,
    bankIfscCode: input.bankIfscCode ?? null,
    bank: buildPartnerBank(input),
    emergencyContactName: input.emergencyContactName ?? null,
    emergencyContactPhone: input.emergencyContactPhone ?? null,
    status: "pending",
    isOnline: false,
    rating: 5,
    totalDeliveries: 0,
    todayJobs: 0,
    todayEarnings: 0,
  };
}
