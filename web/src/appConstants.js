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
  ['G 然后 T / W / I / U / S', '前往 今日待办 / 等待 / 收件箱 / 未读 / 星标'],
  ['Ctrl + K', '搜索邮件与命令'],
  ['Ctrl + Enter', '发送邮件'],
  ['Ctrl + S', '保存草稿'],
  ['Esc', '关闭阅读 / 最小化写信窗口'],
  ['?', '显示快捷键'],
];

export const FOLLOW_UP_AI =
  '礼貌地跟进这封邮件：询问对方是否已查看、有无疑问，并推动下一步（如确认订单细节或安排样品），保持简短';
