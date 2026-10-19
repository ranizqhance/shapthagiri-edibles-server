import { Injectable } from "@nestjs/common";
import { ProductPolicy } from "../../models/product-policy.model";
import { CategoryPolicy } from "../../models/category-policy.model";
import { GlobalPolicy } from "../../models/global-policy.model";
import { Op } from "sequelize";

export interface ResolvedPolicy {
  isReturnable: boolean;
  isReplaceable: boolean;
  returnWindowDays: number;
  replacementWindowDays: number;
  restockingFeeType: string;
  restockingFeeValue: number;
  requiresInspection: boolean;
  source: "PRODUCT" | "CATEGORY" | "GLOBAL";
}

@Injectable()
export class PolicyResolutionService {
  /**
   * Resolves the effective return/replacement policy by checking the hierarchy:
   * Product Policy -> Category Policy -> Global Policy
   */
  async resolvePolicy(productId: string, categoryId?: string): Promise<ResolvedPolicy> {
    // 1. Check Product Policy
    const productPolicy = await ProductPolicy.findOne({ where: { productId } });
    if (productPolicy) {
      return this.mapToResolvedPolicy(productPolicy, "PRODUCT");
    }

    // 2. Check Category Policy
    if (categoryId) {
      const categoryPolicy = await CategoryPolicy.findOne({ where: { categoryId } });
      if (categoryPolicy) {
        return this.mapToResolvedPolicy(categoryPolicy, "CATEGORY");
      }
    }

    // 3. Fallback to Global Policy
    const globalPolicy = await GlobalPolicy.findOne();
    if (globalPolicy) {
      return this.mapToResolvedPolicy(globalPolicy, "GLOBAL");
    }

    return this.getAbsoluteFallback();
  }

  /**
   * Bulk resolves policies to prevent N+1 queries.
   */
  async resolvePoliciesBulk(items: { productId: string; categoryId?: string }[]): Promise<Record<string, ResolvedPolicy>> {
    const productIds = [...new Set(items.map(i => i.productId))];
    const categoryIds = [...new Set(items.map(i => i.categoryId).filter(Boolean))] as string[];

    // Fetch all policies in 3 queries
    const [productPolicies, categoryPolicies, globalPolicy] = await Promise.all([
      ProductPolicy.findAll({ where: { productId: { [Op.in]: productIds } } }),
      categoryIds.length > 0 ? CategoryPolicy.findAll({ where: { categoryId: { [Op.in]: categoryIds } } }) : Promise.resolve([]),
      GlobalPolicy.findOne()
    ]);

    const productPolicyMap = new Map(productPolicies.map(p => [p.productId, p]));
    const categoryPolicyMap = new Map(categoryPolicies.map(p => [p.categoryId, p]));

    const results: Record<string, ResolvedPolicy> = {};

    for (const item of items) {
      const pp = productPolicyMap.get(item.productId);
      if (pp) {
        results[item.productId] = this.mapToResolvedPolicy(pp, "PRODUCT");
        continue;
      }

      if (item.categoryId) {
        const cp = categoryPolicyMap.get(item.categoryId);
        if (cp) {
          results[item.productId] = this.mapToResolvedPolicy(cp, "CATEGORY");
          continue;
        }
      }

      if (globalPolicy) {
        results[item.productId] = this.mapToResolvedPolicy(globalPolicy, "GLOBAL");
        continue;
      }

      results[item.productId] = this.getAbsoluteFallback();
    }

    return results;
  }

  private getAbsoluteFallback(): ResolvedPolicy {
    return {
      isReturnable: false,
      isReplaceable: false,
      returnWindowDays: 0,
      replacementWindowDays: 0,
      restockingFeeType: "NONE",
      restockingFeeValue: 0,
      requiresInspection: true,
      source: "GLOBAL",
    };
  }

  private mapToResolvedPolicy(policy: any, source: "PRODUCT" | "CATEGORY" | "GLOBAL"): ResolvedPolicy {
    return {
      isReturnable: policy.isReturnable,
      isReplaceable: policy.isReplaceable,
      returnWindowDays: policy.returnWindowDays,
      replacementWindowDays: policy.replacementWindowDays,
      restockingFeeType: policy.restockingFeeType,
      restockingFeeValue: Number(policy.restockingFeeValue),
      requiresInspection: policy.requiresInspection,
      source,
    };
  }
}
