import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDataPath } from '../util/paths.ts';

const PREFIX = 'v1';

let cachedKey: Buffer | null = null;

/** 主密钥文件位置（相对路径锚在项目根，不跟 cwd 走） */
export function masterKeyPath(): string {
  return resolveDataPath(process.env.MASTER_KEY_FILE, './data/master.key');
}

/**
 * 主密钥来源优先级：环境变量 MASTER_KEY(base64, 32B) → 本地 data/master.key（首次自动生成）。
 * 单机自用场景允许自动落盘；团队/多机部署务必用环境变量注入。
 *
 * 注意：如果每次启动都生成新密钥，之前加密的密钥就全部解不开了 ——
 * 所以路径必须稳定，不能跟着 cwd 变。
 */
export function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env.MASTER_KEY?.trim();
  if (env) {
    const buf = Buffer.from(env, 'base64');
    if (buf.length !== 32) throw new Error('MASTER_KEY 必须是 32 字节的 base64 字符串');
    cachedKey = buf;
    return buf;
  }
  const file = masterKeyPath();
  if (existsSync(file)) {
    const buf = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (buf.length === 32) {
      cachedKey = buf;
      return buf;
    }
  }
  const fresh = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fresh.toString('base64'), { mode: 0o600 });
  cachedKey = fresh;
  return fresh;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error('密文格式不正确');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const data = Buffer.from(parts[3], 'base64');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** 字符串内的 ${secret:NAME} 引用 */
export const SECRET_REF_RE = /\$\{secret:([A-Za-z0-9_.-]+)\}/g;

export function hasSecretRef(value: unknown): boolean {
  if (typeof value === 'string') {
    SECRET_REF_RE.lastIndex = 0;
    return SECRET_REF_RE.test(value);
  }
  if (Array.isArray(value)) return value.some(hasSecretRef);
  if (value && typeof value === 'object') return Object.values(value).some(hasSecretRef);
  return false;
}

export function collectSecretRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(SECRET_REF_RE)) out.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) collectSecretRefs(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectSecretRefs(v, out);
  }
  return out;
}

export type SecretResolver = (name: string) => string | null;

/**
 * 密钥引用授权策略。
 *
 * 真实事故：`body.example` / `defaultHeaders` 里的任意 `${secret:NAME}` 都会被无条件解析，
 * 于是匿名者只要知道密钥名（列表接口就能枚举），就能让网关把 vault 里的**任意**密钥
 * 解密出来塞进请求体，再写进可回读的站内存储。
 *
 * 现在的规则（两层）：
 *   1. 结构性位置才允许出现 `${secret:...}`：
 *        - 参数声明 `params[].default`（并带 secretRef，或名字是鉴权类头）
 *        - 平台 `authConfig` / `defaultHeaders`
 *      像 `body.example` 这种"示例/预览"位置一律不许解析。
 *   2. 只有被**显式声明**的密钥名才允许解析：`params[].secretRef`、
 *      平台 `authConfig.secretRef` / `passwordRef`、以及 `defaultHeaders` 里出现过的名字。
 *
 * 这样"按名任意取密文"就不成立了：未声明的名字直接 403。
 */
export type SecretPolicy = {
  allowed: Set<string>;
  /** 记录策略来源，报错时能说清是哪个位置越权 */
  source: Map<string, string>;
};

export function makeSecretPolicy(): SecretPolicy {
  return { allowed: new Set(), source: new Map() };
}

export function allowSecret(policy: SecretPolicy, name: string, why: string): void {
  if (!name) return;
  if (!policy.allowed.has(name)) {
    policy.allowed.add(name);
    policy.source.set(name, why);
  }
}

/**
 * 把 `${secret:NAME}` 替换为明文（仅出网瞬间调用）。
 * 带 policy 时只解析白名单内的名字；不在白名单直接抛错，绝不"顺手解密"。
 */
export function resolveSecretRefs<T>(value: T, resolver: SecretResolver, policy?: SecretPolicy): T {
  if (typeof value === 'string') {
    return value.replace(SECRET_REF_RE, (_all, name: string) => {
      if (policy && !policy.allowed.has(name)) {
        const e = new Error(`密钥引用未获授权：${name}`) as Error & { code: string; status: number };
        e.code = 'secret_ref_forbidden';
        e.status = 403;
        throw e;
      }
      const v = resolver(name);
      if (v === null) throw new Error(`缺少密钥: ${name}`);
      return v;
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveSecretRefs(v, resolver, policy)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveSecretRefs(v, resolver, policy);
    }
    return out as unknown as T;
  }
  return value;
}
