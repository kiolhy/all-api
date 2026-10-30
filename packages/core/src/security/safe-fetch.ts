/**
 * 受控出网客户端
 *
 * 项目里所有"服务端替用户发起的请求"都必须走这里，不能裸 `fetch`：
 *   - invoke（网关转发上游）
 *   - probe（整理时探测上游）
 *   - 平台试运行 / 端点试运行
 *   - 站点标题抓取
 *   - LLM 调用（chatJson）
 *
 * 它做的事，按顺序：
 *   1. 校验 URL 形态（协议、userinfo、端口）
 *   2. DNS 解析 → 逐个地址判定是否内网/保留（挡 DNS rebinding 第一跳）
 *   3. **把连接锁到已校验的那个 IP**（挡 rebinding 第二跳：第二次解析换 IP）
 *   4. 不跟随重定向（3xx 交回调用方，由调用方逐跳重新校验）
 *   5. 超时 + 响应体上限
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { hubError } from '../invoke/guard.ts';
import { loadConfig } from '../config.ts';
import { resolveAndCheckTarget } from './egress.ts';

export type SafeFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
  /** 私网是否允许（服务端策略）；默认 false */
  allowPrivate?: boolean;
  /** 允许的主机白名单；空表示不额外限制主机 */
  allowHosts?: string[];
  /** 目标端口白名单（留空表示不限制，仅受 allowPrivate 约束） */
  allowPorts?: number[];
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
};

export type SafeFetchResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** 原始字节数（截断前） */
  bytes: number;
  truncated: boolean;
  /** 实际连上的地址（审计用，不回给调用方） */
  address: string;
  /** 实际请求的 host（含端口） */
  host: string;
};

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function deadlineSignal(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onOuter = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onOuter, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuter);
    },
  };
}

function readCapped(res: IncomingMessage, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    res.on('data', (chunk: Buffer) => {
      if (truncated) return;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        const room = maxBytes - (bytes - chunk.byteLength);
        if (room > 0) chunks.push(chunk.subarray(0, room));
        truncated = true;
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });
    const finish = () => {
      const buf = Buffer.concat(chunks).subarray(0, maxBytes);
      resolve({ text: buf.toString('utf8'), bytes, truncated });
    };
    res.on('end', finish);
    res.on('close', finish);
    res.on('error', (err) => {
      // destroy() 之后会触发一次 error，属于我们自己截断的结果，不当失败
      if (truncated) finish();
      else reject(err);
    });
  });
}

/** 把 node 的错误翻成人能看懂的 code */
function classifyError(err: NodeJS.ErrnoException): never {
  const code = err.code ?? '';
  if (code === 'ECONNREFUSED') throw hubError('upstream_unreachable', '连接被拒绝（端口未监听）', 502);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw hubError('egress_dns_failed', '目标主机解析失败', 502);
  if (code === 'ETIMEDOUT' || err.message === 'timeout') throw hubError('upstream_timeout', '请求超时', 504);
  if (code === 'ECONNRESET') throw hubError('upstream_reset', '连接被重置', 502);
  if (code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
    throw hubError('upstream_tls_failed', 'TLS 握手失败（对端可能不是 HTTPS 服务）', 502);
  }
  // HPE_* 是 HTTP 解析错误：对端在说话，但不是 HTTP
  // （最常见的真实原因：这个端口跑的是别的协议，比如 redis/mysql/裸 TCP）
  if (code.startsWith('HPE_')) {
    throw hubError('upstream_not_http', '对端不是 HTTP 服务（响应无法解析）', 502);
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code.startsWith('ERR_TLS')) {
    throw hubError('upstream_tls_failed', '上游证书校验失败', 502);
  }
  throw hubError('upstream_failed', err.message || '请求失败', 502);
}

/**
 * 发一个受控的 HTTP(S) 请求。
 *
 * 与 `fetch` 的差异（都是有意的）：
 *   - 连接地址用**已校验的 IP**，`Host` 头仍用原域名 → rebinding 无效
 *   - `redirect: 'manual'` 是唯一行为，不提供自动跟随
 *   - 不自动解压、不自动重试（调用方自己决定）
 *
 * 私网放行是**双重条件**：调用方要显式传 allowPrivate，
 * 且服务端开关 ALLOW_PRIVATE_EGRESS 必须为 true。
 * 这样即便某处忘记收窄，也不会因为一个参数就把内网打开。
 *
 * 注意服务端开关读的是 loadConfig().allowPrivateEgress，而不是直接读
 * process.env：配置来源可能有 .env 文件，只查 process.env 会在
 * "env 文件里开了但进程变量没设"时悄悄把私网关掉（表现为莫名其妙的
 * egress_private_blocked），排查方向完全跑偏。
 */
export async function safeFetch(url: string | URL, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const target = typeof url === 'string' ? new URL(url) : url;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const privateOk = Boolean(opts.allowPrivate) && loadConfig().allowPrivateEgress;

  const { url: checked, addresses } = await resolveAndCheckTarget(target, {
    allowPrivate: privateOk,
    allowHosts: opts.allowHosts,
  });

  const port = checked.port
    ? Number(checked.port)
    : checked.protocol === 'https:'
      ? 443
      : 80;
  if (opts.allowPorts?.length && !opts.allowPorts.includes(port)) {
    throw hubError('egress_port_blocked', `目标端口 ${port} 不在允许列表内`, 403);
  }

  const address = addresses[0]!;
  const isHttps = checked.protocol === 'https:';
  const doRequest = isHttps ? httpsRequest : httpRequest;
  const { signal, done } = deadlineSignal(timeoutMs, opts.signal);
  // IPv6 字面量要脱掉方括号才能给 net 用
  const bareHost = checked.hostname.replace(/^\[|\]$/g, '');

  const bodyBuf = opts.body === null || opts.body === undefined ? null : Buffer.from(opts.body);
  const headers: Record<string, string | number> = { ...(opts.headers ?? {}) };
  if (bodyBuf) headers['content-length'] = bodyBuf.byteLength;
  // Host 头必须是原域名（证书校验 / 虚拟主机都依赖它），连接却锁在已校验 IP 上
  headers.host = checked.host;

  try {
    return await new Promise<SafeFetchResult>((resolve, reject) => {
      const req = doRequest({
        protocol: checked.protocol,
        hostname: bareHost,
        port,
        path: `${checked.pathname}${checked.search}`,
        method: opts.method ?? 'GET',
        headers,
        // 关键：连接锁到已校验的 IP，DNS 只用来"决定能不能连"，不再参与连接
        lookup: (
          _hostname: string,
          _options: unknown,
          cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
        ) => {
          cb(null, address, isIP(address) === 6 ? 6 : 4);
        },
        rejectUnauthorized: true,
        signal,
        servername: isIP(bareHost) ? undefined : checked.hostname,
      });

      req.on('error', (err) => {
        try {
          classifyError(err as NodeJS.ErrnoException);
        } catch (mapped) {
          reject(mapped);
        }
      });

      req.on('response', (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        readCapped(res, maxBytes).then(({ text, bytes, truncated }) => {
          resolve({
            status,
            headers: res.headers as Record<string, string | string[] | undefined>,
            text,
            bytes,
            truncated,
            address,
            host: checked.host,
          });
        }, reject);
      });

      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  } finally {
    done();
  }
}

/** 只取状态码与响应头，不读 body（端口探测/连通性检查用） */
export async function probeReachability(
  url: string | URL,
  opts: SafeFetchOptions = {},
): Promise<{ status: number; host: string }> {
  const r = await safeFetch(url, { ...opts, maxBytes: 0 });
  return { status: r.status, host: r.host };
}
