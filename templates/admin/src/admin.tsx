import { createAdminApp } from '@zucker-framework/fe-admin';
import { FileText, FormInput, Settings2, Tags } from 'lucide-react';
import { CategoriesPage } from './pages/categories';
import { ContentPage } from './pages/content';
import { FormEnginePage } from './pages/form-engine';
import { SiteSettingsPage } from './pages/site-settings';
import { serverLabelsEnUS } from './server-labels';

/**
 * Back-office composition for this application. The shell, session handling and generic pages come
 * from @zucker-framework/fe-admin; this file keeps the application's brand, API prefix, registration
 * policy, mail content columns and its own content/form pages.
 */
export const admin = createAdminApp({
  // Same-origin `/api`; the Vite dev server proxies it to API_PROXY_TARGET.
  apiBase: '/api',
  locales: {
    'zh-CN': { label: '中文', messages: {} },
    'en-US': { label: 'English', messages: {} },
  },
  // The server template describes its connections in Chinese; English comes from this table.
  serverLabels: { 'en-US': serverLabelsEnUS },
  users: {
    // New accounts follow this application's public registration policy.
    createDefaults: { typeId: 'member' },
  },
  mail: {
    // Matches the server template's email_templates columns (English is the required default).
    contentFields: { en: 'htmlContentEn', zh: 'htmlContentZh' },
  },
  pages: {
    // The server template manages AI through runtime connection settings and does not mount
    // createAIModelAdminController; products that do can drop this override.
    aiModels: false,
  },
  extraPages: [
    {
      key: 'content',
      path: '/content',
      title: { 'zh-CN': '页面、博客与文档', 'en-US': 'Pages, blog & docs' },
      permission: 'content:manage',
      component: ContentPage,
      icon: FileText,
    },
    {
      key: 'content-categories',
      path: '/content/categories',
      title: { 'zh-CN': '博客分类', 'en-US': 'Blog categories' },
      permission: 'content:manage',
      component: CategoriesPage,
      icon: Tags,
    },
    {
      key: 'site-settings',
      path: '/config',
      title: { 'zh-CN': '站点配置', 'en-US': 'Site settings' },
      permission: 'content:manage',
      component: SiteSettingsPage,
      icon: Settings2,
    },
    {
      key: 'form-engine',
      path: '/form-engine',
      title: { 'zh-CN': '动态表单', 'en-US': 'Forms' },
      permission: 'form:query',
      component: FormEnginePage,
      icon: FormInput,
    },
  ],
});

export const App = admin.App;
