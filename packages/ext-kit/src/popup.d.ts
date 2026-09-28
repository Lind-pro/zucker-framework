import type { PopupConfig } from './types';
export declare function initPopup(config: PopupConfig): void;
export declare function collectSameOriginLinks(options?: { phase?: 'links' | 'sitemap' | 'cancel'; id?: string }): Promise<{ urls: string[]; sitemapCount?: number; incomplete?: boolean; cancelled?: boolean }>;
