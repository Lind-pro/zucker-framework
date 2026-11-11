import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';

/**
 * Promo codes. Registers itself with BillingService (`usePromotions`) so billing never imports this
 * module; without it, checkout refuses every `promoCode` and no automatic promotion applies.
 */
@Module({
  imports: [BillingModule],
  controllers: [PromotionsController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
