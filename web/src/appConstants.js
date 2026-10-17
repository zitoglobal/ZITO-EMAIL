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
  ['D', '标记已处理（移出待回复）'],
  ['E', '归档'],
  ['#  或 Delete', '删除'],
  ['!', '垃圾邮件'],
  ['B', '稍后提醒（明天 8:00）'],
  ['S', '星标'],
  ['P', '置顶'],
  ['U', '标为未读'],
  ['X', '勾选当前邮件'],
  ['J / K 或 ↓ / ↑', '下一封 / 上一封'],
  ['/', '搜索'],
  ['G 然后 T / W / D / A / I / U / S', '前往 今日待办 / 等待 / 我的客户 / 销售洞察 / 收件箱 / 未读 / 星标'],
  ['Ctrl + K', '搜索邮件与命令'],
  ['Ctrl + Enter', '发送邮件'],
  ['Ctrl + S', '保存草稿'],
  ['Esc', '关闭阅读 / 最小化写信窗口'],
  ['?', '显示快捷键'],
];

export const FOLLOW_UP_AI =
  '礼貌地跟进这封邮件：询问对方是否已查看、有无疑问，并推动下一步（如确认订单细节或安排样品），保持简短';

/** 按业务阶段定制催单 AI 意图 */
export const FOLLOW_UP_AI_BY_STAGE = {
  inquiry: '礼貌跟进询盘：确认对方是否收到、是否需要补充规格/用量，邀请对方提出疑问，推动进入报价，保持简短专业',
  quote: '礼貌跟进报价：询问对方是否已审阅报价、价格与交期是否合适，主动提出可调整，推动确认或样品，保持简短',
  sample: '礼貌跟进样品：询问样品是否收到、是否合格，需要的话可安排修改或产前样，推动大货意向，保持简短',
  bulk: '礼貌跟进大货：确认订单细节（数量/交期/包装）是否齐全，推动下单或 PO，保持简短专业',
  payment: '礼貌跟进付款：提醒形式发票/定金事宜，确认付款进度，语气得体不施压，保持简短',
  won: '礼貌跟进成交后事宜：确认交货/文件是否顺利，询问是否有加单需求，保持简短友好',
  lost: '礼貌轻触：询问是否方便告知未推进原因，表示仍可协助，不强推，保持简短',
};

export function followUpAiForStage(stage) {
  return FOLLOW_UP_AI_BY_STAGE[stage] || FOLLOW_UP_AI;
}

export function followUpBodyForStage(person, signatureHtmlFn, stage) {
  const first = String(person?.name || '').split(/\s+/)[0] || 'there';
  const bodies = {
    inquiry: `Just checking in on your inquiry — have you had a chance to review? Happy to clarify specs or prepare a quotation if helpful.`,
    quote: `Just following up on the quotation I sent — does the pricing and lead time work for you? I'm happy to adjust if needed.`,
    sample: `Hope the sample reached you safely. How does it look? We can revise or move to bulk whenever you're ready.`,
    bulk: `Checking in on the bulk order details — shall we lock quantities and ship date, or do you need any changes first?`,
    payment: `Friendly reminder regarding the payment / PI. Please let me know if you need any documents to proceed.`,
    won: `Thanks again for the business. Everything on track on your side? Happy to help with the next order anytime.`,
    lost: `Just a quick note — if the project is still open or priorities change, I'm here to help. No pressure at all.`,
  };
  const line = bodies[stage] || `Just following up on my email below — have you had a chance to review it? I'm happy to answer any questions.`;
  return `<div>Hi ${first},</div><div><br></div><div>${line}</div><div><br></div><div>Looking forward to hearing from you.</div><br>${signatureHtmlFn || ''}`;
}
