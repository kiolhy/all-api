import { useState } from 'react';
import { api } from '../api.ts';
import { Badge } from '../components/Badge.tsx';
import { Empty, ErrorBox } from '../components/Empty.tsx';
import { Checkbox, Field, Select, TextArea, TextInput } from '../components/Field.tsx';
import { ConfirmDialog, Modal } from '../components/Modal.tsx';
import { DataTable } from '../components/Table.tsx';
import type { Column } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { copyText, formatTime } from '../format.ts';
import { bumpData, errorMessage, useDataRev, useResource } from '../hooks.ts';
import type { ApiKey, CreatedApiKey, KeyEndpoint, QuotaPeriod, SecretMeta } from '../types.ts';
import { QUOTA_PERIODS, QUOTA_PERIOD_LABEL } from '../types.ts';

const parseIpList = (text: string): string[] =>
  text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export function SecretsPage() {
  const toast = useToast();
  const rev = useDataRev();
  const secrets = useResource(() => api.secrets.list(), [rev]);
  const keys = useResource(() => api.apiKeys.list(), [rev]);
  const platforms = useResource(() => api.platforms.list(), [rev]);

  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [hint, setHint] = useState('');
  const [savingSecret, setSavingSecret] = useState(false);
  const [secretToDelete, setSecretToDelete] = useState<SecretMeta | null>(null);
  const [deletingSecret, setDeletingSecret] = useState(false);

  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [newQuota, setNewQuota] = useState('0');
  const [newPeriod, setNewPeriod] = useState<QuotaPeriod>('total');
  const [newExpires, setNewExpires] = useState('');
  const [newIpList, setNewIpList] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<ApiKey | null>(null);
  const [deletingKey, setDeletingKey] = useState(false);
  const [busyKeyId, setBusyKeyId] = useState('');

  // 编辑令牌
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editQuota, setEditQuota] = useState('0');
  const [editPeriod, setEditPeriod] = useState<QuotaPeriod>('total');
  const [editExpires, setEditExpires] = useState('');
  const [editIpList, setEditIpList] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  // 可见接口预览
  const [viewingKey, setViewingKey] = useState<ApiKey | null>(null);
  const [keyEndpoints, setKeyEndpoints] = useState<KeyEndpoint[] | null>(null);
  const [loadingEndpoints, setLoadingEndpoints] = useState(false);

  const openEndpoints = async (key: ApiKey) => {
    setViewingKey(key);
    setKeyEndpoints(null);
    setLoadingEndpoints(true);
    try {
      const list = await api.apiKeys.endpoints(key.id);
      setKeyEndpoints(list);
    } catch (err) {
      toast.error(errorMessage(err));
      setViewingKey(null);
    } finally {
      setLoadingEndpoints(false);
    }
  };

  const openEditKey = (key: ApiKey) => {
    setEditingKey(key);
    setEditLabel(key.label);
    setEditQuota(String(key.quotaLimit ?? 0));
    setEditPeriod(key.quotaPeriod ?? 'total');
    setEditExpires(key.expiresAt ? key.expiresAt.slice(0, 16) : '');
    setEditIpList((key.ipAllowlist ?? []).join('\n'));
    setEditNotes(key.notes ?? '');
  };

  const saveKey = async () => {
    if (!editingKey) return;
    const quota = Number(editQuota);
    if (!Number.isFinite(quota) || quota < 0) {
      toast.error('额度必须是不小于 0 的数字');
      return;
    }
    setSavingKey(true);
    try {
      await api.apiKeys.update(editingKey.id, {
        label: editLabel.trim() || editingKey.label,
        quotaLimit: quota,
        quotaPeriod: editPeriod,
        expiresAt: editExpires ? new Date(editExpires).toISOString() : null,
        ipAllowlist: parseIpList(editIpList),
        notes: editNotes,
      });
      toast.success('令牌已更新');
      setEditingKey(null);
      keys.reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSavingKey(false);
    }
  };

  const resetQuota = async (key: ApiKey) => {
    try {
      await api.apiKeys.update(key.id, { resetQuota: true });
      toast.success(`${key.label} 额度已清零`);
      keys.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const createSecret = async () => {
    if (!name.trim()) {
      toast.error('secret 名称必填');
      return;
    }
    if (!value) {
      toast.error('secret 值必填');
      return;
    }
    setSavingSecret(true);
    try {
      await api.secrets.create({ name: name.trim(), value, hint: hint.trim() || undefined });
      toast.success(`密钥 ${name.trim()} 已保存`);
      setName('');
      setValue('');
      setHint('');
      secrets.reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSavingSecret(false);
    }
  };

  const removeSecret = async () => {
    if (!secretToDelete) return;
    setDeletingSecret(true);
    try {
      await api.secrets.remove(secretToDelete.name);
      toast.success(`密钥 ${secretToDelete.name} 已删除`);
      setSecretToDelete(null);
      secrets.reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeletingSecret(false);
    }
  };

  const createKey = async () => {
    if (!label.trim()) {
      toast.error('API Key 标签必填');
      return;
    }
    const quota = Number(newQuota);
    if (!Number.isFinite(quota) || quota < 0) {
      toast.error('额度必须是不小于 0 的数字');
      return;
    }
    setCreatingKey(true);
    try {
      const created = await api.apiKeys.create({
        label: label.trim(),
        scopes: scopes.length > 0 ? scopes : undefined,
        quotaLimit: quota,
        quotaPeriod: newPeriod,
        expiresAt: newExpires ? new Date(newExpires).toISOString() : null,
        ipAllowlist: parseIpList(newIpList),
      });
      setCreatedKey(created);
      setLabel('');
      setScopes([]);
      setNewQuota('0');
      setNewPeriod('total');
      setNewExpires('');
      setNewIpList('');
      keys.reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreatingKey(false);
    }
  };

  const toggleKey = async (key: ApiKey) => {
    setBusyKeyId(key.id);
    try {
      await api.apiKeys.update(key.id, { enabled: !key.enabled });
      toast.success(`${key.label} ${key.enabled ? '已停用' : '已启用'}`);
      keys.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyKeyId('');
    }
  };

  const removeKey = async () => {
    if (!keyToDelete) return;
    setDeletingKey(true);
    try {
      await api.apiKeys.remove(keyToDelete.id);
      toast.success(`API Key ${keyToDelete.label} 已删除`);
      setKeyToDelete(null);
      keys.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeletingKey(false);
    }
  };

  const secretColumns: Column<SecretMeta>[] = [
    { key: 'name', title: '名称', width: '220px', render: (row) => <span className="mono strong">{row.name}</span> },
    { key: 'hint', title: '提示', render: (row) => <span className="dim">{row.hint || '—'}</span> },
    {
      key: 'createdAt',
      title: '创建时间',
      width: '150px',
      render: (row) => <span className="mono dim">{formatTime(row.createdAt)}</span>,
    },
    {
      key: 'rotatedAt',
      title: '轮换时间',
      width: '150px',
      render: (row) => <span className="mono dim">{formatTime(row.rotatedAt ?? undefined)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      width: '90px',
      align: 'right',
      render: (row) => (
        <button type="button" className="btn sm danger-ghost" onClick={() => setSecretToDelete(row)}>
          删除
        </button>
      ),
    },
  ];

  const keyColumns: Column<ApiKey>[] = [
    {
      key: 'label',
      title: '标签',
      render: (row) => (
        <div className="cell-stack">
          <span className="strong">{row.label}</span>
          <span className="mono dim small">{row.prefix}…</span>
        </div>
      ),
    },
    {
      key: 'owner',
      title: '归属',
      width: '110px',
      render: (row) =>
        row.owner ? (
          <Badge tone={row.owner.role === 'admin' ? 'purple' : 'gray'}>{row.owner.username}</Badge>
        ) : (
          <span className="dim small">全局</span>
        ),
    },
    {
      key: 'quota',
      title: '额度',
      width: '150px',
      render: (row) => {
        if (!row.quotaLimit) {
          return <span className="dim small">不限 · 已用 {row.quotaUsed}</span>;
        }
        const pct = Math.min(100, Math.round((row.quotaUsed / row.quotaLimit) * 100));
        const tone = pct >= 100 ? 'red' : pct >= 80 ? 'orange' : 'green';
        return (
          <div className="quota-cell">
            <div className="quota-bar">
              <div className={`quota-fill ${tone}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="mono dim small">
              {row.quotaUsed}/{row.quotaLimit} · {QUOTA_PERIOD_LABEL[row.quotaPeriod]}
            </span>
          </div>
        );
      },
    },
    {
      key: 'expiresAt',
      title: '过期',
      width: '140px',
      render: (row) => {
        if (!row.expiresAt) return <span className="dim small">永不过期</span>;
        const expired = Date.parse(row.expiresAt) < Date.now();
        return (
          <span className={`mono small ${expired ? 'err-text' : 'dim'}`}>
            {formatTime(row.expiresAt)}
            {expired ? ' · 已过期' : ''}
          </span>
        );
      },
    },
    {
      key: 'ipAllowlist',
      title: '来源 IP',
      width: '120px',
      render: (row) => {
        const list = row.ipAllowlist ?? [];
        if (list.length === 0) return <span className="dim small">不限</span>;
        return (
          <Badge tone="blue" title={list.join('\n')}>
            {list.length === 1 ? list[0] : `${list.length} 条规则`}
          </Badge>
        );
      },
    },
    {
      key: 'enabled',
      title: '状态',
      width: '80px',
      render: (row) => (
        <Badge tone={row.enabled ? 'green' : 'gray'}>{row.enabled ? '启用' : '停用'}</Badge>
      ),
    },
    {
      key: 'callCount',
      title: '调用',
      width: '80px',
      align: 'right',
      render: (row) => <span className="mono num dim">{row.callCount}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      width: '280px',
      align: 'right',
      render: (row) => (
        <div className="row-actions">
          <button type="button" className="btn sm ghost" onClick={() => void openEndpoints(row)}>
            可见接口
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setEditingKey(row)}>
            编辑
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busyKeyId === row.id}
            onClick={() => void toggleKey(row)}
          >
            {row.enabled ? '停用' : '启用'}
          </button>
          <button type="button" className="btn sm danger-ghost" onClick={() => setKeyToDelete(row)}>
            删除
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">密钥与令牌</h1>
          <div className="page-sub">
            两样东西方向相反：<b>上游凭据</b>是网关调上游时出示的（出站），
            <b>对外令牌</b>是调用方调网关时出示的（入站）。
          </div>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              secrets.reload();
              keys.reload();
            }}
          >
            刷新
          </button>
        </div>
      </header>

      <div className="notice">
        <span className="mono">调用方 ──x-api-key──▶ 网关 ──${'{'}secret:NAME{'}'} 解密──▶ 上游</span>
        <div className="dim small" style={{ marginTop: 4 }}>
          调用方永远看不到上游凭据，也看不到上游域名和路径。
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <div className="card-title">上游凭据（出站）</div>
          <div className="card-sub">
            网关调第三方接口时用。接口里写 <code className="mono">{'${secret:NAME}'}</code> 引用，正文不落明文
          </div>
        </div>
        <div className="card-body">
          <div className="inline-form">
            <Field label="名称">
              <TextInput mono value={name} onChange={(event) => setName(event.target.value)} placeholder="GITHUB_TOKEN" />
            </Field>
            <Field label="值">
              <TextInput
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="粘贴密钥明文"
                autoComplete="new-password"
              />
            </Field>
            <Field label="提示（可选）">
              <TextInput value={hint} onChange={(event) => setHint(event.target.value)} placeholder="readonly PAT" />
            </Field>
            <div className="inline-form-action">
              <button type="button" className="btn primary" onClick={() => void createSecret()} disabled={savingSecret}>
                {savingSecret ? '保存中…' : '新增密钥'}
              </button>
            </div>
          </div>
        </div>
        {secrets.error ? (
          <ErrorBox message={secrets.error} onRetry={secrets.reload} />
        ) : (
          <DataTable
            columns={secretColumns}
            rows={secrets.data ?? []}
            rowKey={(row) => row.name}
            loading={secrets.loading}
            empty={<Empty title="还没有密钥" hint="新增后，在平台的 authConfig 里写 ${secret:NAME} 即可引用。" />}
          />
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div className="card-title">对外令牌（入站）</div>
          <div className="card-sub">
            调用方调 <code className="mono">/gw</code> 或 MCP 时放在 <code className="mono">x-api-key</code> 里。
            形如 <code className="mono">hub_live_xxx</code>，明文只在创建时展示一次，库里只存哈希
          </div>
        </div>
        <div className="card-body">
          <div className="inline-form">
            <Field label="标签">
              <TextInput value={label} onChange={(event) => setLabel(event.target.value)} placeholder="我的 MCP 客户端" />
            </Field>
            <Field label="额度上限" hint="0 = 不限">
              <TextInput
                type="number"
                min={0}
                value={newQuota}
                onChange={(event) => setNewQuota(event.target.value)}
              />
            </Field>
            <Field label="额度周期">
              <Select value={newPeriod} onChange={(event) => setNewPeriod(event.target.value as QuotaPeriod)}>
                {QUOTA_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {QUOTA_PERIOD_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="过期时间" hint="留空 = 永不过期">
              <TextInput
                type="datetime-local"
                value={newExpires}
                onChange={(event) => setNewExpires(event.target.value)}
              />
            </Field>
            <Field label="IP 白名单" hint="换行分隔，支持 CIDR；留空 = 不限来源">
              <TextArea
                mono
                rows={2}
                value={newIpList}
                onChange={(event) => setNewIpList(event.target.value)}
                placeholder={'203.0.113.10\n10.0.0.0/8'}
              />
            </Field>
            <Field label="范围" hint="不选表示全部平台">
              <div className="scope-picker">
                {(platforms.data ?? []).length === 0 ? (
                  <span className="dim small">还没有平台，先建平台再限制范围</span>
                ) : (
                  (platforms.data ?? []).map((platform) => (
                    <Checkbox
                      key={platform.id}
                      checked={scopes.includes(platform.slug)}
                      onChange={(next) =>
                        setScopes((prev) =>
                          next ? [...prev, platform.slug] : prev.filter((item) => item !== platform.slug),
                        )
                      }
                      label={<span className="mono">{platform.slug}</span>}
                    />
                  ))
                )}
              </div>
            </Field>
            <div className="inline-form-action">
              <button type="button" className="btn primary" onClick={() => void createKey()} disabled={creatingKey}>
                {creatingKey ? '创建中…' : '新建 API Key'}
              </button>
            </div>
          </div>
        </div>
        {keys.error ? (
          <ErrorBox message={keys.error} onRetry={keys.reload} />
        ) : (
          <DataTable
            columns={keyColumns}
            rows={keys.data ?? []}
            rowKey={(row) => row.id}
            loading={keys.loading}
            empty={<Empty title="还没有 API Key" hint="新建一个，把明文 key 填进 MCP 客户端的 env.HUB_API_KEY。" />}
          />
        )}
      </section>

      <Modal
        open={viewingKey !== null}
        title={`${viewingKey?.label ?? ''} 可调用的接口`}
        subtitle="该 Key 通过网关能看到的接口，调不通的不会出现在这里"
        onClose={() => setViewingKey(null)}
        width={720}
        footer={
          <button type="button" className="btn ghost" onClick={() => setViewingKey(null)}>
            关闭
          </button>
        }
      >
        {loadingEndpoints ? (
          <div className="empty">加载中…</div>
        ) : (keyEndpoints ?? []).length === 0 ? (
          <Empty
            title="这个 Key 现在调不到任何接口"
            hint="接口的开放策略要么是「关闭」，要么「指定令牌」里没勾选这个 Key。"
          />
        ) : (
          <div className="endpoint-preview">
            {(keyEndpoints ?? []).map((ep) => (
              <div key={ep.id} className="endpoint-preview-item">
                <div className="endpoint-preview-head">
                  <span className="mono strong">{ep.toolName || ep.slug}</span>
                  {ep.callable ? (
                    <Badge tone="green">可调用</Badge>
                  ) : (
                    <Badge tone="orange">未编译</Badge>
                  )}
                  {ep.sideEffect === 'write' ? <Badge tone="orange">写</Badge> : null}
                </div>
                <div className="dim small">{ep.summary || '（无说明）'}</div>
                {ep.notes ? <div className="endpoint-preview-notes">{ep.notes}</div> : null}
                <div className="mono dim small">
                  GET /gw/v1/{ep.toolName || ep.slug}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        open={editingKey !== null}
        title={`编辑令牌 · ${editingKey?.label ?? ''}`}
        subtitle="归属账号不可更改；额度 0 表示不限"
        onClose={() => setEditingKey(null)}
        width={560}
        footer={
          <>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                if (editingKey) void resetQuota(editingKey);
              }}
            >
              额度清零
            </button>
            <button type="button" className="btn ghost" onClick={() => setEditingKey(null)}>
              取消
            </button>
            <button type="button" className="btn primary" onClick={() => void saveKey()} disabled={savingKey}>
              {savingKey ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <div className="form-row">
          <Field label="标签">
            <TextInput value={editLabel} onChange={(e) => setEditLabel(e.target.value)} />
          </Field>
          <Field label="额度上限" hint="0 = 不限">
            <TextInput
              type="number"
              min={0}
              value={editQuota}
              onChange={(e) => setEditQuota(e.target.value)}
            />
          </Field>
          <Field label="额度周期">
            <Select value={editPeriod} onChange={(e) => setEditPeriod(e.target.value as QuotaPeriod)}>
              {QUOTA_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {QUOTA_PERIOD_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="过期时间" hint="留空表示永不过期" span>
            <TextInput
              type="datetime-local"
              value={editExpires}
              onChange={(e) => setEditExpires(e.target.value)}
            />
          </Field>
          <Field label="备注" span>
            <TextInput value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
          </Field>
          <Field
            label="IP 白名单"
            hint="每行一个，支持 1.2.3.4 / 10.0.0.0/8 / 10.0.0.* / *。留空表示不限制来源 IP"
            span
          >
            <TextArea
              mono
              rows={4}
              value={editIpList}
              onChange={(e) => setEditIpList(e.target.value)}
              placeholder={'203.0.113.10\n10.0.0.0/8'}
            />
          </Field>
        </div>
        <div className="dim small">
          当前已用 <span className="mono">{editingKey?.quotaUsed ?? 0}</span> · 累计调用{' '}
          <span className="mono">{editingKey?.callCount ?? 0}</span> 次
        </div>
      </Modal>

      <Modal
        open={createdKey !== null}
        title="API Key 已创建"
        subtitle="明文只显示这一次，关闭后无法再次查看"
        onClose={() => setCreatedKey(null)}
        width={560}
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setCreatedKey(null)}>
              我已保存
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                if (!createdKey) return;
                void copyText(createdKey.key).then((ok) => {
                  if (ok) toast.success('已复制到剪贴板');
                  else toast.error('复制失败，请手动选中');
                });
              }}
            >
              复制 Key
            </button>
          </>
        }
      >
        <div className="key-reveal mono">{createdKey?.key ?? ''}</div>
        <div className="dim small">用法：请求头 <span className="mono">x-api-key: {createdKey?.key.slice(0, 12) ?? ''}…</span></div>
      </Modal>

      <ConfirmDialog
        open={secretToDelete !== null}
        title="删除密钥"
        danger
        confirmLabel="删除"
        busy={deletingSecret}
        message={
          <span>
            确认删除密钥 <b className="mono">{secretToDelete?.name}</b>？引用它的接口会立刻失效。
          </span>
        }
        onCancel={() => setSecretToDelete(null)}
        onConfirm={() => void removeSecret()}
      />

      <ConfirmDialog
        open={keyToDelete !== null}
        title="删除 API Key"
        danger
        confirmLabel="删除"
        busy={deletingKey}
        message={
          <span>
            确认删除 <b className="mono">{keyToDelete?.label}</b>？使用该 key 的客户端会立刻 401。
          </span>
        }
        onCancel={() => setKeyToDelete(null)}
        onConfirm={() => void removeKey()}
      />
    </>
  );
}
