import { useEffect } from 'react';
import { api, qs } from '../api.js';
import { dayStart } from '../utils.js';
import { DEFAULT_VIEW } from '../appConstants.js';

/**
 * 登录后首屏：拉 /me、恢复智能文件夹、处理 OAuth 回调提示。
 */
export function useAppBoot({ applyState, setUser, setAi, setAiMeta, setBoot, setQ, setViewState, notify }) {
  useEffect(() => {
    api('/me' + qs({ dayStart: dayStart() }))
      .then((d) => {
        setUser(d.user);
        setAi(d.ai);
        setAiMeta?.(d.aiMeta || null);
        applyState(d);
        try {
          const v = JSON.parse(localStorage.getItem('zm_view') || 'null');
          if (v?.box === 'smart' && v.smartId && d.savedSearches?.length) {
            const ss = d.savedSearches.find((x) => Number(x.id) === Number(v.smartId));
            if (ss) setQ(ss.query);
            else setViewState(DEFAULT_VIEW);
          }
        } catch {
          /* ignore */
        }
        setBoot('ready');
        try {
          const sp = new URLSearchParams(window.location.search);
          if (sp.get('oauth') === 'ok') {
            const email = sp.get('email') || '';
            notify(email ? `已绑定 ${email}，正在同步…` : '邮箱已通过 OAuth 绑定，正在同步…', 'success');
            window.history.replaceState({}, '', window.location.pathname);
          } else if (sp.get('oauth_error')) {
            notify(`OAuth 绑定失败：${sp.get('oauth_error')}`, 'error', null, 12_000);
            window.history.replaceState({}, '', window.location.pathname);
          } else if (['team', 'today', 'waiting', 'deals', 'insights', 'inbox', 'unread', 'flagged', 'sent', 'snoozed'].includes(sp.get('box'))) {
            setViewState({ mailboxId: 'all', box: sp.get('box') });
            const keepCompose = sp.get('compose') === '1';
            window.history.replaceState({}, '', keepCompose ? `${window.location.pathname}?compose=1` : window.location.pathname);
          }
        } catch {
          /* ignore */
        }
      })
      .catch(() => setBoot('auth'));
  }, [applyState, setUser, setAi, setAiMeta, setBoot, setQ, setViewState, notify]);
}
