/**
 * 团队认领 / 业务阶段路由（从 index 拆出）。
 */
function broadcastDeal(emit, users, teamQueue) {
  try {
    teamQueue?.invalidateQueueStatsCache?.();
  } catch (_) {}
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
          '这是团队公海认领的客户，原询盘在同事邮箱你看不到正文。请写一封专业的首封跟进：自我介绍并说明接手跟进，礼貌询问当前需求/规格/用量，勿编造报价或交期。结尾邀请对方把规格表或参考链接发到本邮箱。',
      }
    : null;
  return { openToday: true, messageId: null, canOpen: false, startCompose };
}

/** 公海认领：通知原邮箱所有者（非认领人），避免「信还在我箱却不知已被接手」 */
function notifyMailboxOwnerOnClaim({ db, emit, push, deal, claimer, body }) {
  const mid = Number(body?.messageId);
  if (!Number.isInteger(mid) || !db) return;
  const row = db
    .prepare(
      `SELECT b.user_id AS owner_id, b.email AS mailbox
       FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE m.id = ?`
    )
    .get(mid);
  if (!row || row.owner_id === claimer.id) return;
  const payload = {
    scopeLabel: deal?.scopeLabel || body?.address || '客户',
    from: claimer.name || claimer.email,
    mailbox: row.mailbox,
  };
  emit(row.owner_id, 'deal-claimed-other', payload);
  emit(row.owner_id, 'sync', { local: true, deal: true });
  push
    ?.notifyUser?.(row.owner_id, {
      title: '同事已认领你箱内的客户',
      body: `${payload.from} 认领了 ${payload.scopeLabel}`,
      url: '/?box=team',
      tag: 'zm-deal-claimed-other',
    })
    .catch?.(() => {});
}

