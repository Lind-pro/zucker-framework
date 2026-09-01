# __EXT_NAME__

由 `zucker ext create` 生成的浏览器扩展骨架。基建（批处理引擎、同域名节流、挑战退避 +
真人验证接力、懒加载滚动、动画揭示、offscreen blob 下载、URL 命名、域名文件夹、
激活码授权、免费额度、popup 队列 UI）全部来自 vendored 的 `lib/ext-kit.js` /
`lib/ext-kit-popup.js`（源码在 zucker-framework `packages/ext-kit`）。

## 只需要改的业务代码

- `background.js` — `ZuckerExt.init({ capture })`：页面已加载、已过验证、已滚动揭示，
  实现「对这个页面做什么」（截图 / PDF / 抽取 …），返回 `{ base64, mime, extension }`。
- `popup/popup.js` — 设置字段收集与按钮文案。
- `popup/popup.html` — SETTINGS 区的表单字段。
- `popup/popup.css` — `:root` 主题变量（accent 色已由生成器写入）。

## 待办

- `icons/` 放置 16/32/48/128 图标后在 `manifest.json` 补 `icons` 字段。
- 服务端在 ExtensionOrder/License 注册产品 `__EXT_SLUG__` 并创建 Stripe Payment Link。

## 命令

```bash
node scripts/package.mjs   # 打包 dist/__EXT_SLUG__-v<version>.zip
zucker ext sync            # 更新 vendored 基建（ext-kit*.js、offscreen、打包脚本）
```
