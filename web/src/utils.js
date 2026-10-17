export function formatListDate(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  if (now - d < 6 * 86400_000) return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatFullDate(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return d.toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatShortDateTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return `今天 ${time}`;
  const t = new Date(now);
  t.setDate(now.getDate() + 1);
  if (d.toDateString() === t.toDateString()) return `明天 ${time}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

export function relativeTime(ts) {
  if (!ts) return '从未';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function formatSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const COLORS = ['#0a66ff', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#1e3a64'];
export const MAILBOX_COLORS = ['#0a66ff', '#00b4e6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b'];

export function avatarColor(seed = '') {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export const displayName = (a) => (a ? a.name || a.address || '' : '');

export function initials(a) {
  const n = displayName(a).trim();
  if (!n) return '?';
  if (/[\u4e00-\u9fa5]/.test(n[0])) return n[0];
  const parts = n.replace(/["'<>]/g, '').split(/[\s._@-]+/).filter(Boolean);
  const second = /[a-z0-9]/i.test(parts[1]?.[0] || '') ? parts[1][0] : '';
  return ((parts[0]?.[0] || '') + second).toUpperCase() || '?';
}

export const FOLDER_LABEL = {
  '\\Inbox': '收件箱',
  '\\Flagged': '星标邮件',
  '\\Drafts': '草稿箱',
  '\\Sent': '已发送',
  '\\Archive': '归档',
  '\\Junk': '垃圾邮件',
  '\\Trash': '已删除',
  '\\All': '所有邮件',
  '\\Important': '重要',
};
export const folderLabel = (f) => (f ? FOLDER_LABEL[f.specialUse] || f.name : '');

export const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash', '\\All', '\\Flagged', '\\Important'];

export function sortFolders(list = []) {
  return [...list].sort((a, b) => {
    const ia = a.specialUse ? SPECIAL_ORDER.indexOf(a.specialUse) : 99;
    const ib = b.specialUse ? SPECIAL_ORDER.indexOf(b.specialUse) : 99;
    return ia - ib || a.path.localeCompare(b.path);
  });
}

export function folderDepth(f) {
  if (!f.delimiter || f.specialUse) return 0;
  return Math.max(0, f.path.split(f.delimiter).length - 1);
}

export const BOX_FOR_SPECIAL = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Archive': 'archive',
  '\\Junk': 'junk',
  '\\Trash': 'trash',
};

export const SMART_VIEWS = {
  today: '今日待办',
  waiting: '等待',
  inbox: '所有收件箱',
  unread: '未读邮件',
  flagged: '星标邮件',
  snoozed: '稍后处理',
  scheduled: '定时发送',
  sent: '已发送',
  drafts: '草稿箱',
  archive: '归档',
  junk: '垃圾邮件',
  trash: '已删除',
  label: '标签',
};

export const LABEL_COLOR_FALLBACK = '#0a66ff';


export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function textToHtml(text = '') {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>');
}

export function sanitizeHtml(html = '') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,form,link,meta,base,frame,frameset,style').forEach((n) => n.remove());
  doc.body.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || (/^(href|src|xlink:href|action|formaction)$/.test(name) && /^\s*(javascript|vbscript|data:text)/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

export function htmlToText(html = '') {
  const doc = new DOMParser().parseFromString(
    html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n'),
    'text/html'
  );
  doc.querySelectorAll('style,script,head').forEach((n) => n.remove());
  return (doc.body?.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function addrString(a) {
  if (!a?.address) return '';
  return a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address;
}

export function parseAddrList(s = '') {
  return String(s)
    .split(/[,;，；]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = x.match(/^(.*)<(.+)>$/);
      return m ? { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() } : { name: '', address: x };
    });
}

export function prefixSubject(prefix, subject = '') {
  if (prefix === 'Re' && /^\s*(re|回复|答复)\s*[:：]/i.test(subject)) return subject;
  if (prefix === 'Fwd' && /^\s*(fw|fwd|转发)\s*[:：]/i.test(subject)) return subject;
  return `${prefix}: ${subject}`;
}

export const CATEGORIES = [
  { key: 'all', label: '全部' },
  { key: 'people', label: '联系人' },
  { key: 'notification', label: '通知' },
  { key: 'newsletter', label: '订阅资讯' },
];

function at(dayOffset, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function nextWeekday(target, hour) {
  const d = new Date();
  const diff = (target - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function snoozePresets() {
  const h = new Date().getHours();
  const list = [];
  if (h < 17) list.push({ label: '今天晚些时候', sub: '18:00', at: at(0, 18) });
  else list.push({ label: '3 小时后', sub: formatShortDateTime(Date.now() + 3 * 3600_000), at: Date.now() + 3 * 3600_000 });
  list.push({ label: '明天', sub: '明天 08:00', at: at(1, 8) });
  list.push({ label: '本周末', sub: '周六 09:00', at: nextWeekday(6, 9) });
  list.push({ label: '下周', sub: '周一 08:00', at: nextWeekday(1, 8) });
  return list;
}

export function schedulePresets() {
  return [
    { label: '明天上午', sub: '明天 08:00', at: at(1, 8) },
    { label: '明天下午', sub: '明天 14:00', at: at(1, 14) },
    { label: '下周一上午', sub: '周一 08:00', at: nextWeekday(1, 8) },
  ];
}

export function toLocalInput(ts) {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

// ---------- 智能分拣 ----------
export const SIGNALS = {
  urgent: '紧急',
  complaint: '投诉',
  order: '订单',
  payment: '付款',
  inquiry: '询盘',
  sample: '样品',
  shipping: '物流',
};
export const TIERS = { vip: 'VIP', customer: '客户', new: '新联系人', colleague: '同事' };

export const dayStart = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime();

/** Focus 行「为何进待办/等待」：优先后端 why，本地再拼 */
export function whyPriority(m, variant = 'reply') {
  if (variant === 'reply' && m?.priority) {
    if (m.priority.why) return m.priority.why;
    const p = m.priority;
    const parts = [...(p.reasons || [])];
    if (p.slaHours != null) parts.push(`时限 ${p.slaHours}h`);
    if (p.overdue) parts.push(`已等 ${waitText(p.waitingHours)}`);
    else if (p.waitingHours >= 1) parts.push(`已等 ${waitText(p.waitingHours)}`);
    return [...new Set(parts.filter(Boolean))].slice(0, 5).join(' · ');
  }
  if (variant === 'follow' && m?.follow) {
    if (m.follow.why) return m.follow.why;
    const f = m.follow;
    const parts = [];
    if (f.due) parts.push('跟进日到期');
    else if (f.nextFollowAt) parts.push('已设跟进日');
    if (f.tier === 'vip') parts.push('VIP');
    else if (f.tier === 'customer') parts.push('老客户');
    else if (f.tier === 'new') parts.push('新联系人');
    for (const s of f.signals || []) if (SIGNALS[s]) parts.push(SIGNALS[s]);
    if (f.days != null) parts.push(`${f.days} 天未回`);
    parts.push('对方尚未回复');
    return [...new Set(parts.filter(Boolean))].slice(0, 5).join(' · ');
  }
  return '';
}

export function waitText(hours) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`;
  if (hours < 48) return `${Math.round(hours)} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/** 按邮件意图准备的英文回复，点一下填入，发出前仍可改 */
export function replyIdeas(signals = []) {
  const s = new Set(signals);
  const ideas = [];
  if (s.has('complaint')) {
    ideas.push(['先致歉，今天给方案', 'Thank you for flagging this, and sorry for the trouble. We are checking the affected pieces with our QC team now and will send a handling plan within today.']);
  }
  if (s.has('payment')) {
    ideas.push(['确认收款并安排生产', 'Thank you — we have received the payment notice and will confirm it with our finance team shortly. Production starts as soon as the receipt is verified.']);
  }
  if (s.has('order')) {
    ideas.push(['确认订单，今天发 PI', 'Thank you for confirming the order. We will issue the proforma invoice today and prepare production once the deposit arrives. Could you also confirm the delivery date works for you?']);
  }
  if (s.has('inquiry')) {
    ideas.push(['回复询盘与起订量', 'Thank you for your inquiry. Our quotation and MOQ are below — happy to adjust the details for your first order, and we can send samples right after you confirm the colors.']);
  }
  if (s.has('sample')) {
    ideas.push(['确认样品修改', 'Thank you for the fit comments. We will revise the sample accordingly and send the updated version for your approval.']);
  }
  if (s.has('shipping')) {
    ideas.push(['更新物流进度', 'Thank you for the update. We are checking the shipment now and will share the latest tracking and documents shortly.']);
  }
  if (s.has('urgent') && !ideas.length) {
    ideas.push(['优先处理并今天回复', 'Thank you for the note — we have marked this as urgent and will come back to you with a clear answer within today.']);
  }
  if (!ideas.length) ideas.push(['确认收到，稍后详复', 'Thank you for your email. We have received it and will get back to you shortly with the details.']);
  return ideas.slice(0, 3).map(([label, body]) => ({ label, body }));
}

export function greeting() {
  const h = new Date().getHours();
  return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
}

/** 今日待办的展示顺序：按优先级，或按客户公司聚合（组按组内最高分排序） */
export function orderFocus(items, mode) {
  const reply = items.filter((m) => m._section === 'reply');
  const rest = items.filter((m) => m._section !== 'reply');
  if (mode !== 'customer') return [...reply.sort((a, b) => b.priority.score - a.priority.score || b.date - a.date), ...rest];
  const groups = new Map();
  for (const m of reply) {
    const k = m.priority.company?.key || m.from?.address;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const sorted = [...groups.values()]
    .map((g) => g.sort((a, b) => b.priority.score - a.priority.score))
    .sort((a, b) => b[0].priority.score - a[0].priority.score);
  return [...sorted.flat(), ...rest];
}

export const hasRemoteImages = (html) => /<img[^>]+src\s*=\s*["']?\s*https?:|url\(\s*['"]?https?:|background\s*=\s*["']?https?:/i.test(html || '');

/** 把摘要/待办拼成 Composer 的 AI 指令，形成「摘要 → 智能回复」肌肉记忆 */
export function smartReplyInstruction(summary, intent = '') {
  const parts = [];
  if (summary?.summary) parts.push(`邮件摘要：${summary.summary}`);
  if (summary?.actionItems?.length) parts.push(`待办事项：${summary.actionItems.slice(0, 5).join('；')}`);
  if (summary?.keyPoints?.length) parts.push(`关键要点：${summary.keyPoints.slice(0, 3).join('；')}`);
  if (summary?.category) parts.push(`邮件类别：${summary.category}`);
  if (summary?.replyLanguage) parts.push(`请用${summary.replyLanguage}回复`);
  if (intent) parts.push(`回复意图：${intent}`);
  else parts.push('根据以上内容给出合适、专业的回复，未知信息用 [ ] 占位，不要编造价格或交期');
  return parts.join('\n');
}

/** 从已钉选的 ai_note 还原完整摘要卡片（仅当钉选时存了 summary；triage 短注不走这里） */
export function summaryFromAiNote(note) {
  if (!note?.summary) return null;
  return {
    summary: note.summary,
    keyPoints: note.keyPoints || [],
    actionItems: note.actionItems || [],
    urgency: note.urgency || 'medium',
    category: note.category || '',
    quickReplies: note.quickReplies || [],
    replyLanguage: note.replyLanguage || '',
    fromCache: true,
  };
}

/** Heuristic: body is mostly Chinese (for smart translate button). */
export function mostlyChinese(text) {
  const s = String(text || '').slice(0, 4000);
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  return cjk >= 8 && cjk >= latin * 0.4;
}

/** '中文' | 'English' | '其他' — mirrors server detectLang. */
export function detectMailLang(text) {
  const s = String(text || '').slice(0, 4000);
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (cjk >= 8 && cjk >= latin * 0.4) return '中文';
  if (latin >= 20 && latin > cjk * 2) return 'English';
  if (cjk > latin) return '中文';
  if (latin > 0) return 'English';
  return '其他';
}

/** Normalize translateTarget setting to API target string. */
export function normalizeTranslateTarget(v) {
  const t = String(v || '').trim();
  if (t === 'English' || t === '英文') return 'English';
  return '简体中文';
}

/** True when heuristic source language already matches the chosen target. */
export function sourceMatchesTarget(sourceLang, target) {
  const src = String(sourceLang || '');
  const tgt = normalizeTranslateTarget(target);
  const srcZh = /中文|chinese|zh/i.test(src);
  const srcEn = /english|英文|en/i.test(src);
  if (tgt === '简体中文' && srcZh) return true;
  if (tgt === 'English' && srcEn) return true;
  return false;
}
