export const PAGE = 50;
export const DEFAULT_VIEW = { mailboxId: 'all', box: 'today' };

export const REMOVING = new Set(['archive', 'trash', 'spam', 'notspam', 'move', 'delete']);
export const ACTION_TEXT = {
  archive: '已归档',
  trash: '已移到已删除',
  spam: '已标记为垃圾邮件',
  notspam: '已移回收件箱',
  move: '已移动',
  delete: '已彻底删除',
  snooze: '已设为稍后提醒',
  done: '已标记为处理完成',
  nofollow: '已移出待跟进',
};
export const UNDO_OF = { done: 'undone', nofollow: 'follow' };

export const SHORTCUTS = [
  ['C', '写邮件'],
  ['R / A / F', '回复 / 全部回复 / 转发'],
  ['Enter / O', '打开当前邮件'],
  ['D', '标记已处理（移出待回复）'],
  ['E', '归档'],
  ['#  或 Delete', '删除'],
  ['!', '垃圾邮件'],
  ['B', '稍后提醒（明天 8:00）'],
  ['S', '星标'],
  ['P', '置顶'],
  ['U', '标为未读'],
  ['X', '勾选当前邮件'],
  ['Z', '撤销上一操作（归档 / 删除 / 稍后 / 发送倒计时等）'],
  ['J / K 或 ↓ / ↑', '下一封 / 上一封'],
  ['/', '聚焦列表搜索'],
  ['G 然后 T / W / Q / D / A / I / U / S', '前往 今日待办 / 待回复桶 / 团队公海 / 我的客户 / 销售洞察 / 收件箱 / 未读 / 星标'],
  ['Shift + S', '读信：聚焦业务阶段'],
  ['Shift + F', '读信：聚焦跟进日'],
  ['Ctrl + K', '命令面板（全域搜索 + 命令）'],
  ['Ctrl + Enter', '发送邮件'],
  ['Ctrl + S', '保存草稿'],
  ['Esc', '关闭阅读 / 最小化写信窗口'],
  ['?', '显示快捷键'],
];

export const FOLLOW_UP_AI =
  '礼貌跟进（成衣外贸）：询问是否已查看，推动下一步（补规格 / 确认报价 / 样品反馈 / PO），保持简短专业，勿编造价格交期';

/** 按业务阶段定制催单 AI 意图（服装链路） */
export const FOLLOW_UP_AI_BY_STAGE = {
  inquiry: '礼貌跟进询盘：确认是否收到；若缺 tech pack / 面料成分克重 / 颜色尺码 / 目标数量，温和补齐，推动进入报价',
  quote: '礼貌跟进报价：询问单价、MOQ、交期是否合适，主动提出可调，推动确认或寄 SMS/色卡',
  sample: '礼貌跟进样品：询问是否收到及 Fit/手感/做工反馈；可提修改或 PP 样，并试探大货意向数量',
  bulk: '礼貌跟进大货：确认 PO 数量配码、批准样、包装唛头与船期是否齐全，推动出 PI / 下线',
  payment: '礼貌跟进付款：提醒 PI/定金/水单，说明到账后排产，语气得体不施压',
  won: '礼貌跟进成交后：确认出货文件或验货是否顺利，轻提返单或下一季开发',
  lost: '礼貌轻触：询问是否方便告知未推进原因，表示仍可协助，不强推报价',
};

export function followUpAiForStage(stage) {
  return FOLLOW_UP_AI_BY_STAGE[stage] || FOLLOW_UP_AI;
}

export function followUpBodyForStage(person, signatureHtmlFn, stage) {
  const first = String(person?.name || '').split(/\s+/)[0] || 'there';
  const bodies = {
    inquiry: `Just checking in on your inquiry — do you have the tech pack / fabric details and target qty ready? Happy to quote as soon as we have them.`,
    quote: `Just following up on our quotation — do the unit price, MOQ, and lead time work for you? I can revise or arrange SMS / lab dips if helpful.`,
    sample: `Hope the sample reached you safely. How is the fit and hand-feel? We can revise or move to PP / bulk whenever you're ready.`,
    bulk: `Checking in on bulk details — shall we lock the size run, packing, and ship window so we can issue the PI?`,
    payment: `Friendly reminder on the PI / deposit. Production can start once the payment is confirmed — happy to send any banking docs you need.`,
    won: `Thanks again for the order. Shipment docs on track on your side? Happy to support a repeat order or next season styles anytime.`,
    lost: `Just a quick note — if the project is still open or priorities change, I'm here to help. No pressure at all.`,
  };
  const line = bodies[stage] || `Just following up on my email below — have you had a chance to review it? I'm happy to answer any questions.`;
  return `<div>Hi ${first},</div><div><br></div><div>${line}</div><div><br></div><div>Looking forward to hearing from you.</div><br>${signatureHtmlFn || ''}`;
}
