import { delay } from './util';

export type DebuggerTarget = { tabId: number };

export function debuggerAttach(target: DebuggerTarget, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, version, () => {
      const error = chrome.runtime.lastError;
      error ? reject(new Error(error.message)) : resolve();
    });
  });
}

export function debuggerDetach(target: DebuggerTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const error = chrome.runtime.lastError;
      error ? reject(new Error(error.message)) : resolve();
    });
  });
}

export function sendCommand(
  target: DebuggerTarget,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (result) => {
      const error = chrome.runtime.lastError;
      error ? reject(new Error(error.message)) : resolve((result as Record<string, unknown>) || {});
    });
  });
}

export function waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: (v?: never) => void, value?: Error) => {
      if (!settled) {
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        (fn as (v?: Error) => void)(value);
      }
    };
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish(resolve);
      }
    };
    const timer = setTimeout(() => finish(reject as never, new Error('Page load timeout')), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        finish(resolve);
      }
    }).catch(() => {});
  });
}

export interface ChallengeError extends Error {
  isChallenge: true;
}

export function challengeError(name: string): ChallengeError {
  const error = new Error(`Blocked by ${name} verification`) as ChallengeError;
  error.isChallenge = true;
  return error;
}

export function isChallengeError(error: unknown): error is ChallengeError {
  return Boolean((error as ChallengeError | null)?.isChallenge);
}

// 挑战页标题特征（用于 detach debugger 后仅凭 chrome.tabs 的标题判断验证是否通过）
const CHALLENGE_TITLE_RE =
  /just a moment|checking your browser|attention required|verifying|security checkpoint|正在验证|安全检查点|verify you are human|are you a robot|请完成验证|人机验证|captcha/;

export interface PageProbe {
  error: string;
  challenge: string;
}

// 用 debugger Runtime.evaluate 探测：网络错误页 / 真人验证挑战页（body 检测比标题更稳）
export async function probePage(target: DebuggerTarget): Promise<PageProbe> {
  const r = await sendCommand(target, 'Runtime.evaluate', {
    returnByValue: true,
    expression: `(function(){
      var uri=document.documentURI||"";
      if(uri.indexOf("chrome-error://")===0) return {error:"Page failed to load (DNS or network error)",challenge:""};
      var t=(document.title||"").toLowerCase();
      var b=(document.body?document.body.innerText:"").slice(0,500).toLowerCase();
      var u=(location.href||"").toLowerCase();
      var s=t+" "+b+" "+u;
      var c="";
      if(/just a moment|checking your browser|attention required|cf-browser-verification|challenges\\.cloudflare/.test(s)) c="Cloudflare";
      else if(/verifying your browser|正在验证您的浏览器|security checkpoint|安全检查点/.test(s)) c="Vercel";
      else if(/verify you are human|are you a robot|请完成验证|人机验证|captcha/.test(s)) c="bot-check";
      return {error:"",challenge:c};
    })()`,
  });
  const value = (r.result as { value?: PageProbe } | undefined)?.value;
  return value || { error: '', challenge: '' };
}

// 等用户手动通过验证：debugger 已 detach（webdriver=false），仅凭 chrome.tabs 的标题判断。
// 标题不再是挑战特征即视为通过；shouldStop 由引擎提供（取消 / 跳过）
export async function waitForVerification(
  tabId: number,
  shouldStop: () => boolean,
  timeoutMs = 180000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) {
      return false;
    }
    await delay(2500);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      return false;
    }
    const title = (tab.title || '').toLowerCase();
    const url = (tab.url || '').toLowerCase();
    if (url.startsWith('chrome-error')) {
      continue;
    }
    if (title && !CHALLENGE_TITLE_RE.test(title)) {
      return true;
    }
  }
  return false;
}

export async function focusTab(tabId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // ignore
  }
}

// 平滑滚动整页触发懒加载，结束滚回顶部
export function autoScroll(target: DebuggerTarget): Promise<unknown> {
  return sendCommand(target, 'Runtime.evaluate', {
    awaitPromise: true,
    expression: `new Promise(function(resolve){
      var distance=600, scrolled=0, guard=0;
      var maxHeight=Math.min(document.body?document.body.scrollHeight:0, 20000);
      var timer=setInterval(function(){
        window.scrollBy(0, distance);
        scrolled+=distance; guard+=1;
        var reached=scrolled>=Math.max(maxHeight, document.body?document.body.scrollHeight:0);
        if(reached || guard>60){
          clearInterval(timer);
          setTimeout(function(){ window.scrollTo(0,0); setTimeout(resolve, 400); }, 300);
        }
      }, 120);
    })`,
  }).catch(() => undefined);
}

