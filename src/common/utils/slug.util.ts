import { Model, ModelStatic } from "sequelize-typescript";
import { Op } from "sequelize";

/**
 * Automatically generates a valid and unique slug based on a string.
 *
 * @param modelClass The Sequelize model class (e.g., Product, Category).
 * @param text The base text to generate a slug from (e.g., 'Kadumanga (Tender Mango Pickle)').
 * @param currentId Optional. The ID of the current instance to ignore when checking uniqueness (for updates).
 * @returns A unique slug string.
 */
export async function generateUniqueSlug(
  modelClass: any,
  text: string,
  currentId?: string
): Promise<string> {
  if (!text) return "";

  // 1. Basic formatting: Lowercase, replace non-alphanumeric with hyphens
  let baseSlug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // Replace spaces and special characters with hyphens
    .replace(/^-+|-+$/g, ""); // Remove leading and trailing hyphens

  if (!baseSlug) {
    baseSlug = "item"; // Fallback if text is weird
  }

  // 2. Loop to find a unique slug
  let uniqueSlug = baseSlug;
  let counter = 1;

  while (true) {
    // Check if the slug exists
    const whereClause: any = { slug: uniqueSlug };
    if (currentId) {
      whereClause.id = { [Op.ne]: currentId };
    }

    const count = await modelClass.count({
      where: whereClause,
      paranoid: false, // Check soft-deleted records too to avoid collision if restored
    });

    if (count === 0) {
      return uniqueSlug; // No collision found
    }

    // Collision found, append number and check again
    uniqueSlug = `${baseSlug}-${counter}`;
    counter++;
  }
}
