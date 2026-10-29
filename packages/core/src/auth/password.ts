import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = { N: 16384, r: 8, p: 1 };

/** 生成 `scrypt$N$r$p$saltHex$hashHex` 形式的密码哈希 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, SCRYPT_COST);
  return [
    'scrypt',
    SCRYPT_COST.N,
    SCRYPT_COST.r,
    SCRYPT_COST.p,
    salt.toString('hex'),
    hash.toString('hex'),
  ].join('$');
}

/** 校验密码，任何格式异常都按失败处理 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4]!, 'hex');
    const expected = Buffer.from(parts[5]!, 'hex');
    const actual = scryptSync(password.normalize('NFKC'), salt, expected.length, { N, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 会话令牌：给客户端的是原文，库里只存 sha256 */
export function newSessionToken(): string {
  return 'sess_' + randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 密码强度的最低检查 */
export function passwordProblem(password: string): string | null {
  if (password.length < 6) return '密码至少 6 位';
  if (password.length > 128) return '密码最多 128 位';
  if (/^\d+$/.test(password)) return '密码不能是纯数字';
  return null;
}
