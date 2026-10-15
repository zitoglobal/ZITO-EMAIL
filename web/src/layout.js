/** 分栏宽度与布局模式（标准 / 销售台 / 专注读信） */

export const LAYOUT_MODES = [
  { id: 'standard', label: '标准', hint: '经典三栏，客户从抽屉打开' },
  { id: 'sales', label: '销售台', hint: '右侧常驻客户栏（空间足够时）' },
  { id: 'focus', label: '专注读信', hint: '侧栏收成图标轨，加宽读信区' },
];

export const LAYOUT_LIMITS = {
  sidebar: { min: 180, max: 320, def: 252 },
  list: { min: 280, max: 520, def: 360 },
  customer: { min: 240, max: 380, def: 280 },
  focusSidebar: 64,
  focusListDef: 300,
  /** 销售台四栏所需最小视口宽度 */
  salesRailMinViewport: 1180,
};

const LS_KEY = 'zm_layout_v1';

export function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, Math.round(x)));
}

export function normalizeLayoutMode(mode) {
  return LAYOUT_MODES.some((m) => m.id === mode) ? mode : 'standard';
}

export function normalizeWidths(raw = {}) {
  return {
    sidebar: clamp(raw.sidebar ?? raw.layoutSidebar, LAYOUT_LIMITS.sidebar.min, LAYOUT_LIMITS.sidebar.max) || LAYOUT_LIMITS.sidebar.def,
    list: clamp(raw.list ?? raw.layoutList, LAYOUT_LIMITS.list.min, LAYOUT_LIMITS.list.max) || LAYOUT_LIMITS.list.def,
    customer: clamp(raw.customer ?? raw.layoutCustomer, LAYOUT_LIMITS.customer.min, LAYOUT_LIMITS.customer.max) || LAYOUT_LIMITS.customer.def,
  };
}

export function widthsFromSettings(settings = {}) {
  return normalizeWidths({
    sidebar: settings.layoutSidebar,
    list: settings.layoutList,
    customer: settings.layoutCustomer,
  });
}

export function loadLayoutLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    return {
      mode: normalizeLayoutMode(raw.mode),
      widths: normalizeWidths(raw.widths || raw),
    };
  } catch {
    return null;
  }
}

export function saveLayoutLocal(mode, widths) {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        mode: normalizeLayoutMode(mode),
        widths: normalizeWidths(widths),
      })
    );
  } catch {
    // ignore quota
  }
}

/** 当前模式实际用于 CSS 的侧栏/列表宽度 */
export function effectiveWidths(mode, widths) {
  const w = normalizeWidths(widths);
  if (mode === 'focus') {
    return {
      sidebar: LAYOUT_LIMITS.focusSidebar,
      list: Math.min(w.list, 340),
      customer: w.customer,
    };
  }
  return w;
}
