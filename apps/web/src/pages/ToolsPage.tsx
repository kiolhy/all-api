import { useState } from 'react';
import { api } from '../api.ts';
import { Badge, CodeBadge } from '../components/Badge.tsx';
import { Empty, ErrorBox } from '../components/Empty.tsx';
import { Field, FormGrid, TextArea, TextInput, Toggle } from '../components/Field.tsx';
import { JsonView } from '../components/JsonView.tsx';
import { Modal } from '../components/Modal.tsx';
import { DataTable } from '../components/Table.tsx';
import type { Column } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { looksLikeUpstreamName } from '../handoff.ts';
import { copyText, formatTime } from '../format.ts';
import { bumpData, errorMessage, useDataRev, useResource } from '../hooks.ts';
import type { Tool } from '../types.ts';

const MCP_COMMAND = 'node';
const MCP_ARGS = ['D:/project/各个平台接口/apps/mcp/src/index.ts'];

function buildMcpConfig(): string {
  return JSON.stringify(
    {
      mcpServers: {
        'api-asset-hub': {
          command: MCP_COMMAND,
          args: MCP_ARGS,
          env: {
            HUB_BASE_URL: 'http://127.0.0.1:8778',
            HUB_API_KEY: 'hub_live_把控制台「密钥」页生成的 key 粘这里',
          },
        },
      },
    },
    null,
    2,
  );
}

