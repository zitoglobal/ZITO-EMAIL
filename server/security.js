import crypto from 'node:crypto';

const DEV_SECRET = 'zito-smart-mail-dev-secret';
const rawSecret = process.env.MAIL_SECRET;
const isProd = process.env.NODE_ENV === 'production';

if (isProd && (!rawSecret || !String(rawSecret).trim() || String(rawSecret).trim() === DEV_SECRET || String(rawSecret).trim() === 'change-me-to-a-long-random-string')) {
  console.error('[security] 生产环境必须设置强随机 MAIL_SECRET（勿使用默认/示例值），进程退出');
  process.exit(1);
}
if (!rawSecret) {
  console.warn('[security] 警告：未设置 MAIL_SECRET，邮箱密码将使用默认密钥加密，请在生产环境配置');
}

const SECRET = String(rawSecret || DEV_SECRET);

/** 旧版：SHA-256(secret) 直接作 AES 密钥（仍可解密历史密文） */
const KEY_LEGACY = crypto.createHash('sha256').update(SECRET).digest();

/** 新版：HKDF 派生，降低「直接哈希当密钥」的风险 */
const KEY = Buffer.from(
  crypto.hkdfSync('sha256', Buffer.from(SECRET, 'utf8'), Buffer.from('zito-mail'), Buffer.from('aes-256-gcm-v2'), 32)
);

function pack(iv, tag, enc) {
  return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

function unpack(payload) {
  const parts = String(payload).split('.');
  if (parts.length !== 3) throw new Error('密文格式无效');
  return parts.map((s) => Buffer.from(s, 'base64'));
}

function aesDecrypt(key, payload) {
  const [iv, tag, enc] = unpack(payload);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** AES-256-GCM；新密文带 v2. 前缀，旧密文无前缀仍可读 */
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return 'v2.' + pack(iv, cipher.getAuthTag(), enc);
}

export function decrypt(payload) {
  const s = String(payload || '');
  if (s.startsWith('v2.')) return aesDecrypt(KEY, s.slice(3));
  try {
    return aesDecrypt(KEY, s);
  } catch {
    return aesDecrypt(KEY_LEGACY, s);
  }
}

/** 备份等大文件：整文件 AES-GCM（独立用 BACKUP_SECRET 或回退 MAIL_SECRET） */
export function fileEncryptKey() {
  const raw = String(process.env.BACKUP_SECRET || SECRET);
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(raw, 'utf8'), Buffer.from('zito-mail-backup'), Buffer.from('file-aes-gcm-v1'), 32)
  );
}

export function encryptBuffer(buf, key = fileEncryptKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  // magic ZMB1 | iv(12) | tag(16) | ciphertext
  return Buffer.concat([Buffer.from('ZMB1'), iv, tag, enc]);
}

export function decryptBuffer(buf, key = fileEncryptKey()) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 + 12 + 16) throw new Error('备份文件损坏');
  if (buf.subarray(0, 4).toString('utf8') !== 'ZMB1') throw new Error('不是加密备份（期望 ZMB1）');
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const enc = buf.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
