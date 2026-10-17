/**
 * OAuth / 在看 / 团队公海路由（从 index 拆出，降低巨石体积）。
 */
export function registerCollabRoutes(app, ctx) {
  const {
    auth,
    admin,
    wrap,
    httpError,
    rateLimit,
    oauth,
    presence,
    teamQueue,
    adminOps,
    db,
    repo,
    sync,
    priority,
    emit,
    encrypt,
    assertSafeMailHosts,
    crypto,
    now,
    COLORS,
    MAX_MAILBOXES,
    users,
  } = ctx;

  app.get('/api/oauth/status', auth, (_req, res) => res.json(oauth.status()));

  app.get(
    '/api/oauth/:provider/start',
    auth,
    wrap(async (req, res) => {
      const provider = String(req.params.provider || '');
      if (provider !== 'gmail' && provider !== 'microsoft') throw httpError(400, '未知 OAuth 提供商');
      rateLimit('oauth:' + req.user.id, 20, 10 * 60_000);
      let mailboxId = req.query.mailboxId ? String(req.query.mailboxId) : null;
      if (mailboxId) {
        const mb = repo.getMailbox(req.user.id, mailboxId);
        if (!mb) throw httpError(404, '邮箱不存在');
        mailboxId = mb.id;
      }
      const { url } = oauth.beginAuth(provider, req.user.id, { mailboxId });
      res.json({ url, provider });
    })
  );

  app.get('/api/oauth/:provider/callback', async (req, res) => {
    const provider = String(req.params.provider || '');
    const fail = (msg) => {
      res.redirect(`/?oauth_error=${encodeURIComponent(String(msg || '授权失败').slice(0, 160))}`);
    };
    if (provider !== 'gmail' && provider !== 'microsoft') return fail('未知提供商');
    if (req.query.error) return fail(req.query.error_description || req.query.error);
    try {
      const { userId, profile, mailboxId } = await oauth.finishAuth(provider, {
        code: req.query.code,
        state: req.query.state,
      });
      let existing = null;
      if (mailboxId) {
        existing = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND user_id = ?').get(mailboxId, userId);
        if (existing && existing.email !== profile.email) {
          return fail(`授权账号 ${profile.email} 与绑定邮箱 ${existing.email} 不一致`);
        }
      }
      if (!existing) {
        existing = db.prepare('SELECT * FROM mailboxes WHERE user_id = ? AND email = ?').get(userId, profile.email);
      }
      if (!existing && repo.listMailboxes(userId).length >= MAX_MAILBOXES) {
        return fail(`每个账号最多绑定 ${MAX_MAILBOXES} 个邮箱`);
      }
      const conn = {
        imap_host: profile.imap.host,
        imap_port: profile.imap.port,
        imap_secure: profile.imap.secure ? 1 : 0,
        smtp_host: profile.smtp.host,
        smtp_port: profile.smtp.port,
        smtp_secure: profile.smtp.secure ? 1 : 0,
        login_user: profile.email,
      };
      await assertSafeMailHosts(conn);
      const count = repo.listMailboxes(userId).length;
      const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      const row = {
        id: existing?.id || crypto.randomBytes(8).toString('hex'),
        user_id: userId,
        email: profile.email,
        name: String(existing?.name || profile.name || userRow?.name || profile.email.split('@')[0]).trim(),
        color: existing?.color || COLORS[count % COLORS.length],
        provider: profile.provider,
        provider_name: profile.providerName,
        pass_enc: encrypt('oauth'),
        auto_saves_sent: profile.autoSavesSent ? 1 : 0,
        signature: existing?.signature || '',
        sort: existing?.sort ?? count,
        created_at: existing?.created_at || now(),
        ...conn,
      };
      db.prepare(
        `INSERT INTO mailboxes (id, user_id, email, name, color, provider, provider_name, login_user, pass_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, auto_saves_sent, signature, sort, status, created_at)
         VALUES (@id, @user_id, @email, @name, @color, @provider, @provider_name, @login_user, @pass_enc, @imap_host, @imap_port, @imap_secure,
          @smtp_host, @smtp_port, @smtp_secure, @auto_saves_sent, @signature, @sort, 'syncing', @created_at)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, provider = excluded.provider, provider_name = excluded.provider_name,
          login_user = excluded.login_user, pass_enc = excluded.pass_enc, imap_host = excluded.imap_host, imap_port = excluded.imap_port,
          imap_secure = excluded.imap_secure, smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port, smtp_secure = excluded.smtp_secure,
          auto_saves_sent = excluded.auto_saves_sent, status = 'syncing', last_error = NULL`
      ).run(row);
      oauth.storeTokens(row.id, profile);
      priority.invalidate(userId);
      sync.restart(row.id);
      emit(userId, 'mailbox', { id: row.id, status: 'syncing' });
      res.redirect(`/?oauth=ok&email=${encodeURIComponent(profile.email)}`);
    } catch (e) {
      console.error('[oauth]', e.message);
      fail(e.message);
    }
  });

  app.post(
    '/api/presence/touch',
    auth,
    wrap(async (req, res) => {
      const mid = Number(req.body?.messageId);
      if (!Number.isInteger(mid)) throw httpError(400, '缺少 messageId');
      const row = db
        .prepare(
          `SELECT m.id FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE m.id = ? AND b.user_id = ?`
        )
        .get(mid, req.user.id);
      if (!row) throw httpError(404, '邮件不存在');
      const viewers = presence.touch(req.user.id, req.user.name || req.user.email, mid, req.body?.threadId || null);
      res.json({ viewers });
    })
  );

  app.post(
    '/api/presence/leave',
    auth,
    wrap(async (req, res) => {
      const mid = Number(req.body?.messageId);
      if (!Number.isInteger(mid)) throw httpError(400, '缺少 messageId');
      res.json({ viewers: presence.leave(req.user.id, mid) });
    })
  );

  app.get(
    '/api/presence/:messageId',
    auth,
    wrap(async (req, res) => {
      const mid = Number(req.params.messageId);
      if (!Number.isInteger(mid)) throw httpError(400, '无效 id');
      res.json({ viewers: presence.list(mid, req.user.id, req.query.threadId || null) });
    })
  );

  app.get(
    '/api/team/queue',
    auth,
    wrap(async (req, res) => {
      res.json(teamQueue.listQueue(req.user.id, { limit: Number(req.query.limit) || 60 }));
    })
  );

  app.get('/api/team/members', auth, (_req, res) => {
    res.json({
      members: users.listUsers().map((u) => ({
        id: u.id,
        name: u.name || u.email,
        email: u.email,
        role: u.role,
      })),
    });
  });

  app.get(
    '/api/admin/ops',
    auth,
    admin,
    wrap(async (req, res) => {
      res.json(adminOps.snapshot(req.user.id));
    })
  );
}
