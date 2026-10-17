/** 桌面 / iOS / Android / 鸿蒙 / 微信 / 折叠 · 平台探测 */
export function detectPlatform(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  const touch = (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0)
    || (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);
  const wechat = /MicroMessenger/i.test(ua);
  const harmony = /HarmonyOS|OpenHarmony|ArkWeb|HMSCore|HuaweiBrowser/i.test(ua);
  const android = !harmony && /Android/i.test(ua);
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touch);
  const desktop = !wechat && !android && !ios && !harmony
    && typeof window !== 'undefined'
    && window.matchMedia('(pointer: fine)').matches
    && !touch;
  const standalone = (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches)
    || (typeof navigator !== 'undefined' && navigator.standalone === true);
  return { wechat, ios, android, harmony, desktop, touch: touch || ios || android || harmony, standalone };
}

/** 写入 html/body class，供导航与安全区 CSS 使用 */
export function applyPlatformClasses() {
  if (typeof document === 'undefined') return detectPlatform();
  const flags = detectPlatform();
  const root = document.documentElement;
  Object.entries(flags).forEach(([k, v]) => {
    if (v) {
      root.classList.add(`plat-${k}`);
      if (document.body) document.body.classList.add(`plat-${k}`);
    }
  });
  if (flags.wechat) {
    root.classList.add('in-wechat');
    if (document.body) document.body.classList.add('in-wechat');
  }
  root.dataset.plat = ['wechat', 'ios', 'android', 'harmony', 'desktop']
    .filter((k) => flags[k])
    .join(' ') || 'unknown';
  return flags;
}

/** 视觉视口 → CSS 变量 + 软键盘 kb-open（底栏避让） */
export function bindVisualViewport() {
  if (typeof window === 'undefined') return () => {};
  const sync = () => {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    const root = document.documentElement;
    root.style.setProperty('--vvh', `${Math.round(h)}px`);
    root.style.setProperty('--vv-top', `${Math.round(top)}px`);
    const layoutH = window.innerHeight || h;
    document.body?.classList.toggle('kb-open', h < layoutH * 0.82);
  };
  sync();
  window.visualViewport?.addEventListener('resize', sync);
  window.visualViewport?.addEventListener('scroll', sync);
  window.addEventListener('resize', sync, { passive: true });
  return () => {
    window.visualViewport?.removeEventListener('resize', sync);
    window.visualViewport?.removeEventListener('scroll', sync);
    window.removeEventListener('resize', sync);
  };
}
