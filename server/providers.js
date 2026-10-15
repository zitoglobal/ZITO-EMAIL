import dns from 'node:dns/promises';

export const PRESETS = {
  netease_qiye: {
    name: '网易企业邮箱',
    imap: { host: 'imap.qiye.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.qiye.163.com', port: 465, secure: true },
    hint: '请使用网易企业邮登录密码；若开启了安全登录，请在网页版「设置 → 客户端授权密码」生成授权码。',
  },
  netease_163: {
    name: '网易 163 邮箱',
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    hint: '需在网页版「设置 → POP3/SMTP/IMAP」开启 IMAP，并使用授权码登录。',
  },
  netease_126: {
    name: '网易 126 邮箱',
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true },
    hint: '需开启 IMAP 服务，并使用授权码登录。',
  },
  netease_yeah: {
    name: '网易 yeah 邮箱',
    imap: { host: 'imap.yeah.net', port: 993, secure: true },
    smtp: { host: 'smtp.yeah.net', port: 465, secure: true },
    hint: '需开启 IMAP 服务，并使用授权码登录。',
  },
  qq: {
    name: 'QQ 邮箱',
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    hint: '需在 QQ 邮箱「设置 → 账户」开启 IMAP/SMTP 服务，使用生成的授权码登录。',
  },
  tencent_exmail: {
    name: '腾讯企业邮箱',
    imap: { host: 'imap.exmail.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true },
    hint: '若开启了安全登录，请使用「客户端专用密码」。',
  },
  aliyun_qiye: {
    name: '阿里企业邮箱',
    imap: { host: 'imap.qiye.aliyun.com', port: 993, secure: true },
    smtp: { host: 'smtp.qiye.aliyun.com', port: 465, secure: true },
    hint: '如开启了三方客户端安全密码，请使用该密码登录。',
  },
  aliyun: {
    name: '阿里邮箱',
    imap: { host: 'imap.aliyun.com', port: 993, secure: true },
    smtp: { host: 'smtp.aliyun.com', port: 465, secure: true },
    hint: '',
  },
  gmail: {
    name: 'Gmail / Google Workspace',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    hint: '需开启两步验证，并在 Google 账号「安全性 → 应用专用密码」生成 16 位密码登录。',
    autoSavesSent: true,
  },
  outlook: {
    name: 'Outlook / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    hint: '需在账户中允许 IMAP 与 SMTP AUTH，个人账户请使用应用密码。',
    autoSavesSent: true,
  },
  sina: {
    name: '新浪邮箱',
    imap: { host: 'imap.sina.com', port: 993, secure: true },
    smtp: { host: 'smtp.sina.com', port: 465, secure: true },
    hint: '需开启 IMAP 服务，并使用授权码登录。',
  },
};

const DOMAIN_MAP = {
  '163.com': 'netease_163',
  '126.com': 'netease_126',
  'yeah.net': 'netease_yeah',
  'qq.com': 'qq',
  'foxmail.com': 'qq',
  'vip.qq.com': 'qq',
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
  'aliyun.com': 'aliyun',
  'sina.com': 'sina',
  'sina.cn': 'sina',
};

const MX_RULES = [
  [/qiye\.163\.com|mxmail\.netease\.com|qiye163mx/i, 'netease_qiye'],
  [/exmail\.qq\.com|mxbiz\d*\.qq\.com/i, 'tencent_exmail'],
  [/qiye\.aliyun\.com|mxhichina\.com/i, 'aliyun_qiye'],
  [/google\.com|googlemail\.com/i, 'gmail'],
  [/outlook\.com|protection\.outlook/i, 'outlook'],
];

/** 部署在自有邮件服务器时，通过环境变量指定默认 IMAP/SMTP */
function ownServerPreset() {
  const host = process.env.DEFAULT_IMAP_HOST;
  if (!host) return null;
  const smtpPort = Number(process.env.DEFAULT_SMTP_PORT || 465);
  return {
    key: 'own',
    name: process.env.DEFAULT_MAIL_NAME || '企业邮箱',
    imap: { host, port: Number(process.env.DEFAULT_IMAP_PORT || 993), secure: process.env.DEFAULT_IMAP_SECURE !== '0' },
    smtp: {
      host: process.env.DEFAULT_SMTP_HOST || host,
      port: smtpPort,
      secure: process.env.DEFAULT_SMTP_SECURE ? process.env.DEFAULT_SMTP_SECURE !== '0' : smtpPort === 465,
    },
    hint: '',
  };
}

function ownDomains() {
  return String(process.env.DEFAULT_MAIL_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export async function detectProvider(email) {
  const domain = String(email || '').split('@')[1]?.trim().toLowerCase();
  if (!domain) return null;

  const own = ownServerPreset();
  if (own && ownDomains().includes(domain)) return own;

  if (DOMAIN_MAP[domain]) {
    const key = DOMAIN_MAP[domain];
    return { key, ...PRESETS[key] };
  }

  try {
    const mx = await dns.resolveMx(domain);
    const hosts = mx.map((m) => m.exchange).join(' ');
    for (const [re, key] of MX_RULES) {
      if (re.test(hosts)) return { key, ...PRESETS[key] };
    }
  } catch {
    // 无 MX 记录时继续走默认
  }

  if (own) return own;

  return {
    key: 'custom',
    name: '自定义邮箱',
    imap: { host: `imap.${domain}`, port: 993, secure: true },
    smtp: { host: `smtp.${domain}`, port: 465, secure: true },
    hint: '未能自动识别邮件服务商，已按常见规则推测服务器地址，如登录失败请在「高级设置」中手动填写。',
  };
}
