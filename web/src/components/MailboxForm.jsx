import React, { useEffect, useRef, useState } from 'react';
import { Mail, Lock, ChevronDown, Loader2, Server, ShieldCheck } from 'lucide-react';
import { api, qs } from '../api.js';
import { MAILBOX_COLORS } from '../utils.js';

const PROVIDER_TIPS = [
  ['网易企业邮 / 163', '设置 → 客户端设置 → 开启 IMAP/SMTP，使用授权码'],
  ['QQ / 腾讯企业邮', '设置 → 账户 → 开启 IMAP/SMTP 服务，生成授权码'],
  ['Gmail', '优先用下方「Google 一键绑定」；或应用专用密码'],
  ['Outlook / M365', '优先用下方「Microsoft 一键绑定」；或应用密码'],
];

/**
 * 绑定新邮箱，或修改已绑定邮箱的密码 / 服务器设置
 */
export default function MailboxForm({ mailbox, onDone, onCancel, title, compact }) {
  const editing = !!mailbox;
  const [email, setEmail] = useState(mailbox?.email || '');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(mailbox?.name || '');
  const [color, setColor] = useState(mailbox?.color || null);
  const [detected, setDetected] = useState(null);
  const [showAdv, setShowAdv] = useState(editing);
  const [adv, setAdv] = useState({
    user: mailbox?.loginUser || '',
    imapHost: mailbox?.imap.host || '',
    imapPort: mailbox?.imap.port || 993,
    imapSecure: mailbox?.imap.secure ?? true,
    smtpHost: mailbox?.smtp.host || '',
    smtpPort: mailbox?.smtp.port || 465,
    smtpSecure: mailbox?.smtp.secure ?? true,
  });
  const [loading, setLoading] = useState(false);
  const [oauthBusy, setOauthBusy] = useState('');
  const [oauth, setOauth] = useState({ gmail: false, microsoft: false });
  const [error, setError] = useState('');
  const advTouched = useRef(false);
  const timer = useRef();

  useEffect(() => {
    api('/oauth/status')
      .then(setOauth)
      .catch(() => {});
  }, []);

  async function startOauth(provider) {
    setError('');
    setOauthBusy(provider);
    try {
      const q = editing && mailbox?.id ? qs({ mailboxId: mailbox.id }) : '';
      const { url } = await api(`/oauth/${provider}/start${q}`);
      if (!url) throw new Error('未返回授权地址');
      window.location.href = url;
    } catch (err) {
      setError(err.message || '无法启动 OAuth');
      setOauthBusy('');
    }
  }

  const oauthProvider =
    mailbox?.oauthProvider === 'microsoft' || mailbox?.provider === 'outlook' ? 'microsoft' : 'gmail';
  const canReauth =
    editing &&
    mailbox?.authType === 'oauth' &&
    ((oauthProvider === 'gmail' && oauth.gmail) || (oauthProvider === 'microsoft' && oauth.microsoft));

  useEffect(() => {
    if (editing) return;
    clearTimeout(timer.current);
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return setDetected(null);
    timer.current = setTimeout(async () => {
      try {
        const p = await api('/providers/detect' + qs({ email }));
        setDetected(p);
        if (p?.imap && !advTouched.current) {
          setAdv((a) => ({
            ...a,
            imapHost: p.imap.host,
            imapPort: p.imap.port,
            imapSecure: p.imap.secure,
            smtpHost: p.smtp.host,
            smtpPort: p.smtp.port,
            smtpSecure: p.smtp.secure,
          }));
        }
        // 未能识别服务商时自动展开服务器设置，减少「无法解析主机」误绑
        if (p?.key === 'custom' || p?.hint?.includes('未能自动识别')) setShowAdv(true);
      } catch {
        setDetected(null);
        setShowAdv(true);
      }
    }, 450);
  }, [email, editing]);

  const setA = (patch) => {
    advTouched.current = true;
    setAdv((a) => ({ ...a, ...patch }));
  };

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const advanced = showAdv && advTouched.current ? adv : undefined;
      const res = editing
        ? await api(`/mailboxes/${mailbox.id}`, { method: 'PATCH', body: { password: password || undefined, advanced: showAdv ? adv : undefined } })
        : await api('/mailboxes', { method: 'POST', body: { email, password, name, color, advanced } });
      onDone(res);
    } catch (err) {
      const msg = err.message || '绑定失败';
      setError(msg);
      if (/无法解析|ENOTFOUND|主机|IMAP|SMTP|服务器/i.test(msg)) setShowAdv(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className={'login-card' + (compact ? ' compact' : '')} onSubmit={submit}>
      <div className="login-brand">
        <div className="logo-mark"><Mail size={20} /></div>
        <div>
          <div className="login-title">{title || (editing ? '更新邮箱连接' : '绑定邮箱')}</div>
          <div className="login-sub">
            {editing
              ? `${mailbox.email}${mailbox.authType === 'oauth' ? ' · OAuth' : ''}`
              : '支持企业邮箱、Gmail、QQ、163、Outlook 等，可绑定多个'}
          </div>
        </div>
      </div>

      {!editing && (oauth.gmail || oauth.microsoft) && (
        <div className="oauth-bind">
          <div className="oauth-bind-label">一键授权（推荐）</div>
          <div className="oauth-bind-row">
            {oauth.gmail && (
              <button type="button" className="btn-ghost oauth-btn" disabled={!!oauthBusy} onClick={() => startOauth('gmail')}>
                {oauthBusy === 'gmail' ? <Loader2 size={15} className="spin" /> : null}
                Google / Gmail
              </button>
            )}
            {oauth.microsoft && (
              <button type="button" className="btn-ghost oauth-btn" disabled={!!oauthBusy} onClick={() => startOauth('microsoft')}>
                {oauthBusy === 'microsoft' ? <Loader2 size={15} className="spin" /> : null}
                Microsoft 365
              </button>
            )}
          </div>
          <div className="oauth-bind-or">或使用授权码绑定</div>
        </div>
      )}

      {canReauth && (
        <div className="oauth-bind">
          <div className="oauth-bind-label">OAuth 授权</div>
          <button type="button" className="btn-ghost oauth-btn" disabled={!!oauthBusy} onClick={() => startOauth(oauthProvider)}>
            {oauthBusy ? <Loader2 size={15} className="spin" /> : null}
            重新授权 {oauthProvider === 'microsoft' ? 'Microsoft 365' : 'Google'}
          </button>
          <div className="oauth-bind-or">令牌失效或改密后点此刷新，无需解绑</div>
        </div>
      )}

      {editing && mailbox?.authType === 'oauth' && !oauth.gmail && !oauth.microsoft && (
        <div className="provider-hint">此邮箱为 OAuth 绑定。当前环境未配置 Google/Microsoft 应用凭证，请改用授权码或联系管理员配置。</div>
      )}

      {!editing && (
        <label className="field">
          <span>邮箱地址</span>
          <div className="input-icon">
            <Mail size={16} />
            <input type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value.trim())} placeholder="name@company.com" />
          </div>
        </label>
      )}

      {detected?.name && !editing && (
        <div className="provider-hint">
          <Server size={14} />
          <div>
            <b>已识别：{detected.name}</b>
            {detected.imap?.host && (
              <div className="provider-hosts">
                IMAP {detected.imap.host}:{detected.imap.port}
                {detected.smtp?.host ? ` · SMTP ${detected.smtp.host}:${detected.smtp.port}` : ''}
              </div>
            )}
            {detected.hint && <div>{detected.hint}</div>}
          </div>
        </div>
      )}

      <label className="field">
        <span>{editing ? '新的密码 / 授权码（不修改可留空）' : '密码 / 授权码'}</span>
        <div className="input-icon">
          <Lock size={16} />
          <input type="password" required={!editing} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="邮箱密码或客户端授权码" autoComplete="new-password" />
        </div>
      </label>

      {!editing && (
        <div className="row-2">
          <label className="field">
            <span>发件人显示名</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：Alice Chen" />
          </label>
          <div className="field">
            <span>标识颜色</span>
            <div className="color-row">
              {MAILBOX_COLORS.slice(0, 7).map((c) => (
                <button type="button" key={c} className={'color-dot' + (color === c ? ' on' : '')} style={{ background: c }} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
        </div>
      )}

      <button type="button" className="adv-toggle" onClick={() => setShowAdv((v) => !v)}>
        服务器设置 <ChevronDown size={14} style={{ transform: showAdv ? 'rotate(180deg)' : '' }} />
      </button>

      {showAdv && (
        <div className="adv-grid">
          <label className="field span2">
            <span>登录用户名（默认同邮箱地址）</span>
            <input value={adv.user} onChange={(e) => setA({ user: e.target.value })} />
          </label>
          <label className="field">
            <span>IMAP 服务器</span>
            <input value={adv.imapHost} onChange={(e) => setA({ imapHost: e.target.value })} />
          </label>
          <label className="field small">
            <span>端口</span>
            <input
              type="number"
              value={adv.imapPort}
              onChange={(e) => {
                const p = e.target.value;
                setA({ imapPort: p, imapSecure: p === '993' ? true : p === '143' ? false : adv.imapSecure });
              }}
            />
          </label>
          <label className="field">
            <span>SMTP 服务器</span>
            <input value={adv.smtpHost} onChange={(e) => setA({ smtpHost: e.target.value })} />
          </label>
          <label className="field small">
            <span>端口</span>
            <input
              type="number"
              value={adv.smtpPort}
              onChange={(e) => {
                const p = e.target.value;
                setA({ smtpPort: p, smtpSecure: p === '465' ? true : p === '587' || p === '25' ? false : adv.smtpSecure });
              }}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={!!adv.imapSecure} onChange={(e) => setA({ imapSecure: e.target.checked })} /> IMAP 使用 SSL
          </label>
          <label className="check">
            <input type="checkbox" checked={!!adv.smtpSecure} onChange={(e) => setA({ smtpSecure: e.target.checked })} /> SMTP 使用 SSL
          </label>
        </div>
      )}

      {!editing && !compact && (
        <details className="tips">
          <summary>如何获取授权码？</summary>
          <ul>
            {PROVIDER_TIPS.map(([k, v]) => (
              <li key={k}><b>{k}</b>：{v}</li>
            ))}
          </ul>
        </details>
      )}

      {error && <div className="form-error">{error}</div>}

      <button className="btn-primary block" disabled={loading}>
        {loading && <Loader2 size={16} className="spin" />}
        {loading ? '正在验证并连接邮件服务器…' : editing ? '保存并重新连接' : '验证并绑定'}
      </button>
      {onCancel && (
        <button type="button" className="btn-ghost block" onClick={onCancel}>取消</button>
      )}
      <div className="login-foot"><ShieldCheck size={13} /> 授权码经 AES-256 加密存储，仅用于连接您的邮件服务器</div>
    </form>
  );
}
