import React from 'react';
import { Users, MailPlus, SlidersHorizontal, Shield } from 'lucide-react';

/** 管理员未绑邮箱时的工作台入口（免 onboarding 拦截后的主区空态） */
export default function AdminEmpty({ user, onAddMailbox, onOpenTeam, onOpenSettings }) {
  return (
    <section className="list-pane admin-empty-pane" aria-label="管理员工作台">
      <div className="admin-empty">
        <div className="admin-empty-badge">
          <Shield size={14} /> 管理员
        </div>
        <h1>你好，{user?.name || '管理员'}</h1>
        <p>第一步：绑定自己的邮箱，收信与今日待办才会出现。团队成员可随后开通。</p>
        <div className="admin-empty-actions">
          <button type="button" className="btn-primary" onClick={onAddMailbox}>
            <MailPlus size={15} /> 绑定第一个邮箱
          </button>
          <button type="button" className="btn-ghost" onClick={onOpenTeam}>
            <Users size={15} /> 开通团队成员
          </button>
          <button type="button" className="btn-ghost" onClick={onOpenSettings}>
            <SlidersHorizontal size={15} /> 偏好设置
          </button>
        </div>
        <ol className="admin-empty-hints">
          <li>绑定 IMAP/SMTP 或 Gmail / Microsoft 365 OAuth（需管理员配置应用凭证）</li>
          <li>同步完成后，「今日待办 / 等待」自动出现</li>
          <li>需要时再开通同事账号；成员登录后各自绑箱，数据隔离</li>
        </ol>
      </div>
    </section>
  );
}
