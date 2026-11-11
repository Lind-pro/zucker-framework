import { Inject, Injectable } from '@nestjs/common';
import { PolicyService } from '@zucker-framework/back-office/settings';
import { AI_CONNECTIONS, aiConnectionConfig, type AIConnectionDefinition } from '../ai-connections/ai-connections.config';
import { AI_CONNECTION_ENVIRONMENT } from '../ai-connections/ai-connections.module';
import { AI_MEDIA_PROVIDERS, type AIMediaProviderEntry } from '../ai-connections/ai-media-providers';
import {
  AI_CATALOG_POLICY, AI_MEDIA_KINDS, AI_PRICING_POLICY, parseCatalog, parseChatPrice, parseMediaPrice,
  type AIKind, type AIMediaKind, type CatalogEntry, type ChatPrice,
} from './ai.policy';

export interface PublicCatalogEntry extends CatalogEntry {
  /** Whether the server has a configured provider for the pair right now. */
  available: boolean;
}
export interface PublicMediaCatalogEntry extends PublicCatalogEntry {
  /** Credits per output (`count` multiplies it). */
  cost: number;
}

/** Reads `ai-catalog` / `ai-pricing` (hot policies) and the startup provider configuration. */
@Injectable()
export class AICatalogService {
  constructor(private readonly policies: PolicyService,
    @Inject(AI_MEDIA_PROVIDERS) private readonly media: readonly AIMediaProviderEntry[],
    @Inject(AI_CONNECTION_ENVIRONMENT) private readonly env: Readonly<Record<string, string | undefined>>) {}

  mediaProvider(providerId: string, kind: AIMediaKind): AIMediaProviderEntry | undefined {
    return this.media.find(entry => entry.providerId === providerId && entry.kinds.includes(kind));
  }
  mediaProviderById(providerId: string): AIMediaProviderEntry | undefined {
    return this.media.find(entry => entry.providerId === providerId);
  }

  /** The chat connection behind a catalog provider id, when it is enabled and fully configured. */
  chatConnection(providerId: string): { definition: AIConnectionDefinition; modelId: string; maxTokens?: number } | undefined {
    const definition = AI_CONNECTIONS.find(item => item.id === providerId);
    if (!definition) return undefined;
    try {
      const config = aiConnectionConfig(definition, this.env);
      return { definition, modelId: config.modelId, maxTokens: config.maxTokens };
    } catch { return undefined; }
  }

  async catalog(kind: AIKind): Promise<CatalogEntry[]> {
    const values = await this.policies.get(AI_CATALOG_POLICY);
    const entries = parseCatalog(values[kind], kind);
    if (kind !== 'chat' || entries.length) return entries;
    // Empty chat list: every enabled connection with its configured model.
    return AI_CONNECTIONS.flatMap(definition => {
      const connection = this.chatConnection(definition.id);
      return connection && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(connection.modelId)
        ? [{ providerId: definition.id, model: connection.modelId, label: definition.name }] : [];
    });
  }

  async offered(kind: AIKind, providerId: string, model: string): Promise<CatalogEntry | undefined> {
    return (await this.catalog(kind)).find(entry => entry.providerId === providerId && entry.model === model);
  }

  async unitPrice(kind: AIMediaKind, model: string): Promise<number> {
    const price = parseMediaPrice((await this.policies.get(AI_PRICING_POLICY))[kind], kind);
    return Object.hasOwn(price.byModel, model) ? price.byModel[model] : price.default;
  }

  async chatPrice(): Promise<ChatPrice> {
    return parseChatPrice((await this.policies.get(AI_PRICING_POLICY)).chat);
  }

  /** `GET /ai/catalog`: what the web UI may offer, with prices and availability. */
  async publicView() {
    const media = Object.fromEntries(await Promise.all(AI_MEDIA_KINDS.map(async kind => [kind,
      await Promise.all((await this.catalog(kind)).map(async (entry): Promise<PublicMediaCatalogEntry> => ({
        ...entry, cost: await this.unitPrice(kind, entry.model), available: !!this.mediaProvider(entry.providerId, kind) })))]))) as
      Record<AIMediaKind, PublicMediaCatalogEntry[]>;
    const chat: PublicCatalogEntry[] = (await this.catalog('chat')).map(entry => ({ ...entry, available: !!this.chatConnection(entry.providerId) }));
    return { ...media, chat, chatPricing: await this.chatPrice() };
  }
}
