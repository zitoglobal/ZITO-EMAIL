/**
 * 团队认领 / 业务阶段路由（从 index 拆出）。
 */
function broadcastDeal(emit, users) {
  for (const u of users.listUsers()) emit(u.id, 'sync', { local: true, deal: true });
}

function focusHint(db, userId, body = {}) {
  const mid = Number(body.messageId);
  const address = String(body.address || '').trim();
  const subject = String(body.subject || '').replace(/^((Re|RE|Fwd|FW)\s*:\s*)+/i, '').trim();
  const fromName = String(body.fromName || '').trim();
  if (Number.isInteger(mid)) {
    const row = db
      .prepare(
        `SELECT m.id FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE m.id = ? AND b.user_id = ?`
      )
      .get(mid, userId);
    if (row) return { openToday: true, messageId: row.id, canOpen: true, startCompose: null };
  }
  // 同事箱认领：不能打开原信，引导写首封跟进（只用主题/地址，不读同事正文）
  const startCompose = address
    ? {
        to: fromName ? `${fromName} <${address}>` : address,
        subject: subject ? `Re: ${subject}` : '',
        openAi: true,
        aiInstruction:
          '这是团队公海认领的客户，原询盘在同事邮箱你看不到正文。请写一封专业的首封跟进：自我介绍并说明接手跟进，礼貌询问当前需求/规格/用量，勿编造报价或交期。',
      }
    : null;
  return { openToday: true, messageId: null, canOpen: false, startCompose };
}

export function registerDealsRoutes(app, ctx) {
  const { auth, wrap, rateLimit, deals, labels, emit, users, push, db } = ctx;

  app.get(
    '/api/deals/lookup',
    auth,
    wrap(async (req, res) => {
      res.json(deals.lookup(req.user.id, { address: req.query.address, threadId: req.query.threadId }));
    })
  );
  app.get('/api/deals/stages', auth, (_req, res) => res.json({ stages: deals.STAGES }));
  app.get(
    '/api/deals',
    auth,
    wrap(async (req, res) => {
      const owner = ['mine', 'all', 'others'].includes(req.query.owner) ? req.query.owner : 'mine';
      const list = deals.listDeals(req.user.id, {
        owner,
        stage: req.query.stage,
        limit: Number(req.query.limit) || 100,
      });
      res.json({ deals: list, stages: deals.STAGES });
    })
  );
  app.get(
    '/api/deals/events',
    auth,
    wrap(async (req, res) => {
      const dealId = req.query.dealId != null ? Number(req.query.dealId) : undefined;
      res.json({
        events: deals.listEvents(req.user.id, {
          dealId: Number.isInteger(dealId) ? dealId : undefined,
          address: req.query.address,
          limit: Number(req.query.limit) || 12,
        }),
      });
    })
  );
  app.post(
    '/api/deals/claim',
    auth,
    wrap(async (req, res) => {
      const deal = deals.claim(req.user.id, req.body || {});
      broadcastDeal(emit, users);
      const hint = db ? focusHint(db, req.user.id, req.body || {}) : { openToday: true };
      res.json({ deal, focusHint: hint });
    })
  );
  app.post(
    '/api/deals/:id/split',
    auth,
    wrap(async (req, res) => {
      const deal = deals.splitToPerson(req.user.id, Number(req.params.id));
      broadcastDeal(emit, users);
      res.json({ deal });
    })
  );
  app.post(
    '/api/deals/assign',
    auth,
    wrap(async (req, res) => {
      const deal = deals.assign(req.user.id, req.body || {});
      broadcastDeal(emit, users);
      if (deal?.owner?.id) {
        emit(deal.owner.id, 'sync', { local: true, deal: true, assigned: true });
        emit(deal.owner.id, 'deal-assigned', {
          scopeLabel: deal.scopeLabel,
          stageLabel: deal.stageLabel,
          from: req.user.name || req.user.email,
        });
        push
          ?.notifyUser?.(deal.owner.id, {
            title: '新客户已指派给你',
            body: `${deal.scopeLabel} · ${req.user.name || '管理员'} 指派`,
            url: '/?box=today',
            tag: 'zm-deal-assign',
          })
          .catch?.(() => {});
      }
      res.json({ deal });
    })
  );
  app.post(
    '/api/deals/claim-batch',
    auth,
    wrap(async (req, res) => {
      rateLimit('claim-batch:' + req.user.id, 30, 60_000);
      const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 40) : [];
      const claimed = [];
      const skipped = [];
      const seenScope = new Set();
      for (const it of items) {
        const scopeKind = it.scopeKind === 'address' || it.scopeKind === 'person' ? 'address' : undefined;
        const scope = deals.scopeFromAddress(it.address, scopeKind);
        if (!scope) {
          skipped.push({ address: it.address, error: '发件人地址无效', deal: null });
          continue;
        }
        if (seenScope.has(scope.key)) continue;
        seenScope.add(scope.key);
        try {
          const deal = deals.claim(req.user.id, {
            address: it.address,
            threadId: it.threadId,
            force: false,
            scopeKind,
          });
          claimed.push(deal);
        } catch (e) {
          skipped.push({ address: it.address, error: e.message, deal: e.deal || null });
        }
      }
      broadcastDeal(emit, users);
      res.json({ claimed, skipped, claimedCount: claimed.length, skippedCount: skipped.length });
    })
  );
  app.post(
    '/api/deals/:id/release',
    auth,
    wrap(async (req, res) => {
      deals.release(req.user.id, Number(req.params.id));
      broadcastDeal(emit, users);
      res.json({ ok: true });
    })
  );
  app.patch(
    '/api/deals/:id',
    auth,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      let deal = null;
      let stageLabel = null;
      if (req.body?.stage != null) {
        deal = deals.setStage(req.user.id, id, req.body.stage);
        const mid = Number(req.body.messageId);
        if (Number.isInteger(mid)) {
          try {
            stageLabel = labels.applyStageLabel(req.user.id, mid, req.body.stage).label;
          } catch (e) {
            console.warn('[deals] stage label', e.message);
          }
        }
      }
      if (req.body?.note != null) deal = deals.setNote(req.user.id, id, req.body.note);
      if ('nextFollowAt' in (req.body || {})) deal = deals.setNextFollowAt(req.user.id, id, req.body.nextFollowAt);
      if (!deal) {
        const row = deals.getDealById(id);
        if (!row) throw Object.assign(new Error('认领记录不存在'), { status: 404 });
        deal = deals.lookup(req.user.id, { address: row.last_address }).deal;
      }
      broadcastDeal(emit, users);
      res.json({ deal, stageLabel });
    })
  );
}
