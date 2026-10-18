import dns from 'node:dns/promises';
import { db } from './db.js';

const cache = new Map();
const TTL = 6 * 3600 * 1000;

function domainOfEmail(email) {
  return String(email || '')
    .toLowerCase()
    .split('@')[1] || '';
}

async function txtRecords(name) {
  try {
    const rows = await dns.resolveTxt(name);
    return rows.map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

async function checkDomain(domain) {
  const cached = cache.get(domain);
  if (cached && Date.now() - cached.at < TTL) return cached.result;

  const spfTxt = await txtRecords(domain);
  const spf = spfTxt.find((t) => /\bv=spf1\b/i.test(t)) || '';
  const dmarcTxt = await txtRecords(`_dmarc.${domain}`);
  const dmarc = dmarcTxt.find((t) => /\bv=DMARC1\b/i.test(t)) || '';

  const dkimSelectors = ['default', 'selector1', 'selector2', 'google', 'k1', 's1', 'mail', 'dkim'];
  let dkimOk = false;
  let dkimSelector = '';
  for (const sel of dkimSelectors) {
    try {
      const recs = await dns.resolveTxt(`${sel}._domainkey.${domain}`);
      const joined = recs.map((p) => p.join('')).join(' ');
      if (/v=DKIM1|p=/i.test(joined)) {
        dkimOk = true;
        dkimSelector = sel;
        break;
      }
    } catch {
      /* try next */
    }
  }

  const spfOk = !!spf;
  const dmarcOk = !!dmarc;
  let level = 'bad';
  if (spfOk && dmarcOk && dkimOk) level = 'good';
  else if (spfOk || dmarcOk) level = 'warn';

  const tips = [];
  if (!spfOk) tips.push('缺少 SPF：在域名 TXT 添加 v=spf1 … ~all');
  if (!dkimOk) tips.push('未探测到常见 DKIM 选择器，请在邮局后台开启 DKIM');
  if (!dmarcOk) tips.push('缺少 DMARC：添加 _dmarc TXT（v=DMARC1; p=none; …）');
  if (level === 'good') tips.push('SPF / DKIM / DMARC 基础齐全，适合开发信与报价外发');

  const result = {
    domain,
    level,
    spf: { ok: spfOk, record: spf.slice(0, 300) },
    dkim: { ok: dkimOk, selector: dkimSelector },
    dmarc: { ok: dmarcOk, record: dmarc.slice(0, 300) },
    tips,
    checkedAt: Date.now(),
  };
  cache.set(domain, { at: Date.now(), result });
  return result;
}

/** 当前用户各发信域名的投递力摘要 */
export async function reportForUser(userId) {
  const mbs = db.prepare('SELECT id, email, name FROM mailboxes WHERE user_id = ?').all(userId);
  const byDomain = new Map();
  for (const mb of mbs) {
    const d = domainOfEmail(mb.email);
    if (!d) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push({ id: mb.id, email: mb.email, name: mb.name });
  }
  const domains = [];
  for (const [domain, mailboxes] of byDomain) {
    const check = await checkDomain(domain);
    domains.push({ ...check, mailboxes });
  }
  const order = { bad: 0, warn: 1, good: 2 };
  domains.sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
  return { domains, generatedAt: Date.now() };
}
