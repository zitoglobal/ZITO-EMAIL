import net from 'node:net';
import dns from 'node:dns/promises';

/**
 * 阻止已登录用户把 IMAP/SMTP 指到内网 / 云元数据（SSRF）。
 * 允许：公网 IP、正常主机名；禁止：私网、环回、链路本地、metadata。
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

function ipBlocked(ip) {
  if (!ip || !net.isIP(ip)) return false;
  let v = ip.toLowerCase();
  // IPv4-mapped IPv6（::ffff:10.0.0.1）按内嵌 IPv4 判断，避免绕过私网拦截
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (mapped) v = mapped[1];
  if (v === '0.0.0.0' || v === '::' || v === '::1') return true;
  if (v.startsWith('127.')) return true;
  if (v.startsWith('10.')) return true;
  if (v.startsWith('192.168.')) return true;
  if (v.startsWith('169.254.')) return true;
  // 100.64.0.0/10 CGNAT
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(v)) return true;
  // 172.16.0.0/12
  const m = /^172\.(\d+)\./.exec(v);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  // IPv6 ULA / link-local
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')) return true;
  return false;
}

export function isBlockedHostname(host) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIP(h)) return ipBlocked(h);
  return false;
}

/** 同步快速检查主机名字面量；异步再解析 DNS */
export async function assertSafeMailHost(host, label = '邮件服务器') {
  const h = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!h) throw Object.assign(new Error(`请填写${label}`), { status: 400 });
  if (isBlockedHostname(h)) {
    throw Object.assign(new Error(`${label}地址不允许使用内网或本机地址`), { status: 400 });
  }
  if (net.isIP(h)) return h;
  let addrs;
  try {
    addrs = await dns.lookup(h, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error(`无法解析${label}域名：${h}`), { status: 400 });
  }
  for (const a of addrs || []) {
    if (ipBlocked(a.address)) {
      throw Object.assign(new Error(`${label}解析到内网地址，已拒绝连接`), { status: 400 });
    }
  }
  return h;
}

export async function assertSafeMailHosts(conn) {
  await assertSafeMailHost(conn.imap_host, 'IMAP');
  await assertSafeMailHost(conn.smtp_host, 'SMTP');
}
