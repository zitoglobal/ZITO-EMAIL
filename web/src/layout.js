/** 分栏宽度与布局模式（标准 / 销售台 / 专注 / 宽读信 / 宽列表） */

export const LAYOUT_MODES = [
  { id: 'standard', label: '标准', short: '标准', hint: '侧栏、列表、读信。客户从抽屉打开', icon: 'columns' },
  { id: 'sales', label: '销售台', short: '销售', hint: '右侧常驻客户栏（窗口够宽时）', icon: 'briefcase' },
  { id: 'focus', label: '专注', short: '专注', hint: '侧栏收成图标，读信更宽', icon: 'book' },
  { id: 'wide', label: '宽读信', short: '读信', hint: '列表收窄，报价正文更宽', icon: 'wide' },
  { id: 'board', label: '宽列表', short: '列表', hint: '列表加宽，方便扫大量询盘', icon: 'board' },
];

/** 界面强调色。只改操作色，不改 LOGO */
export const ACCENTS = [
  { id: 'blue', label: '志拓蓝', swatch: '#0a66ff' },
  { id: 'navy', label: '海军', swatch: '#123f73' },
  { id: 'teal', label: '青绿', swatch: '#0f6e78' },
  { id: 'ink', label: '石墨', swatch: '#3d4a5c' },
];

export const UI_SCALES = [
  { id: 'sm', label: '紧凑' },
  { id: 'md', label: '标准' },
  { id: 'lg', label: '宽松' },
];

const MODE_LIST_PRESET = {
  standard: 360,
  sales: 320,
  focus: 300,
  wide: 280,
  board: 460,
};

export const LAYOUT_LIMITS = {
  sidebar: { min: 180, max: 320, def: 252 },
  list: { min: 280, max: 520, def: 360 },
  customer: { min: 240, max: 380, def: 280 },
  focusSidebar: 64,
  focusListDef: 300,
  /** 销售台双击分隔条时，列表回到略窄的默认 */
  salesListDef: 320,
  /** 销售台四栏所需最小视口宽度 */
  /** 销售台四栏；略降以便 13–14″ 笔记本也能常驻客户栏 */
  salesRailMinViewport: 1100,
};

const LS_KEY = 'zm_layout_v1';

export function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, Math.round(x)));
}

export function normalizeLayoutMode(mode) {
  return LAYOUT_MODES.some((m) => m.id === mode) ? mode : 'sales';
}

export function normalizeAccent(id) {
  return ACCENTS.some((a) => a.id === id) ? id : 'blue';
}

export function normalizeUiScale(id) {
  return UI_SCALES.some((s) => s.id === id) ? id : 'md';
}

/** 切到某布局时，若该布局还没被拖过，用它自己的列表宽度 */
export function presetForMode(mode, base = {}) {
  const id = normalizeLayoutMode(mode);
  return normalizeWidths({ ...base, list: MODE_LIST_PRESET[id] || LAYOUT_LIMITS.list.def });
}

/** 双击分隔条：列表回到该布局的预设，其余回到全局默认 */
export function defaultWidth(mode, key) {
  if (key === 'list') return MODE_LIST_PRESET[normalizeLayoutMode(mode)] || LAYOUT_LIMITS.list.def;
  const lim = LAYOUT_LIMITS[key];
  return lim ? lim.def : 0;
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

function normalizeByMode(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const m of LAYOUT_MODES) {
    if (raw[m.id]) out[m.id] = normalizeWidths(raw[m.id]);
  }
  return out;
}

export function loadLayoutLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    const mode = normalizeLayoutMode(raw.mode);
    const widths = normalizeWidths(raw.widths || raw);
    const byMode = normalizeByMode(raw.byMode);
    if (!byMode[mode]) byMode[mode] = widths;
    return { mode, widths, byMode };
  } catch {
    return null;
  }
}

export function saveLayoutLocal(mode, widths, byMode) {
  try {
    const id = normalizeLayoutMode(mode);
    const w = normalizeWidths(widths);
    const saved = normalizeByMode(byMode);
    saved[id] = w;
    localStorage.setItem(LS_KEY, JSON.stringify({ mode: id, widths: w, byMode: saved }));
  } catch {
    // ignore quota
  }
}

/** 当前模式实际用于 CSS 的侧栏/列表宽度 */
export function effectiveWidths(mode, widths) {
  const w = normalizeWidths(widths);
  if (mode === 'focus') {
    return { sidebar: LAYOUT_LIMITS.focusSidebar, list: w.list, customer: w.customer };
  }
  return w;
}
