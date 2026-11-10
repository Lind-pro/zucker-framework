/** Home page copy used only when no published `home` page exists. */
const en = {
  setupTitle: 'Publish your home page',
  setupText:
    'This site has no published page with the slug "home". Create one in the admin under Content (or run the content seed) and it appears here.',
  setupPricing: 'View pricing',
  setupBlog: 'Read the blog',
};
const zh: typeof en = {
  setupTitle: '请发布首页',
  setupText: '当前站点还没有已发布的 slug 为 "home" 的页面。请在管理后台的内容管理中创建并发布（或运行内容种子命令），发布后会显示在这里。',
  setupPricing: '查看价格',
  setupBlog: '阅读博客',
};
export function landingCopy(locale: string) {
  return locale === 'zh' ? zh : en;
}