// 揭示滚动触发动画（AOS / WOW / animate.css / scroll-reveal / locomotive 等）。
// 这些库初始把元素设为 opacity:0，进视口才淡入；滚回顶部后 once:false 的会重置回透明，
// 导致截图/PDF 中间空白。这里强制把它们置为已显示，并对通用「淡入型」元素兜底。
// reversible=true 时记录原状态（quick 模式要还原用户页面）。
export function revealAnimations(target: DebuggerTarget, reversible = false): Promise<unknown> {
  return sendCommand(target, 'Runtime.evaluate', {
    expression: `(function(){
      try{
        var reversible=${reversible ? 'true' : 'false'};
        var state=reversible?{style:null,aos:[],inline:[]}:null;
        var css=document.createElement('style');
        css.textContent=[
          '[data-aos]{opacity:1!important;transform:none!important;transition:none!important;}',
          '.wow{visibility:visible!important;opacity:1!important;animation-name:none!important;}',
          '.animate__animated,.animated{opacity:1!important;}',
          '[data-scroll]{opacity:1!important;transform:none!important;}',
          '.reveal,[data-sr],[data-sr-id],.sr-reveal{opacity:1!important;transform:none!important;visibility:visible!important;}'
        ].join('');
        (document.head||document.documentElement).appendChild(css);
        if(state) state.style=css;
        document.querySelectorAll('[data-aos]').forEach(function(el){
          if(state&&!el.classList.contains('aos-animate')) state.aos.push(el);
          el.classList.add('aos-animate');
        });
        // 通用兜底：被动画藏起来的内容块（opacity≈0 且带 transition/animation）强制显示。
        // 只处理 static/relative（普通内容流），跳过 fixed/absolute（多为弹窗/菜单/轮播），避免误伤
        var all=document.body?document.body.querySelectorAll('*'):[];
        for(var i=0;i<all.length;i++){
          var el=all[i], s=getComputedStyle(el);
          if(parseFloat(s.opacity)<0.05 && (s.transitionDuration!=='0s'||s.animationName!=='none')){
            var p=s.position;
            if(p==='static'||p==='relative'){
              if(state) state.inline.push({
                el:el,
                opacity:el.style.getPropertyValue('opacity'),
                opacityPriority:el.style.getPropertyPriority('opacity'),
                transform:el.style.getPropertyValue('transform'),
                transformPriority:el.style.getPropertyPriority('transform')
              });
              el.style.setProperty('opacity','1','important');
              el.style.setProperty('transform','none','important');
            }
          }
        }
        if(state) window.__zuckerExtRevealState=state;
      }catch(e){}
    })()`,
  }).catch(() => undefined);
}

export async function getScrollPosition(target: DebuggerTarget): Promise<{ x: number; y: number }> {
  const result = await sendCommand(target, 'Runtime.evaluate', {
    returnByValue: true,
    expression: `({ x: window.scrollX || 0, y: window.scrollY || 0 })`,
  });
  const value = (result.result as { value?: { x: number; y: number } } | undefined)?.value;
  return value || { x: 0, y: 0 };
}

// quick 模式收尾：撤销揭示改动 + 恢复滚动位置，把用户的页面还原
export function restorePageAfterQuick(
  target: DebuggerTarget,
  position: { x: number; y: number },
): Promise<unknown> {
  const x = Number(position?.x) || 0;
  const y = Number(position?.y) || 0;
  return sendCommand(target, 'Runtime.evaluate', {
    expression: `(function(){
      try{
        var state=window.__zuckerExtRevealState;
        if(state){
          if(state.style&&state.style.remove) state.style.remove();
          (state.aos||[]).forEach(function(el){ el.classList.remove('aos-animate'); });
          (state.inline||[]).forEach(function(saved){
            if(saved.opacity) saved.el.style.setProperty('opacity',saved.opacity,saved.opacityPriority||'');
            else saved.el.style.removeProperty('opacity');
            if(saved.transform) saved.el.style.setProperty('transform',saved.transform,saved.transformPriority||'');
            else saved.el.style.removeProperty('transform');
          });
          delete window.__zuckerExtRevealState;
        }
      }catch(e){}
      window.scrollTo(${x}, ${y});
    })()`,
  });
}
