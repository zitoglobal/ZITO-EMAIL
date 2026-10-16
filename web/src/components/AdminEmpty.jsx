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
        <p>尚未绑定邮箱。你可以先开通同事账号，或绑定自己的邮箱开始收信。</p>
        <div className="admin-empty-actions">
          <button type="button" className="btn-primary" onClick={onOpenTeam}>
            <Users size={15} /> 开通团队成员
          </button>
          <button type="button" className="btn-ghost" onClick={onAddMailbox}>
            <MailPlus size={15} /> 绑定邮箱
          </button>
          <button type="button" className="btn-ghost" onClick={onOpenSettings}>
            <SlidersHorizontal size={15} /> 偏好设置
          </button>
        </div>
        <ul className="admin-empty-hints">
          <li>成员登录后各自绑定邮箱，数据相互隔离</li>
          <li>你可随时在「设置 → 邮箱账号」补绑自己的邮箱</li>
          <li>今日待办 / 等待会在有邮件同步后自动出现</li>
        </ul>
      </div>
    </section>
  );
}
