import React, { useEffect, useState } from 'react';
import { Lock, User, KeyRound, Loader2, Sparkles, Zap, Layers, ShieldCheck } from 'lucide-react';
import { api } from '../api.js';
import { BrandWordmark, BrandSymbol, BrandIcon } from './Brand.jsx';

export function HeroBrand() {
  return (
    <>
      <div className="hero-top">
        <BrandWordmark height={30} onDark />
        <span className="hero-product">智能邮箱</span>
      </div>
      <BrandSymbol size={560} className="hero-ring" />
    </>
  );
}

export default function Auth({ onAuthed }) {
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', code: '', totp: '' });
  const [totpTicket, setTotpTicket] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/auth/status')
      .then((s) => {
        setStatus(s);
        if (!s.hasUsers) setMode('register');
      })
      .catch(() => setStatus({ hasUsers: true, signup: 'closed' }));
  }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (totpTicket) {
        const res = await api('/auth/login/totp', { method: 'POST', body: { ticket: totpTicket, code: form.totp } });
        onAuthed(res.user, { via: res.via, recoveryLeft: res.recoveryLeft });
        return;
      }
      const res = await api(mode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body: form });
      if (res.needsTotp && res.ticket) {
        setTotpTicket(res.ticket);
        setForm((f) => ({ ...f, totp: '' }));
        return;
      }
      onAuthed(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const first = status && !status.hasUsers;
  const canRegister = first || (status && status.signup !== 'closed');
  const totpStep = !!totpTicket;

  return (
    <div className="login-page">
      <div className="login-hero">
        <HeroBrand />
        <div className="hero-copy">
          <div className="hero-badge"><Sparkles size={13} /> 为外贸团队打造的智能邮箱</div>
          <h1>所有邮箱，<br />一个收件箱。</h1>
          <p>把企业邮、Gmail、Outlook、QQ、163 绑在一起，新邮件实时到达；AI 帮你读懂询盘、写好回复。</p>
          <ul className="hero-points">
            <li><Layers size={16} /> 多个邮箱统一收件，按颜色区分来源</li>
            <li><Zap size={16} /> 稍后提醒、定时发送、撤销发送</li>
            <li><Sparkles size={16} /> AI 摘要、提取待办、多语言回复</li>
          </ul>
        </div>
        <div className="hero-providers">网易企业邮 · 腾讯企业邮 · 阿里邮箱 · Gmail · Outlook · QQ · 163</div>
      </div>

      <div className="login-side">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <BrandIcon size={40} />
          <div>
            <div className="login-title">
              {totpStep ? '二次验证' : first ? '创建管理员账号' : mode === 'login' ? '登录 ZITO 智能邮箱' : '注册账号'}
            </div>
            <div className="login-sub">
              {totpStep
                ? '请输入验证器动态码，或一条备用恢复码'
                : first
                  ? '首个注册的账号将成为管理员'
                  : '登录后即可绑定并管理多个邮箱'}
            </div>
          </div>
        </div>

        {!totpStep && mode === 'register' && (
          <label className="field">
            <span>姓名</span>
            <div className="input-icon">
              <User size={16} />
              <input value={form.name} onChange={set('name')} placeholder="你的名字" autoComplete="name" />
            </div>
          </label>
        )}
        {!totpStep && (
          <>
            <label className="field">
              <span>账号</span>
              <div className="input-icon">
                <User size={16} />
                <input required autoFocus value={form.email} onChange={set('email')} placeholder="用户名或邮箱" autoComplete="username" autoCapitalize="none" spellCheck={false} />
              </div>
            </label>
            <label className="field">
              <span>平台密码</span>
              <div className="input-icon">
                <Lock size={16} />
                <input
                  type="password"
                  required
                  minLength={mode === 'register' ? 8 : undefined}
                  value={form.password}
                  onChange={set('password')}
                  placeholder={mode === 'register' ? '至少 8 位，含字母和数字' : '平台登录密码'}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                />
              </div>
            </label>
          </>
        )}
        {totpStep && (
          <label className="field">
            <span>验证码</span>
            <div className="input-icon">
              <ShieldCheck size={16} />
              <input
                required
                autoFocus
                value={form.totp}
                onChange={set('totp')}
                placeholder="6 位动态码或备用码"
                autoComplete="one-time-code"
              />
            </div>
          </label>
        )}
        {!totpStep && mode === 'register' && !first && status?.signup === 'code' && (
          <label className="field">
            <span>邀请码</span>
            <div className="input-icon">
              <KeyRound size={16} />
              <input required value={form.code} onChange={set('code')} placeholder="向管理员索取" />
            </div>
          </label>
        )}

        {error && <div className="form-error">{error}</div>}

        <button className="btn-primary block" disabled={loading || !status}>
          {loading && <Loader2 size={16} className="spin" />}
          {totpStep ? '验证并登录' : mode === 'login' ? '登录' : first ? '创建并进入' : '注册'}
        </button>

        {totpStep && (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setTotpTicket('');
              setForm((f) => ({ ...f, totp: '' }));
              setError('');
            }}
          >
            返回重新输入密码
          </button>
        )}

        {!totpStep && !first && canRegister && (
          <button type="button" className="link-btn" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
            {mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
          </button>
        )}
        {!totpStep && !first && !canRegister && mode === 'login' && <div className="login-foot">没有账号？请联系管理员开通</div>}
        <div className="login-foot"><ShieldCheck size={13} /> 平台密码与邮箱授权码分开保存，授权码经 AES-256 加密</div>
      </form>
      </div>
    </div>
  );
}
