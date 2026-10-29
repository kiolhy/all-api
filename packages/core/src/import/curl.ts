import type { HttpMethod } from '../schema/asset.ts';
import type { RequestSpec } from './types.ts';

/**
 * curl 解析器：不执行任何东西，纯文本解析。
 * 支持：-X/--request、-H/--header、-d 及其变体、-F/--form、-u/--user、-b/--cookie、
 *      -A、-e、--url、反斜杠换行续行、单双引号、$'...' 形式。
 */

const FLAGS_WITH_VALUE = new Set([
  '-X',
  '--request',
  '-H',
  '--header',
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-ascii',
  '--data-urlencode',
  '-F',
  '--form',
  '--form-string',
  '-u',
  '--user',
  '-b',
  '--cookie',
  '-A',
  '--user-agent',
  '-e',
  '--referer',
  '--url',
  '-o',
  '--output',
  '--connect-timeout',
  '-m',
  '--max-time',
  '--retry',
  '-x',
  '--proxy',
  '--cacert',
  '--cert',
  '--key',
  '-w',
  '--write-out',
  '--resolve',
  '--interface',
  '--limit-rate',
]);

const IGNORED_FLAGS = new Set([
  '-s',
  '--silent',
  '-S',
  '--show-error',
  '-L',
  '--location',
  '-k',
  '--insecure',
  '-v',
  '--verbose',
  '-i',
  '--include',
  '--compressed',
  '-f',
  '--fail',
  '--no-progress-meter',
  '-#',
  '--progress-bar',
  '-g',
  '--globoff',
  '-N',
  '--no-buffer',
  '--http1.1',
  '--http2',
  '--tlsv1.2',
  '--location-trusted',
  '-4',
  '-6',
]);

