import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ProductPolicy } from '../../models/product-policy.model';
import { ProductPolicyDto } from '../../common/dto/common.dto';

@Injectable()
export class ProductPolicyService {
  constructor(
    @InjectModel(ProductPolicy)
    private readonly productPolicyModel: typeof ProductPolicy,
  ) {}

  async upsertPolicy(productId: string, policyDto: ProductPolicyDto): Promise<void> {
    if (!policyDto) return;
    
    // We explicitly cast to handle optional boolean values properly.
    const defaults: any = { productId };
    if (policyDto.isReturnable !== undefined) defaults.isReturnable = policyDto.isReturnable;
    if (policyDto.isReplaceable !== undefined) defaults.isReplaceable = policyDto.isReplaceable;
    if (policyDto.returnWindowDays !== undefined) defaults.returnWindowDays = policyDto.returnWindowDays;


    if (Object.keys(defaults).length === 1) return; // Only productId

    const [policy, created] = await this.productPolicyModel.findOrCreate({
      where: { productId },
      defaults,
    });

    if (!created) {
      await policy.update(defaults);
    }
  }
}
