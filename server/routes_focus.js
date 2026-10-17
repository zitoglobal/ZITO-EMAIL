/**
 * 今日待办 / 发件人规则 / VIP 建议（从 index 拆出）。
 */
export function registerFocusRoutes(app, ctx) {
  const { auth, wrap, httpError, mailboxOf, priority, labels, users, emit } = ctx;

  app.get(
    '/api/focus',
    auth,
    wrap(async (req, res) => {
      const mailboxId = req.query.mailboxId || 'all';
      if (mailboxId !== 'all') mailboxOf(req, mailboxId);
      const data = priority.focus(req.user.id, users.publicUser(req.user).settings, {
        mailboxId,
        dayStart: req.query.dayStart,
      });
      data.reply = labels.attachLabels(req.user.id, data.reply || []);
      data.followups = labels.attachLabels(req.user.id, data.followups || []);
      res.json(data);
    })
  );

  app.get(
    '/api/focus/explain',
    auth,
    wrap(async (req, res) => {
      const id = Number(req.query.id || req.query.messageId);
      if (!Number.isInteger(id)) throw httpError(400, '请提供邮件 id');
      res.json(priority.explainMessage(req.user.id, id, users.publicUser(req.user).settings));
    })
  );

  app.get('/api/sender-rules', auth, (req, res) => res.json({ rules: priority.listRules(req.user.id) }));
  app.post(
    '/api/sender-rules',
    auth,
    wrap(async (req, res) => {
      const key = priority.saveRule(req.user.id, req.body || {});
      emit(req.user.id, 'sync', { local: true });
      res.json({ ok: true, key });
    })
  );
  app.delete(
    '/api/sender-rules',
    auth,
    wrap(async (req, res) => {
      priority.deleteRule(req.user.id, req.query.key);
      emit(req.user.id, 'sync', { local: true });
      res.json({ ok: true });
    })
  );

  app.get(
    '/api/vip-suggestions',
    auth,
    wrap(async (req, res) => {
      res.json({ suggestions: priority.vipSuggestions(req.user.id) });
    })
  );
}
