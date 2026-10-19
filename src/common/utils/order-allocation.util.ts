/**
 * Proportional per-line allocation of an order's split components
 * (REFUND_WALLET_POLICY_WORKFLOW §2, §6). Shared by order placement
 * (persists the snapshot) and the refund engine (legacy fallback) so the
 * proportion math lives in exactly one place.
 *
 * Each component is allocated by line gross-value weight; rounding drift is
 * absorbed by the last line so Σ(line allocations) == the order component exactly.
 */
const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export interface OrderSplitInput {
  discount?: number;        // coupon
  loyaltyDiscount?: number; // loyalty redeemed
  giftCardDiscount?: number;
  tax?: number;
  deliveryFee?: number;
  walletAmount?: number;
  payableAmount?: number;   // cash / card / UPI / COD
}

export interface LineAllocation {
  lineGross: number;
  allocatedCoupon: number;
  allocatedLoyalty: number;
  allocatedGiftCard: number;
  allocatedTax: number;
  allocatedDelivery: number;
  allocatedWallet: number;
  allocatedCash: number;
  /** The only refundable share of the line = allocatedWallet + allocatedCash. */
  lineRefundableBase: number;
}

export interface AllocationLineInput { id?: string; price: number; quantity: number; }

/** Returns a Map keyed by item id (or stringified index) → its allocation. */
export function computeLineAllocations(items: AllocationLineInput[], split: OrderSplitInput): Map<string, LineAllocation> {
  const totalGross = items.reduce((s, it) => s + Number(it.price) * Number(it.quantity), 0);
  const shares = items.map((it) => (totalGross > 0 ? (Number(it.price) * Number(it.quantity)) / totalGross : 0));

  const components: Record<string, number> = {
    coupon: Number(split.discount || 0),
    loyalty: Number(split.loyaltyDiscount || 0),
    giftCard: Number(split.giftCardDiscount || 0),
    tax: Number(split.tax || 0),
    delivery: Number(split.deliveryFee || 0),
    wallet: Number(split.walletAmount || 0),
    cash: Number(split.payableAmount || 0),
  };

  // Allocate each component with last-line drift correction (Σ == component total).
  const alloc: Record<string, number[]> = {};
  for (const key of Object.keys(components)) {
    const total = components[key];
    let running = 0;
    alloc[key] = items.map((_it, i) => {
      const a = i === items.length - 1 ? round2(total - running) : round2(total * shares[i]);
      running = round2(running + a);
      return a;
    });
  }

  const out = new Map<string, LineAllocation>();
  items.forEach((it, i) => {
    const allocatedWallet = alloc.wallet[i];
    const allocatedCash = alloc.cash[i];
    out.set(it.id ?? String(i), {
      lineGross: round2(Number(it.price) * Number(it.quantity)),
      allocatedCoupon: alloc.coupon[i],
      allocatedLoyalty: alloc.loyalty[i],
      allocatedGiftCard: alloc.giftCard[i],
      allocatedTax: alloc.tax[i],
      allocatedDelivery: alloc.delivery[i],
      allocatedWallet,
      allocatedCash,
      lineRefundableBase: round2(allocatedWallet + allocatedCash),
    });
  });
  return out;
}
