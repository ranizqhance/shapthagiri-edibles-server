/**
 * Who the shop is — the one place the server keeps its brand.
 *
 * Every customer-facing document the API renders (emails, the tax invoice,
 * settlement statements, finance reports, API docs) reads its name, contact
 * details and colours from here, so a rebrand is this file. Facts come from
 * the company's own material (ecommerce-web/assets/CONTENT.md) and match the
 * storefront's `lib/brand.ts`; the palette is the storefront's oil theme.
 *
 * GSTIN / FSSAI are not public yet: they live in the `business.gst` /
 * `business.fssai` settings and the invoice prints them only when set.
 */
export const BRAND = {
  /** what customers call the shop */
  name: "Shapthagiri Edibles",
  /** the company — tax documents and legal footers */
  legalName: "Shapthagiri Refineries",
  /** the wordmark on email and PDF headers */
  wordmark: "SHAPTHAGIRI",
  tagline: "Health & Purity, since 1987",
  brands: ["Pooram", "Dhwani"],
  addressLine: "Neelamkatchi, Vannamada, Palakkad, Kerala 678555",
  phone: "+91 94463 80334",
  landline: "04923-272674",
  email: "shapthagirirefineries@gmail.com",
  website: "www.shapthagiri-edibles.com",

  /*
   * Oil palette, picked in readable pairs:
   *   primary   — header bands and brand text on white (5.4:1)
   *   onPrimary — the tagline on a primary band
   *   amber     — rules and decorative edges only, never text on white
   */
  primary: "#965606",
  primaryDark: "#784204",
  onPrimary: "#FFE3A1",
  amber: "#D4920F",
  surface: "#FBF7EE",
  ink: "#1C1812",
  muted: "#766956",
  border: "#E5DAC5",
} as const;