export function ToolsPage() {
  const toast = useToast();
  const rev = useDataRev();
  const tools = useResource(() => api.tools.list(), [rev]);

  const [busyId, setBusyId] = useState('');
  const [rebuilding, setRebuilding] = useState(false);
  const [cacheDraft, setCacheDraft] = useState<Record<string, string>>({});

  const [editing, setEditing] = useState<Tool | null>(null);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');  const [description, setDescription] = useState('');
  const [cacheTtl, setCacheTtl] = useState('0');
  const [namespace, setNamespace] = useState('');
  const [saving, setSaving] = useState(false);
  const leakyName = looksLikeUpstreamName(name.trim());

  const [mcpOpen, setMcpOpen] = useState(false);
  const mcpJson = buildMcpConfig();

  const openEdit = (tool: Tool) => {
    setEditing(tool);
    setName(tool.name ?? '');
    setTitle(tool.title ?? '');
    setDescription(tool.description ?? '');
    setCacheTtl(String(tool.cacheTtl ?? 0));
    setNamespace(tool.namespace ?? '');
  };

  const patch = async (tool: Tool, body: Parameters<typeof api.tools.update>[1], successText: string) => {
    setBusyId(tool.id);
    try {
      await api.tools.update(tool.id, body);
      toast.success(successText);
      tools.reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId('');
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const ttl = Number(cacheTtl);
    if (!Number.isFinite(ttl) || ttl < 0) {
      toast.error('cacheTtl 需要是 ≥0 的整数');
      return;
    }
    const nextName = name.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(nextName)) {
      toast.error('对外名字只能用字母、数字、下划线、短横线，长度 1–64');
      return;
    }
    setSaving(true);
    try {
      await api.tools.update(editing.id, {
        name: nextName,
        title,
        description,
        cacheTtl: Math.round(ttl),
        namespace,
      });
      toast.success(`${nextName} 已保存`);
      setEditing(null);
      tools.reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const rebuild = async () => {
    setRebuilding(true);
    try {
      const res = await api.tools.rebuild();
      toast.success(`已重编译 ${res.rebuilt ?? 0} 个工具`);
      tools.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRebuilding(false);
    }
  };

  const commitCacheTtl = async (tool: Tool) => {
    const draft = cacheDraft[tool.id];
    if (draft === undefined) return;
    const ttl = Number(draft);
    if (!Number.isFinite(ttl) || ttl < 0) {
      toast.error('cacheTtl 需要是 ≥0 的整数');
      return;
    }
    if (Math.round(ttl) === tool.cacheTtl) {
      setCacheDraft((prev) => {
        const next = { ...prev };
        delete next[tool.id];
        return next;
      });
      return;
    }
    await patch(tool, { cacheTtl: Math.round(ttl) }, `${tool.name} 缓存改为 ${Math.round(ttl)}s`);
    setCacheDraft((prev) => {
      const next = { ...prev };
      delete next[tool.id];
      return next;
    });
  };

  const columns: Column<Tool>[] = [
    {
      key: 'name',
      title: '工具',
      width: '220px',
      render: (tool) => (
        <div className="cell-stack">
          <span className="mono strong">{tool.name}</span>
          <span className="dim small">{tool.title || '—'}</span>
        </div>
      ),
    },
    {
      key: 'owner',
      title: '来源',
      render: (tool) => (
        <div className="method-line">
          <CodeBadge>{tool.platformSlug || '—'}</CodeBadge>
          <span className="mono dim">{tool.endpointSlug || '—'}</span>
        </div>
      ),
    },
    {
      key: 'enabled',
      title: '启用',
      width: '80px',
      render: (tool) => (
        <Toggle
          checked={tool.enabled}
          disabled={busyId === tool.id}
          onChange={(next) =>
            void patch(tool, { enabled: next }, `${tool.name} ${next ? '已启用' : '已停用'}`)
          }
        />
      ),
    },
    {
      key: 'cacheTtl',
      title: 'cacheTtl',
      width: '110px',
      align: 'right',
      render: (tool) => (
        <input
          className="input mono sm-input"
          value={cacheDraft[tool.id] ?? String(tool.cacheTtl ?? 0)}
          onChange={(event) =>
            setCacheDraft((prev) => ({ ...prev, [tool.id]: event.target.value }))
          }
          onBlur={() => void commitCacheTtl(tool)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void commitCacheTtl(tool);
          }}
          inputMode="numeric"
        />
      ),
    },
    {
      key: 'readOnly',
      title: '只读',
      width: '80px',
      render: (tool) =>
        tool.annotations?.readOnly ? (
          <Badge tone="green">只读</Badge>
        ) : (
          <Badge tone="orange">写操作</Badge>
        ),
    },
    {
      key: 'updatedAt',
      title: '更新时间',
      width: '150px',
      render: (tool) => <span className="mono dim">{formatTime(tool.updatedAt)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      width: '120px',
      align: 'right',
      render: (tool) => (
        <div className="row-actions">
          <button type="button" className="btn sm ghost" onClick={() => openEdit(tool)}>
            编辑
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">工具</h1>
          <div className="page-sub">AI 侧看到的工具视图，标题/描述会直接进 MCP 与 OpenAPI</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn ghost" onClick={() => tools.reload()}>
            刷新
          </button>
          <button type="button" className="btn ghost" onClick={() => setMcpOpen(true)}>
            复制 MCP 配置
          </button>
          <button type="button" className="btn primary" onClick={() => void rebuild()} disabled={rebuilding}>
            {rebuilding ? '重编译中…' : '重编译全部'}
          </button>
        </div>
      </header>

      {tools.error ? (
        <ErrorBox message={tools.error} onRetry={tools.reload} />
      ) : (
        <section className="card">
          <DataTable
            columns={columns}
            rows={tools.data ?? []}
            rowKey={(tool) => tool.id}
            loading={tools.loading}
            renderExpanded={(tool) => (
              <div className="expand-panel">
                <div className="expand-grid">
                  <div>
                    <div className="sub-title">描述</div>
                    <div className="dim">{tool.description || '（空）'}</div>
                    <div className="kv-grid" style={{ marginTop: 12 }}>
                      <div className="kv-row">
                        <span className="kv-key">namespace</span>
                        <span className="kv-val mono">{tool.namespace || '—'}</span>
                      </div>
                      <div className="kv-row">
                        <span className="kv-key">destructive</span>
                        <span className="kv-val mono">{String(tool.annotations?.destructive ?? false)}</span>
                      </div>
                      <div className="kv-row">
                        <span className="kv-key">idempotent</span>
                        <span className="kv-val mono">{String(tool.annotations?.idempotent ?? true)}</span>
                      </div>
                      <div className="kv-row">
                        <span className="kv-key">endpointId</span>
                        <span className="kv-val mono dim">{tool.endpointId || '—'}</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="sub-title">inputSchema</div>
                    <JsonView value={tool.inputSchema} maxHeight={260} />
                  </div>
                </div>
              </div>
            )}
            empty={
              <Empty
                title="还没有工具"
                hint="接口发布后会自动生成工具。去「接口资产」发布一个接口试试。"
                action={
                  <button
                    type="button"
                    className="btn primary sm"
                    onClick={() => {
                      window.location.hash = '/endpoints';
                    }}
                  >
                    去接口资产
                  </button>
                }
              />
            }
          />
        </section>
      )}

      <Modal
        open={editing !== null}
        title={`编辑工具 · ${editing?.name ?? ''}`}
        subtitle="标题与描述直接影响 AI 的工具选择，写清楚用途与边界"
        onClose={() => setEditing(null)}
        width={560}
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setEditing(null)} disabled={saving}>
              取消
            </button>
            <button type="button" className="btn primary" onClick={() => void saveEdit()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <FormGrid>
          <Field
            label="对外名字"
            span
            hint="调用方唯一看得到的标识。别写上游域名、路径或端口 —— 网关把地址掩了，名字里带出来等于白掩"
          >
            <TextInput mono value={name} onChange={(event) => setName(event.target.value)} placeholder="query_orders" />
          </Field>
          {leakyName ? (
            <div className="notice warn" style={{ gridColumn: '1 / -1' }}>
              这个名字里带着上游痕迹（IP、端口或 <code className="mono">/api/</code> 路径）。
              对方拿到名字就知道原始接口在哪了，建议改成业务含义，比如 <code className="mono">query_orders</code>。
            </div>
          ) : null}
          <Field label="标题" span>
            <TextInput value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="描述" span>
            <TextArea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          <Field label="cacheTtl（秒）" hint="0 表示不缓存">
            <TextInput mono value={cacheTtl} onChange={(event) => setCacheTtl(event.target.value)} />
          </Field>
          <Field label="namespace" hint="覆盖默认描述前缀，可留空">
            <TextInput mono value={namespace} onChange={(event) => setNamespace(event.target.value)} />
          </Field>
        </FormGrid>
      </Modal>

      <Modal
        open={mcpOpen}
        title="MCP 客户端配置"
        subtitle="贴到 Claude Desktop / Cursor 的 mcpServers 里，env.HUB_API_KEY 用控制台生成的 key"
        onClose={() => setMcpOpen(false)}
        width={640}
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setMcpOpen(false)}>
              关闭
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                void copyText(mcpJson).then((ok) => {
                  if (ok) toast.success('MCP 配置已复制');
                  else toast.error('复制失败，请手动选中文本');
                });
              }}
            >
              复制 JSON
            </button>
          </>
        }
      >
        <pre className="json mono" style={{ maxHeight: 380 }}>
          {mcpJson}
        </pre>
      </Modal>
    </>
  );
}
