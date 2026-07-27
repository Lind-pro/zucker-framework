// vendored 产物入口：popup.html 里 <script src="../lib/ext-kit-popup.js"> 后
// 调 ZuckerExtPopup.init({...}) 完成全部 UI 驱动，业务只提供设置字段与文案。
import { initPopup } from './popup';

(globalThis as Record<string, unknown>).ZuckerExtPopup = { init: initPopup };
