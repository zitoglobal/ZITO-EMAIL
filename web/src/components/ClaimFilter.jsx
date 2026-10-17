import React from 'react';

/** 认领维度筛选：跟进中(未认领+我跟) / 全部 / 未认领 / 我跟 / 同事跟 */
export default function ClaimFilter({ value, onChange, unclaimedN = 0, mineN = 0, title = '按团队认领筛选' }) {
  const set = (v) => onChange?.(v);
  return (
    <div className="segmented claim-filter" title={title}>
      <button type="button" className={value === 'active' ? 'on' : ''} onClick={() => set('active')}>
        跟进中
      </button>
      <button type="button" className={value === 'all' ? 'on' : ''} onClick={() => set('all')}>全部</button>
      <button type="button" className={value === 'unclaimed' ? 'on' : ''} onClick={() => set('unclaimed')}>
        未认领{unclaimedN ? ` ${unclaimedN}` : ''}
      </button>
      <button type="button" className={value === 'mine' ? 'on' : ''} onClick={() => set('mine')}>
        我跟{mineN ? ` ${mineN}` : ''}
      </button>
      <button type="button" className={value === 'others' ? 'on' : ''} onClick={() => set('others')}>同事跟</button>
    </div>
  );
}

export function filterByClaim(list, claimFilter) {
  if (claimFilter === 'active') return list.filter((m) => !m.deal || m.deal?.mine);
  if (claimFilter === 'unclaimed') return list.filter((m) => !m.deal);
  if (claimFilter === 'mine') return list.filter((m) => m.deal?.mine);
  if (claimFilter === 'others') return list.filter((m) => m.deal && !m.deal.mine);
  return list;
}

/** 默认「跟进中」：未认领 + 我跟，降低误回同事客户 */
export function loadClaimFilter(key = 'zm_focus_claim') {
  try {
    const v = localStorage.getItem(key);
    if (v === 'all' || v === 'active' || v === 'unclaimed' || v === 'mine' || v === 'others') return v;
    return 'active';
  } catch {
    return 'active';
  }
}

export function saveClaimFilter(v, key = 'zm_focus_claim') {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}
