import type { AdminPageDefinition } from '@zucker-framework/fe-admin';
import { TicketPercent } from 'lucide-react';
import { PromotionsPage } from './promotions-page';

/**
 * Promo code administration (WP 3.4). Register with `...promotionPages` in `features/index.ts`; the
 * menu entry comes from the server's menu records (`/promotions`, `promotions:query`). Creating,
 * editing/disabling and deleting need `promotions:create`, `promotions:update` and `promotions:delete`.
 */
export const promotionPages: AdminPageDefinition[] = [
  {
    key: 'promotions',
    path: '/promotions',
    title: { 'zh-CN': '优惠码', 'en-US': 'Promotions' },
    permission: 'promotions:query',
    component: PromotionsPage,
    icon: TicketPercent,
  },
];

export { PromotionsPage, promotionBody, emptyPromotionDraft, PROMOTIONS_PATH, type PromotionRecord, type PromotionDraft } from './promotions-page';
