import { useMemo, useState } from 'react';
import { api } from '../api.ts';
import { Badge } from '../components/Badge.tsx';
import { Empty, ErrorBox, Loading } from '../components/Empty.tsx';
import { useToast } from '../components/Toast.tsx';
import { copyText } from '../format.ts';
import {
  ERROR_ROWS,
  buildHandoffPack,
  exampleArgs,
  looksLikeUpstreamName,
  looksLikeUpstreamPath,
  schemaOf,
} from '../handoff.ts';
import { errorMessage, useResource } from '../hooks.ts';
import type { ApiKey, Tool } from '../types.ts';

/* ────────────────────────── 小件 ────────────────────────── */

function CodeBlock(props: { code: string; tall?: boolean }) {
  const toast = useToast();
  return (
    <div className="code-block">
      <button
        type="button"
        className="code-copy"
        onClick={() => {
          void copyText(props.code).then((ok) => {
            if (ok) toast.success('已复制');
            else toast.error('复制失败，请手动选中');
          });
        }}
      >
        复制
      </button>
      <pre className={`mono${props.tall ? ' tall' : ''}`}>{props.code}</pre>
    </div>
  );
}

function ToolRow(props: { tool: Tool }) {
  const { tool } = props;
  const [open, setOpen] = useState(false);
  const rows = Object.entries(schemaOf(tool).properties ?? {});
  const required = new Set(schemaOf(tool).required ?? []);
  const leaky = looksLikeUpstreamPath(tool.title) || looksLikeUpstreamPath(tool.description);

  return (
    <div className={`tool-doc${open ? ' is-open' : ''}`}>
      <button type="button" className="tool-doc-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-doc-caret">{open ? '▾' : '▸'}</span>
        <span className="mono tool-doc-name">{tool.name}</span>
        <span className="tool-doc-title">{tool.title || '未命名'}</span>
        <span className="tool-doc-badges">
          {tool.annotations?.readOnly ? <Badge tone="green">只读</Badge> : <Badge tone="orange">写入</Badge>}
          {leaky ? <Badge tone="red">介绍含上游路径</Badge> : null}
        </span>
      </button>
      {open ? (
        <div className="tool-doc-body">
          {tool.description ? <p className="tool-doc-desc">{tool.description}</p> : null}
          {leaky ? (
            <div className="notice warn">
              标题或介绍里带着上游路径，交给别的 AI 就等于暴露原始接口。
              开启 AI 分析后重新发布即可换成中文说明。
            </div>
          ) : null}
          {rows.length === 0 ? (
            <p className="dim">无需参数。</p>
          ) : (
            <table className="tool-param-table">
              <thead>
                <tr>
                  <th>参数</th>
                  <th>类型</th>
                  <th>必填</th>
                  <th>说明</th>
                  <th>示例</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([name, p]) => (
                  <tr key={name}>
                    <td className="mono">{name}</td>
                    <td className="mono dim">{p.type ?? 'string'}</td>
                    <td>{required.has(name) ? <Badge tone="red">必填</Badge> : <span className="dim">否</span>}</td>
                    <td className="dim">
                      {p.description ||
                        (Array.isArray(p.enum) && p.enum.length ? `可选：${p.enum.join(' / ')}` : '—')}
                    </td>
                    <td className="mono dim">{String(exampleArgs(tool)[name] ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ────────────────────────── 页面 ────────────────────────── */

export function DocsPage() {
  const toast = useToast();
  const tools = useResource(() => api.tools.list(), []);
  const keys = useResource(() => api.apiKeys.list().catch(() => [] as ApiKey[]), []);

  const [keyInput, setKeyInput] = useState('');
  const [freshKey, setFreshKey] = useState('');
  const [creating, setCreating] = useState(false);
  const [includeErrors, setIncludeErrors] = useState(true);
  const [includeLeakyMeta, setIncludeLeakyMeta] = useState(false);

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8778';
  const effectiveKey = freshKey || keyInput;

  const published = useMemo(() => (tools.data ?? []).filter((t) => t.enabled), [tools.data]);

  const leakyCount = useMemo(
    () =>
      published.filter((t) => looksLikeUpstreamPath(t.title) || looksLikeUpstreamPath(t.description)).length,
    [published],
  );

  // 名字是调用凭据，接入包裁不掉 —— 只能靠改名
  const leakyNameCount = useMemo(
    () => published.filter((t) => looksLikeUpstreamName(t.name)).length,
    [published],
  );

  const pack = useMemo(
    () => buildHandoffPack({ baseUrl, key: effectiveKey, tools: published, includeErrors, includeLeakyMeta }),
    [baseUrl, effectiveKey, published, includeErrors, includeLeakyMeta],
  );

  const createKey = async () => {
    setCreating(true);
    try {
      const created = await api.apiKeys.create({ label: `AI 接入 ${new Date().toLocaleDateString('zh-CN')}` });
      setFreshKey(created.key);
      keys.reload();
      toast.success('令牌已创建，明文只显示这一次');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const download = () => {
    const blob = new Blob([pack], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'api-handoff.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">交给其他 AI</h1>
          <div className="page-sub">
            生成一段接入说明，粘给任何 AI 客户端，它就能直接调你的网关 —— 不用知道上游是谁
          </div>
        </div>
      </header>

      {/* 第 1 步：令牌 */}
      <section className="card">
        <div className="card-head">
          <div className="card-title">1 · 选一个令牌</div>
          <div className="card-sub">对方拿这个 key 来调你的网关</div>
        </div>
        <div className="card-body">
          <div className="handoff-row">
            <button type="button" className="btn" onClick={() => void createKey()} disabled={creating}>
              {creating ? '创建中…' : '新建一个令牌'}
            </button>
            <span className="dim">
              一键建一个专用令牌，明文只显示这一次。之后可以在「密钥与令牌」里禁用或调整配额。
            </span>
          </div>

          {freshKey ? (
            <div className="notice ok" style={{ marginTop: 10 }}>
              <div style={{ marginBottom: 6 }}>
                <b>新令牌已创建</b>，下面的接入包已经自动带上它：
              </div>
              <code className="mono key-line">{freshKey}</code>
            </div>
          ) : null}

          <div className="handoff-row" style={{ marginTop: 12 }}>
            <span className="dim" style={{ flex: 'none' }}>
              或粘贴已有令牌：
            </span>
            <input
              className="input"
              placeholder="hub_live_..."
              value={freshKey ? '' : keyInput}
              disabled={Boolean(freshKey)}
              onChange={(e) => setKeyInput(e.target.value)}
            />
          </div>
          <div className="dim small" style={{ marginTop: 6 }}>
            已有令牌的明文只在创建时显示过一次，库里存的是哈希 —— 所以这里需要你粘进来。
            不粘也能生成接入包，只是里面是占位符。
          </div>

          {(keys.data ?? []).length > 0 ? (
            <div className="dim small" style={{ marginTop: 10 }}>
              现有令牌：
              {(keys.data ?? []).map((k) => (
                <span key={k.id} className="mono handoff-keychip">
                  {k.label}
                  {k.enabled ? '' : '（已禁用）'}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {/* 第 2 步：接入包 */}
      <section className="card">
        <div className="card-head">
          <div className="card-title">2 · 复制接入包</div>
          <div className="card-sub">整段贴给 AI，它就知道怎么调、能调什么</div>
          <div className="card-actions">
            <label className="check-inline">
              <input
                type="checkbox"
                checked={includeErrors}
                onChange={(e) => setIncludeErrors(e.target.checked)}
              />
              带错误码表
            </label>
            {leakyCount > 0 ? (
              <label className="check-inline" title="默认剔除，避免把原始接口递给对方">
                <input
                  type="checkbox"
                  checked={includeLeakyMeta}
                  onChange={(e) => setIncludeLeakyMeta(e.target.checked)}
                />
                带上游路径
              </label>
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={() => {
                void copyText(pack).then((ok) => {
                  if (ok) toast.success('接入包已复制，直接贴给 AI');
                  else toast.error('复制失败，请手动选中');
                });
              }}
            >
              复制接入包
            </button>
            <button type="button" className="btn ghost" onClick={download}>
              下载 .md
            </button>
          </div>
        </div>
        <div className="card-body">
          {!effectiveKey ? (
            <div className="notice warn">
              还没有令牌，接入包里是 <code className="mono">&lt;把令牌粘这里&gt;</code> 占位符。
              点上面的「新建一个令牌」就会自动填进去。
            </div>
          ) : null}
          {leakyNameCount > 0 ? (
            <div className="notice warn">
              有 <b>{leakyNameCount}</b> 个工具<strong>名字</strong>里带着上游痕迹（IP、端口或{' '}
              <code className="mono">/api/</code> 路径）。
              名字是调用凭据，接入包没法裁掉 —— 对方看到名字就知道原始接口在哪。
              去「工具」页逐个改成业务含义，改完这里会自动跟着变。
            </div>
          ) : null}
          {leakyCount > 0 ? (
            <div className="notice warn">
              有 <b>{leakyCount}</b> 个工具的标题或介绍里带着上游路径（比如{' '}
              <code className="mono">/api/v1/orders</code>）。
              {includeLeakyMeta ? (
                <>你勾了「带上游路径」，这些文字会原样进入接入包 —— 等于把原始接口告诉对方。</>
              ) : (
                <>
                  已自动从接入包剔除，对方只会看到工具名和参数。想补上正经介绍：在「设置」里开启
                  LLM，到「整理记录」重新分析并发布。
                </>
              )}
            </div>
          ) : null}
          <div className="dim small" style={{ marginBottom: 6 }}>
            共 {published.length} 个工具 · {pack.length} 字符
          </div>
          <CodeBlock code={pack} tall />
        </div>
      </section>

      {/* 第 3 步：让 AI 自己读 */}
      <section className="card">
        <div className="card-head">
          <div className="card-title">3 · 或者让 AI 自己来读</div>
          <div className="card-sub">适合支持自助探查的客户端</div>
        </div>
        <div className="card-body">
          <table className="doc-table">
            <thead>
              <tr>
                <th style={{ width: 240 }}>端点</th>
                <th>给 AI 看的东西</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">GET /gw/llms.txt</td>
                <td className="dim">纯文本工具清单，最适合直接塞进上下文</td>
              </tr>
              <tr>
                <td className="mono">GET /gw/v1/tools</td>
                <td className="dim">JSON 工具清单，含 inputSchema</td>
              </tr>
              <tr>
                <td className="mono">GET /gw/openapi.json</td>
                <td className="dim">OpenAPI 3.1，能直接喂给支持 OpenAPI 的工具</td>
              </tr>
              <tr>
                <td className="mono">GET /gw/v1/me</td>
                <td className="dim">当前令牌能调哪些接口、各自的备注</td>
              </tr>
            </tbody>
          </table>
          <div className="dim small" style={{ marginTop: 10, marginBottom: 6 }}>
            这几条都要求 <code className="mono">x-api-key</code>，可以这样试：
          </div>
          <CodeBlock
            code={`curl ${baseUrl}/gw/llms.txt -H 'x-api-key: ${effectiveKey || '<你的令牌>'}'`}
          />
        </div>
      </section>

      {/* 工具明细 */}
      <section className="card">
        <div className="card-head">
          <div className="card-title">工具明细</div>
          <div className="card-sub">已发布且启用的 {published.length} 个接口</div>
        </div>
        {tools.error ? (
          <ErrorBox message={tools.error} onRetry={tools.reload} />
        ) : tools.loading && !tools.data ? (
          <Loading />
        ) : published.length === 0 ? (
          <Empty
            title="还没有已发布的接口"
            hint="先到「一键整理」导入，再到「整理记录」发布，接口就会出现在这里。"
          />
        ) : (
          <div className="card-body tool-doc-list">
            {published.map((tool) => (
              <ToolRow key={tool.id} tool={tool} />
            ))}
          </div>
        )}
      </section>

      {/* 错误码 */}
      <section className="card">
        <div className="card-head">
          <div className="card-title">错误码</div>
          <div className="card-sub">对方调用时可能遇到的</div>
        </div>
        <div className="card-body">
          <table className="doc-table">
            <thead>
              <tr>
                <th style={{ width: 210 }}>code</th>
                <th style={{ width: 70 }}>HTTP</th>
                <th>含义</th>
              </tr>
            </thead>
            <tbody>
              {ERROR_ROWS.map((row) => (
                <tr key={row.code}>
                  <td className="mono">{row.code}</td>
                  <td className="mono num dim">{row.status}</td>
                  <td className="dim">{row.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
