export { PromotionsModule } from './promotions.module';
export { PromotionsService, PROMOTION_RESERVATION_TTL_MS } from './promotions.service';
export { computePromotion, parsePromotion, type PromotionRow, type PromotionInput } from './promotions.validation';
/** Permission codes seeded for the back office (`BACK_OFFICE_PERMISSIONS`). */
export const PROMOTION_PERMISSIONS = ['promotions:query', 'promotions:create', 'promotions:update', 'promotions:delete'] as const;
