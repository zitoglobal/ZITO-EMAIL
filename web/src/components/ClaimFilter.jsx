import React from 'react';

/** 认领维度筛选：全部 / 未认领 / 我跟 / 同事跟 */
export default function ClaimFilter({ value, onChange, unclaimedN = 0, mineN = 0, title = '按团队认领筛选' }) {
  const set = (v) => onChange?.(v);
  return (
    <div className="segmented claim-filter" title={title}>
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
  if (claimFilter === 'unclaimed') return list.filter((m) => !m.deal);
  if (claimFilter === 'mine') return list.filter((m) => m.deal?.mine);
  if (claimFilter === 'others') return list.filter((m) => m.deal && !m.deal.mine);
  return list;
}

export function loadClaimFilter(key = 'zm_focus_claim') {
  try {
    return localStorage.getItem(key) || 'all';
  } catch {
    return 'all';
  }
}

export function saveClaimFilter(v, key = 'zm_focus_claim') {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}
