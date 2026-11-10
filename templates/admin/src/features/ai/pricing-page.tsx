import { Button, ErrorState, LoadingState, Notice, PageContainer, errorStatus, useAdminApi, usePermissionCheck, useResource } from '@zucker-framework/fe-admin';
import { useState } from 'react';
import type { PolicyView } from '../../pages/policies';
import { useText } from '../../text';
import { CatalogEditor } from './catalog-editor';
import { catalogModels } from './catalog-model';
import { AI_CATALOG_POLICY, AI_KINDS, AI_PRICING_POLICY, policyLayout } from './policy-layout';
import { AIPolicyPanel, policyPath } from './policy-panel';
import { PricingEditor } from './pricing-editor';

/** A policy the server has not registered (WP 2.3 not mounted) reads as `null`, not as a failure. */
function usePolicy(id: string) {
  const api = useAdminApi();
  return useResource<PolicyView | null>(
    (signal) =>
      api.get<PolicyView>(policyPath(id), undefined, { signal }).catch((error: unknown) => {
        if (errorStatus(error) === 404) return null;
        throw error;
      }),
    [id],
  );
}

/** Credit prices and the offered model catalog for AI generation and chat (hot-applied policies). */
export function AIPricingPage() {
  const tx = useText();
  const can = usePermissionCheck();
  const writable = can('config:update');
  const pricing = usePolicy(AI_PRICING_POLICY);
  const catalog = usePolicy(AI_CATALOG_POLICY);
  // Saved catalog models feed the price table's model suggestions.
  const [savedCatalog, setSavedCatalog] = useState<PolicyView | null>(null);
  const catalogPolicy = savedCatalog ?? catalog.data ?? null;
  const catalogLayout = catalogPolicy ? policyLayout(catalogPolicy, AI_KINDS) : null;
  const suggestions = catalogLayout ? catalogModels(Object.fromEntries(catalogLayout.slots.map((slot) => [slot.kind, slot.value]))) : {};

  const missing = (id: string) => (
    <Notice tone="warning" title={tx(`服务器未注册策略 ${id}`, `The server does not register the ${id} policy`)}>
      {tx('请确认服务端已启用 AI 模块。', 'Check that the server mounts the AI modules.')}
    </Notice>
  );
  const reload = () => {
    pricing.reload();
    catalog.reload();
    setSavedCatalog(null);
  };

  return (
    <PageContainer
      title={tx('AI 价格与模型', 'AI pricing & models')}
      description={tx(
        '保存后立即生效（各服务进程最多 30 秒内刷新）。积分为整数，0 表示免费；环境变量锁定的部分只读。',
        'Changes apply immediately (each server process refreshes within 30 seconds). Credits are whole numbers and 0 means free; parts pinned by the environment are read-only.',
      )}
      actions={<Button onClick={reload}>{tx('刷新', 'Refresh')}</Button>}
    >
      {!writable && <Notice tone="info" title={tx('当前账号只能查看', 'You can view these settings but not change them')} />}
      <div className="space-y-4">
        {catalog.error ? (
          <ErrorState onRetry={catalog.reload} />
        ) : catalog.loading && catalog.data === undefined ? (
          <LoadingState />
        ) : !catalog.data ? (
          missing(AI_CATALOG_POLICY)
        ) : (
          <AIPolicyPanel
            key={`catalog:${catalog.data.revision ?? 0}`}
            initial={catalog.data}
            title={tx('模型目录', 'Model catalog')}
            description={tx('前台按类别提供的提供方/模型组合（公开）。不在目录中的模型会被服务器拒绝。', 'Provider/model pairs the site offers per kind (public). The server rejects any model not listed here.')}
            kinds={AI_KINDS}
            writable={writable}
            onSaved={setSavedCatalog}
          >
            {(context) => <CatalogEditor context={context} />}
          </AIPolicyPanel>
        )}
        {pricing.error ? (
          <ErrorState onRetry={pricing.reload} />
        ) : pricing.loading && pricing.data === undefined ? (
          <LoadingState />
        ) : !pricing.data ? (
          missing(AI_PRICING_POLICY)
        ) : (
          <AIPolicyPanel
            key={`pricing:${pricing.data.revision ?? 0}`}
            initial={pricing.data}
            title={tx('价格表', 'Price table')}
            description={tx(
              '图片、视频、音频按次计费（未单独定价的模型用默认值）；对话按 token 计费并在发送前预扣最低积分。',
              'Image, video and audio are charged per task (models without their own price use the default); chat is charged by tokens, holding the minimum before streaming.',
            )}
            kinds={AI_KINDS}
            writable={writable}
          >
            {(context) => <PricingEditor context={context} suggestions={suggestions} />}
          </AIPolicyPanel>
        )}
      </div>
    </PageContainer>
  );
}