/** 合并续行并切词 */
export function tokenizeCurl(input: string): string[] {
  const joined = input
    .replace(/\r\n/g, '\n')
    .replace(/\\\n/g, ' ')
    .replace(/\^\n/g, ' ')
    .replace(/`\n/g, ' ');

  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  let ansiC = false;

  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];

    if (quote === null && ch === '$' && joined[i + 1] === "'") {
      ansiC = true;
      quote = "'";
      started = true;
      i++;
      continue;
    }

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        ansiC = false;
        continue;
      }
      if (quote === '"' && ch === '\\') {
        const next = joined[i + 1];
        if (next === undefined) continue;
        if (next === 'n') cur += '\n';
        else if (next === 't') cur += '\t';
        else if (next === 'r') cur += '\r';
        else cur += next;
        i++;
        continue;
      }
      if (ansiC && ch === '\\') {
        const next = joined[i + 1];
        if (next === 'n') cur += '\n';
        else if (next === 't') cur += '\t';
        else if (next === '\\') cur += '\\';
        else if (next === "'") cur += "'";
        else cur += next ?? '';
        i++;
        continue;
      }
      cur += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && joined[i + 1] !== undefined) {
      cur += joined[i + 1];
      i++;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur.length) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur.length) tokens.push(cur);
  return tokens;
}

export function looksLikeCurl(text: string): boolean {
  return /^\s*(?:\$\s*)?(?:curl|wget)\b/m.test(text) || /curl\s+['"]?https?:\/\//.test(text);
}

export function parseCurl(input: string): RequestSpec[] {
  const specs: RequestSpec[] = [];
  // 一次可能贴多条 curl：按行首 curl 切块
  const blocks = splitCurlBlocks(input);
  for (const block of blocks) {
    const spec = parseSingle(block);
    if (spec) specs.push(spec);
  }
  return specs;
}

function splitCurlBlocks(input: string): string[] {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  const startRe = /^\s*(?:\$\s*)?(?:curl|wget)\s/;
  for (const line of lines) {
    if (startRe.test(line) && cur.length) {
      blocks.push(cur.join('\n'));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks.filter((b) => startRe.test(b.split('\n')[0] ?? ''));
}

function parseSingle(block: string): RequestSpec | null {
  const tokens = tokenizeCurl(block);
  if (!tokens.length) return null;
  const tool = tokens[0].toLowerCase();
  if (tool !== 'curl' && tool !== 'wget') return null;

  let url = '';
  let method: HttpMethod | '' = '';
  const headers: Record<string, string> = {};
  const formParts: string[] = [];
  const dataParts: string[] = [];
  let dataEncoding: string | null = null;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;

    // --flag=value 形式
    const eq = t.startsWith('--') ? t.indexOf('=') : -1;
    const flag = eq > 0 ? t.slice(0, eq) : t;
    const inlineValue = eq > 0 ? t.slice(eq + 1) : undefined;

    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const v = tokens[++i];
      return v ?? '';
    };

    if (flag === '-X' || flag === '--request') {
      method = takeValue().toUpperCase() as HttpMethod;
      continue;
    }
    if (flag === '-H' || flag === '--header') {
      const raw = takeValue();
      const idx = raw.indexOf(':');
      if (idx > 0) {
        const k = raw.slice(0, idx).trim();
        const v = raw.slice(idx + 1).trim();
        if (k) headers[k] = v;
      }
      continue;
    }
    if (flag === '-d' || flag === '--data' || flag === '--data-ascii') {
      dataParts.push(takeValue());
      dataEncoding = 'form';
      continue;
    }
    if (flag === '--data-raw' || flag === '--data-binary' || flag === '--data-urlencode') {
      dataParts.push(takeValue());
      if (!dataEncoding) dataEncoding = flag === '--data-urlencode' ? 'form' : 'raw';
      continue;
    }
    if (flag === '-F' || flag === '--form' || flag === '--form-string') {
      formParts.push(takeValue());
      continue;
    }
    if (flag === '-u' || flag === '--user') {
      headers['Authorization'] = `Basic ${Buffer.from(takeValue()).toString('base64')}`;
      continue;
    }
    if (flag === '-b' || flag === '--cookie') {
      headers['Cookie'] = takeValue();
      continue;
    }
    if (flag === '-A' || flag === '--user-agent') {
      headers['User-Agent'] = takeValue();
      continue;
    }
    if (flag === '-e' || flag === '--referer') {
      headers['Referer'] = takeValue();
      continue;
    }
    if (flag === '--url') {
      url = takeValue();
      continue;
    }
    if (FLAGS_WITH_VALUE.has(flag)) {
      takeValue();
      continue;
    }
    if (IGNORED_FLAGS.has(flag)) continue;
    if (t.startsWith('-')) continue;

    if (!url) url = t;
  }

  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const query: Record<string, string> = {};
  for (const [k, v] of parsed.searchParams) query[k] = v;

  let bodyRaw: string | null = null;
  let bodyContentType: string | null = headers['Content-Type'] ?? null;

  if (formParts.length) {
    const boundary = `----aah${Math.random().toString(16).slice(2, 10)}`;
    const parts: string[] = [];
    for (const f of formParts) {
      const idx = f.indexOf('=');
      const name = idx > 0 ? f.slice(0, idx) : f;
      const value = idx > 0 ? f.slice(idx + 1) : '';
      if (value.startsWith('@')) {
        parts.push(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="upload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n<FILE:${value.slice(1)}>\r\n`,
        );
      } else {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
      }
    }
    bodyRaw = `${parts.join('')}--${boundary}--\r\n`;
    bodyContentType = `multipart/form-data; boundary=${boundary}`;
  } else if (dataParts.length) {
    const joined = dataParts.join('&');
    const isJson = /^\s*[[{]/.test(joined);
    bodyRaw = joined;
    if (!bodyContentType) bodyContentType = isJson ? 'application/json' : 'application/x-www-form-urlencoded';
    if (dataEncoding === 'form' && !isJson && !bodyContentType.includes('json')) {
      bodyContentType = bodyContentType || 'application/x-www-form-urlencoded';
    }
  }

  const finalMethod = (method || (bodyRaw ? 'POST' : 'GET')) as HttpMethod;

  return {
    method: finalMethod,
    url: `${parsed.origin}${parsed.pathname}`,
    headers,
    query,
    bodyRaw,
    bodyContentType,
    source: 'curl',
  };
}
