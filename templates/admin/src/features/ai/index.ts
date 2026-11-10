import type { AdminPageDefinition } from '@zucker-framework/fe-admin';
import { Bot, Coins, MessagesSquare } from 'lucide-react';
import { AIPricingPage } from './pricing-page';
import { AIChatsPage, AITasksPage } from './records';

/**
 * Back-office pages for the AI product layer. Lists are read-only; pricing and the model catalog are
 * hot-applied policies (`ai-pricing`, `ai-catalog`) edited through `/management/policies/:id`.
 * Register with `...aiPages` in `features/index.ts`; menu entries come from the server's menu records.
 */
export const aiPages: AdminPageDefinition[] = [
  {
    key: 'ai-tasks',
    path: '/ai/tasks',
    title: { 'zh-CN': 'AI 生成任务', 'en-US': 'AI tasks' },
    permission: 'ai-tasks:query',
    component: AITasksPage,
    icon: Bot,
  },
  {
    key: 'ai-chats',
    path: '/ai/chats',
    title: { 'zh-CN': 'AI 对话', 'en-US': 'AI chats' },
    permission: 'chats:query',
    component: AIChatsPage,
    icon: MessagesSquare,
  },
  {
    key: 'ai-pricing',
    path: '/ai/pricing',
    title: { 'zh-CN': 'AI 价格与模型', 'en-US': 'AI pricing & models' },
    permission: 'config:update',
    component: AIPricingPage,
    icon: Coins,
  },
];

export { AIPricingPage } from './pricing-page';
export { AIChatsPage, AIRecordsPage, AITasksPage, aiRecordDefinitions, AI_TASK_STATUSES } from './records';
export { CatalogEditor } from './catalog-editor';
export { PricingEditor } from './pricing-editor';
export { catalogDraft, catalogModels, parseCatalog, type CatalogEntry, type CatalogRow } from './catalog-model';
export { chatPriceDraft, mediaPriceDraft, parseChatPrice, parseMediaPrice, parsePricing, type ChatPrice, type MediaPrice } from './pricing-model';
export { AI_CATALOG_POLICY, AI_KINDS, AI_PRICING_POLICY, MEDIA_KINDS, policyLayout, type AIKind, type MediaKind } from './policy-layout';