export function registerDealsRoutes(app, ctx) {
  const { auth, wrap, rateLimit, deals, labels, emit, users, push, db, teamQueue, customerAssets, brands, threadNotes } = ctx;
  const bump = () => broadcastDeal(emit, users, teamQueue);

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
      const body = req.body || {};
      const deal = deals.claim(req.user.id, body);
      bump();
      notifyMailboxOwnerOnClaim({ db, emit, push, deal, claimer: req.user, body });
      const hint = db ? focusHint(db, req.user.id, body) : { openToday: true };
      res.json({ deal, focusHint: hint });
    })
  );
  app.post(
    '/api/deals/:id/split',
    auth,
    wrap(async (req, res) => {
      const deal = deals.splitToPerson(req.user.id, Number(req.params.id));
      bump();
      res.json({ deal });
    })
  );
  app.post(
    '/api/deals/assign',
    auth,
    wrap(async (req, res) => {
      const deal = deals.assign(req.user.id, req.body || {});
      bump();
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
          const body = {
            address: it.address,
            threadId: it.threadId,
            messageId: it.messageId || it.id,
            subject: it.subject,
            fromName: it.fromName,
            force: false,
            scopeKind,
          };
          const deal = deals.claim(req.user.id, body);
          claimed.push(deal);
          notifyMailboxOwnerOnClaim({ db, emit, push, deal, claimer: req.user, body });
        } catch (e) {
          skipped.push({ address: it.address, error: e.message, deal: e.deal || null });
        }
      }
      bump();
      res.json({ claimed, skipped, claimedCount: claimed.length, skippedCount: skipped.length });
    })
  );
  app.post(
    '/api/deals/:id/release',
    auth,
    wrap(async (req, res) => {
      deals.release(req.user.id, Number(req.params.id));
      bump();
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
      const body = req.body || {};
      if (body.stage != null) {
        deal = deals.setStage(req.user.id, id, body.stage);
        const mid = Number(body.messageId);
        if (Number.isInteger(mid)) {
          try {
            stageLabel = labels.applyStageLabel(req.user.id, mid, body.stage).label;
          } catch (e) {
            console.warn('[deals] stage label', e.message);
          }
        }
      }
      if (body.note != null) deal = deals.setNote(req.user.id, id, body.note);
      if ('nextFollowAt' in body) deal = deals.setNextFollowAt(req.user.id, id, body.nextFollowAt);
      const commerceKeys = [
        'styleNo', 'currency', 'amount', 'moq', 'leadDays', 'incoterm', 'quoteValidUntil', 'brandId', 'autoFollowSeq',
      ];
      if (commerceKeys.some((k) => k in body)) deal = deals.updateCommerce(req.user.id, id, body);
      if (!deal) {
        const row = deals.getDealById(id);
        if (!row) throw Object.assign(new Error('认领记录不存在'), { status: 404 });
        deal = deals.lookup(req.user.id, { address: row.last_address }).deal;
      }
      bump();
      res.json({ deal, stageLabel, quoteSnippet: deals.quoteSnippet(deal) });
    })
  );

  app.get(
    '/api/deals/:id/styles',
    auth,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      deals.getDealById(id) || (() => { throw Object.assign(new Error('认领记录不存在'), { status: 404 }); })();
      res.json({ styles: deals.listStyles(id) });
    })
  );
  app.post(
    '/api/deals/:id/styles',
    auth,
    wrap(async (req, res) => {
      const style = deals.upsertStyle(req.user.id, Number(req.params.id), req.body || {});
      bump();
      res.json({ style, styles: deals.listStyles(Number(req.params.id)) });
    })
  );
  app.delete(
    '/api/deals/:id/styles/:sid',
    auth,
    wrap(async (req, res) => {
      res.json(deals.deleteStyle(req.user.id, Number(req.params.id), Number(req.params.sid)));
    })
  );

  app.get(
    '/api/deals/:id/samples',
    auth,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!deals.getDealById(id)) throw Object.assign(new Error('认领记录不存在'), { status: 404 });
      res.json({ samples: deals.listSamples(id) });
    })
  );
  app.post(
    '/api/deals/:id/samples',
    auth,
    wrap(async (req, res) => {
      const sample = deals.upsertSample(req.user.id, Number(req.params.id), req.body || {});
      bump();
      res.json({ sample, samples: deals.listSamples(Number(req.params.id)) });
    })
  );
  app.delete(
    '/api/deals/:id/samples/:sid',
    auth,
    wrap(async (req, res) => {
      res.json(deals.deleteSample(req.user.id, Number(req.params.id), Number(req.params.sid)));
    })
  );

  app.get(
    '/api/customer-assets',
    auth,
    wrap(async (req, res) => {
      res.json({
        assets: customerAssets.listAssets(req.user.id, {
          address: req.query.address,
          scopeKey: req.query.scopeKey,
          limit: Number(req.query.limit) || 50,
        }),
      });
    })
  );
  app.post(
    '/api/customer-assets',
    auth,
    wrap(async (req, res) => {
      res.json({ asset: customerAssets.addAsset(req.user.id, req.body || {}) });
    })
  );
  app.delete(
    '/api/customer-assets/:id',
    auth,
    wrap(async (req, res) => {
      res.json(customerAssets.deleteAsset(req.user.id, Number(req.params.id)));
    })
  );

  app.get(
    '/api/brands',
    auth,
    wrap(async (req, res) => {
      res.json({ brands: brands.listBrands(req.user.id) });
    })
  );
  app.post(
    '/api/brands',
    auth,
    wrap(async (req, res) => {
      res.json({ brand: brands.createBrand(req.user.id, req.body || {}) });
    })
  );
  app.patch(
    '/api/mailboxes/:id/brand',
    auth,
    wrap(async (req, res) => {
      res.json(brands.setMailboxBrand(req.user.id, req.params.id, req.body?.brandId));
    })
  );

  app.get(
    '/api/thread-notes',
    auth,
    wrap(async (req, res) => {
      res.json({
        notes: threadNotes.listNotes({
          threadId: req.query.threadId,
          address: req.query.address,
          limit: Number(req.query.limit) || 30,
        }),
      });
    })
  );
  app.post(
    '/api/thread-notes',
    auth,
    wrap(async (req, res) => {
      res.json({ note: threadNotes.addNote(req.user.id, req.body || {}) });
    })
  );
  app.delete(
    '/api/thread-notes/:id',
    auth,
    wrap(async (req, res) => {
      res.json(threadNotes.deleteNote(req.user.id, Number(req.params.id), { admin: req.user.role === 'admin' }));
    })
  );
}
