import React, { useEffect, useState } from 'react';
import { Sparkles, X, Loader2, Flame, Layers, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { displayName } from '../utils.js';

export default function Digest({ aiEnabled, mailboxMap, onOpen, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      setData(await api('/ai/digest', { method: 'POST', body: {} }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (aiEnabled) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dot = (m) => {
    const mb = mailboxMap[m.mailboxId];
    return mb && Object.keys(mailboxMap).length > 1 ? <span className="mb-dot" style={{ background: mb.color }} title={mb.email} /> : null;
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal digest" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="digest-title"><Sparkles size={18} /> AI 今日邮件简报</div>
          <div>
            <button className="icon-btn" onClick={load} disabled={loading || !aiEnabled} title="重新生成"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
            <button className="icon-btn" onClick={onClose}><X size={18} /></button>
          </div>
        </div>
        <div className="modal-body">
          {!aiEnabled && <div className="form-error">AI 尚未配置，请管理员在服务器 .env 中设置 AI_API_KEY。</div>}
          {loading && !data && (
            <div className="reader-loading"><Loader2 size={20} className="spin" /> AI 正在阅读所有邮箱的未读邮件…</div>
          )}
          {error && <div className="form-error">{error}</div>}
          {data && (
            <>
              <p className="digest-overview">{data.overview}</p>
              {data.priorities?.length > 0 && (
                <div className="digest-section">
                  <h4><Flame size={15} /> 优先处理</h4>
                  {data.priorities.map((p, i) => (
                    <button key={i} className="digest-item" onClick={() => onOpen(p.mail)}>
                      <span className="rank">{i + 1}</span>
                      <div>
                        <b>{dot(p.mail)} {p.mail.subject || '(无主题)'}</b>
                        <small>{displayName(p.mail.from)} · {p.reason}</small>
                        {p.action && <em>建议：{p.action}</em>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {data.groups?.length > 0 && (
                <div className="digest-section">
                  <h4><Layers size={15} /> 分组概览</h4>
                  {data.groups.map((g, i) => (
                    <div key={i} className="digest-group">
                      <div className="dg-head"><b>{g.title}</b><span>{g.mails.length} 封</span></div>
                      <p>{g.summary}</p>
                      <div className="dg-mails">
                        {g.mails.map((m) => (
                          <button key={m.id} onClick={() => onOpen(m)}>{dot(m)} {m.subject || '(无主题)'}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
