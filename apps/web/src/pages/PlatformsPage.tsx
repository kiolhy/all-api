import { useState } from 'react';
import { api } from '../api.ts';
import { Badge } from '../components/Badge.tsx';
import { Empty, ErrorBox } from '../components/Empty.tsx';
import {
  Field,
  FormGrid,
  JsonEditor,
  Select,
  TextArea,
  TextInput,
  Toggle,
} from '../components/Field.tsx';
import { ConfirmDialog, Drawer, Modal } from '../components/Modal.tsx';
import { DataTable } from '../components/Table.tsx';
import type { Column } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { JsonView } from '../components/JsonView.tsx';
import { formatTime, parseJsonOr, splitList } from '../format.ts';
import { bumpData, errorMessage, useDataRev, usePlatforms, useResource } from '../hooks.ts';
import { AUTH_KINDS, AUTH_KIND_HINT, AUTH_KIND_LABEL } from '../types.ts';
import type {
  AuthKind,
  Platform,
  PlatformInput,
  PlatformTestResult,
  SecretMeta,
} from '../types.ts';

/** 每种鉴权方式允许出现在 authConfig 里的键，切方式时据此清理 */
const ALLOWED_AUTH_KEYS: Record<AuthKind, string[]> = {
  none: [],
  bearer: ['secretRef'],
  header: ['secretRef', 'header'],
  query: ['secretRef', 'queryParam'],
  basic: ['username', 'passwordRef'],
};

interface PlatformFormState {
  slug: string;
  name: string;
  baseUrl: string;
  authKind: AuthKind;
  authConfig: string;
  defaultHeaders: string;
  egressAllowHosts: string;
  qps: string;
  daily: string;
  allowPrivate: boolean;
  notes: string;
}

const EMPTY_FORM: PlatformFormState = {
  slug: '',
  name: '',
  baseUrl: '',
  authKind: 'none',
  authConfig: '{}',
  defaultHeaders: '{}',
  egressAllowHosts: '',
  qps: '5',
  daily: '10000',
  allowPrivate: false,
  notes: '',
};

function toForm(platform: Platform): PlatformFormState {
  return {
    slug: platform.slug,
    name: platform.name,
    baseUrl: platform.baseUrl,
    authKind: platform.authKind,
    authConfig: JSON.stringify(platform.authConfig ?? {}, null, 2),
    defaultHeaders: JSON.stringify(platform.defaultHeaders ?? {}, null, 2),
    egressAllowHosts: (platform.egressAllowHosts ?? []).join(', '),
    qps: String(platform.rateLimit?.qps ?? 5),
    daily: String(platform.rateLimit?.daily ?? 10000),
    allowPrivate: Boolean(platform.allowPrivate),
    notes: platform.notes ?? '',
  };
}

function buildInput(form: PlatformFormState): {
  input: PlatformInput | null;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const slug = form.slug.trim();
  if (!slug) errors.slug = 'slug 必填';
  else if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) errors.slug = '只能小写字母、数字、下划线、连字符';

  if (!form.name.trim()) errors.name = '名称必填';

  const baseUrl = form.baseUrl.trim();
  if (!baseUrl) errors.baseUrl = 'baseUrl 必填';
  else if (!/^https?:\/\//.test(baseUrl)) errors.baseUrl = '需要以 http:// 或 https:// 开头';

  let authConfig: Record<string, unknown> = {};
  try {
    authConfig = parseJsonOr<Record<string, unknown>>(form.authConfig, {});
  } catch (err) {
    errors.authConfig = errorMessage(err);
  }

  let defaultHeaders: Record<string, string> = {};
  try {
    defaultHeaders = parseJsonOr<Record<string, string>>(form.defaultHeaders, {});
  } catch (err) {
    errors.defaultHeaders = errorMessage(err);
  }

  const qps = Number(form.qps);
  const daily = Number(form.daily);
  if (!Number.isFinite(qps) || qps <= 0) errors.qps = 'qps 需为正数';
  if (!Number.isFinite(daily) || daily <= 0) errors.daily = 'daily 需为正整数';

  if (Object.keys(errors).length > 0) return { input: null, errors };

  return {
    errors,
    input: {
      slug,
      name: form.name.trim(),
      baseUrl,
      authKind: form.authKind,
      authConfig,
      defaultHeaders,
      egressAllowHosts: splitList(form.egressAllowHosts),
      rateLimit: { qps, daily: Math.round(daily) },
      allowPrivate: form.allowPrivate,
      notes: form.notes,
    },
  };
}

export function PlatformsPage() {
  const toast = useToast();
  const rev = useDataRev();
  const platforms = usePlatforms();
  const secrets = useResource(() => api.secrets.list().catch(() => [] as SecretMeta[]), [rev]);

  const [editing, setEditing] = useState<Platform | 'new' | null>(null);
  const [form, setForm] = useState<PlatformFormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [testingId, setTestingId] = useState('');
  const [refreshingId, setRefreshingId] = useState('');
  const [testResult, setTestResult] = useState<{ platform: Platform; result: PlatformTestResult } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const [pendingDelete, setPendingDelete] = useState<Platform | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openCreate = () => {
    setEditing('new');
    setForm(EMPTY_FORM);
    setErrors({});
  };

  const openEdit = (platform: Platform) => {
    setEditing(platform);
    setForm(toForm(platform));
    setErrors({});
  };

  const closeDrawer = () => {
    setEditing(null);
    setErrors({});
  };

  const patchForm = (patch: Partial<PlatformFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  /* ── 鉴权配置：按 authKind 拆成普通输入框，不再让用户手写 JSON ── */

  const authObj = (() => {
    try {
      return parseJsonOr<Record<string, unknown>>(form.authConfig, {});
    } catch {
      return {} as Record<string, unknown>;
    }
  })();

  const authText = (key: string, fallback = ''): string =>
    typeof authObj[key] === 'string' ? (authObj[key] as string) : fallback;

  /** 只写当前 authKind 用得上的键，其余丢掉，避免残留脏配置 */
  const setAuth = (key: string, value: string) => {
    const allowed = ALLOWED_AUTH_KEYS[form.authKind] ?? [];
    const next: Record<string, unknown> = {};
    for (const name of allowed) {
      const current = name === key ? value : authText(name);
      if (current) next[name] = current;
    }
    patchForm({ authConfig: JSON.stringify(next, null, 2) });
  };

  const changeAuthKind = (kind: AuthKind) => {
    // 密钥名能跨方式复用，其余键按新方式重建
    const carried = authText('secretRef') || authText('passwordRef');
    const next: Record<string, unknown> = {};
    if (kind === 'basic') {
      if (carried) next.passwordRef = carried;
      const user = authText('username');
      if (user) next.username = user;
    } else if (kind !== 'none' && carried) {
      next.secretRef = carried;
      if (kind === 'header' && authText('header')) next.header = authText('header');
      if (kind === 'query' && authText('queryParam')) next.queryParam = authText('queryParam');
    }
    patchForm({ authKind: kind, authConfig: JSON.stringify(next, null, 2) });
  };

  /** 密钥名输入框：可直接写，也能从已存的 vault 密钥里选 */
  const secretNameField = (label: string, key: string, placeholder: string) => (
    <Field label={label} hint="填「密钥与令牌」里已存的名字，或直接新建一个" span>
      <TextInput
        mono
        list="vault-secret-names"
        value={authText(key)}
        onChange={(event) => setAuth(key, event.target.value)}
        placeholder={placeholder}
      />
    </Field>
  );


  const save = async () => {
    const { input, errors: nextErrors } = buildInput(form);
    setErrors(nextErrors);
    if (!input) return;
    setSaving(true);
    try {
      if (editing && editing !== 'new') {
        await api.platforms.update(editing.id, input);
        toast.success(`平台 ${input.slug} 已更新`);
      } else {
        await api.platforms.create(input);
        toast.success(`平台 ${input.slug} 已创建`);
      }
      setEditing(null);
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (platform: Platform) => {
    setTestingId(platform.id);
    setTestError(null);
    try {
      const result = await api.platforms.test(platform.id);
      setTestResult({ platform, result });
      if (result.ok) toast.success(`${platform.slug} 连通性正常（${result.status}）`);
      else toast.error(`${platform.slug} 连通性异常（${result.status}）`);
    } catch (err) {
      setTestError(errorMessage(err));
      toast.error(errorMessage(err));
    } finally {
      setTestingId('');
    }
  };

  const refreshTitle = async (platform: Platform) => {
    setRefreshingId(platform.id);
    try {
      const res = await api.platforms.refreshTitle(platform.id);
      if (res.ok) {
        if (res.renamed) toast.success(`已抓到标题：${res.title}，平台名已更新`);
        else if (res.appliedName) toast.success(`已抓到标题：${res.title}`);
        else toast.success(`已抓到标题：${res.title}（名字保留你手动设置的）`);
      } else {
        toast.error(`没抓到标题：${res.error || '站点首页没有 <title>'}`);
      }
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRefreshingId('');
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.platforms.remove(pendingDelete.id);
      toast.success(`平台 ${pendingDelete.slug} 已删除`);
      setPendingDelete(null);
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const columns: Column<Platform>[] = [
    {
      key: 'slug',
      title: 'slug',
      width: '200px',
      render: (row) => (
        <div className="cell-stack">
          <span className="mono strong">{row.slug}</span>
          <span className="dim small">
            {row.name}
            {row.siteTitle && row.siteTitle !== row.name ? ` · 站点「${row.siteTitle}」` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'baseUrl',
      title: 'baseUrl',
      render: (row) => <span className="mono dim ellipsis" title={row.baseUrl}>{row.baseUrl}</span>,
    },
    {
      key: 'authKind',
      title: '鉴权',
      width: '90px',
      render: (row) => <Badge tone={row.authKind === 'none' ? 'gray' : 'purple'}>{row.authKind}</Badge>,
    },
    {
      key: 'rate',
      title: '限速',
      width: '120px',
      render: (row) => (
        <span className="mono dim">
          {row.rateLimit?.qps ?? '—'}/s · {row.rateLimit?.daily ?? '—'}/d
        </span>
      ),
    },
    {
      key: 'private',
      title: '内网',
      width: '70px',
      render: (row) => (
        <Badge tone={row.allowPrivate ? 'orange' : 'gray'}>{row.allowPrivate ? '允许' : '禁止'}</Badge>
      ),
    },
    {
      key: 'updatedAt',
      title: '更新时间',
      width: '150px',
      render: (row) => <span className="mono dim">{formatTime(row.updatedAt)}</span>,
    },
    {
      key: 'actions',
      sortable: false,
      title: '操作',
      width: '300px',
      align: 'right',
      render: (row) => (
        <div className="row-actions">
          <button
            type="button"
            className="btn sm"
            disabled={testingId === row.id}
            onClick={() => void runTest(row)}
          >
            {testingId === row.id ? '测试中…' : '测试连通性'}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={refreshingId === row.id}
            onClick={() => void refreshTitle(row)}
            title="重新抓取站点首页的 title"
          >
            {refreshingId === row.id ? '抓取中…' : '刷新标题'}
          </button>
          <button type="button" className="btn sm ghost" onClick={() => openEdit(row)}>
            编辑
          </button>
          <button type="button" className="btn sm danger-ghost" onClick={() => setPendingDelete(row)}>
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
          <h1 className="page-title">平台</h1>
          <div className="page-sub">接入的平台与鉴权方式，出网白名单决定网关能打到哪些 host</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn ghost" onClick={() => platforms.reload()}>
            刷新
          </button>
          <button type="button" className="btn primary" onClick={openCreate}>
            新建平台
          </button>
        </div>
      </header>

      {platforms.error ? (
        <ErrorBox message={platforms.error} onRetry={platforms.reload} />
      ) : (
        <section className="card">
          <DataTable
            columns={columns}
            rows={platforms.data ?? []}
            rowKey={(row) => row.id}
            loading={platforms.loading}
            pageSize={20}
            empty={
              <Empty
                title="还没有平台"
                hint="先建一个平台，再用「一键整理」把 curl / HAR / OpenAPI 变成接口资产。"
                action={
                  <button type="button" className="btn primary sm" onClick={openCreate}>
                    新建平台
                  </button>
                }
              />
            }
          />
        </section>
      )}

      <Drawer
        open={editing !== null}
        title={editing === 'new' ? '新建平台' : editing ? `编辑平台 · ${editing.slug}` : '平台'}
        subtitle="authConfig / defaultHeaders 里的密钥值可写 ${secret:NAME} 引用 vault"
        onClose={closeDrawer}
        width={640}
        footer={
          <>
            <button type="button" className="btn ghost" onClick={closeDrawer} disabled={saving}>
              取消
            </button>
            <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <FormGrid>
          <Field label="slug" error={errors.slug} hint="小写字母/数字/下划线/连字符">
            <TextInput
              mono
              value={form.slug}
              onChange={(event) => patchForm({ slug: event.target.value })}
              placeholder="例如：github"
            />
          </Field>
          <Field label="名称" error={errors.name}>
            <TextInput
              value={form.name}
              onChange={(event) => patchForm({ name: event.target.value })}
              placeholder="例如：GitHub REST API"
            />
          </Field>
          <Field label="baseUrl" error={errors.baseUrl} span>
            <TextInput
              mono
              value={form.baseUrl}
              onChange={(event) => patchForm({ baseUrl: event.target.value })}
              placeholder="例如：https://api.github.com"
            />
          </Field>
          <Field label="鉴权方式" hint={AUTH_KIND_HINT[form.authKind]}>
            <Select
              value={form.authKind}
              onChange={(event) => changeAuthKind(event.target.value as AuthKind)}
            >
              {AUTH_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {AUTH_KIND_LABEL[kind]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="允许内网" hint="关闭时仅允许公网 host">
            <Toggle
              checked={form.allowPrivate}
              onChange={(next) => patchForm({ allowPrivate: next })}
              label={form.allowPrivate ? '允许访问 127.0.0.1 / 内网段' : '仅公网'}
            />
          </Field>

          {form.authKind === 'none' ? (
            <div className="notice" style={{ gridColumn: '1 / -1' }}>
              这个平台不校验凭据。如果上游其实要密钥，上面选一种鉴权方式即可。
            </div>
          ) : null}

          {form.authKind === 'bearer' ? secretNameField('Token 密钥名', 'secretRef', 'GITHUB_TOKEN') : null}

          {form.authKind === 'header' ? (
            <>
              <Field label="请求头名" hint="凭据放进哪个头">
                <TextInput
                  mono
                  value={authText('header', 'X-API-Key')}
                  onChange={(event) => setAuth('header', event.target.value)}
                  placeholder="X-API-Key"
                />
              </Field>
              {secretNameField('密钥名', 'secretRef', 'MY_API_KEY')}
            </>
          ) : null}

          {form.authKind === 'query' ? (
            <>
              <Field label="URL 参数名" hint="凭据拼在哪个查询参数上">
                <TextInput
                  mono
                  value={authText('queryParam', 'key')}
                  onChange={(event) => setAuth('queryParam', event.target.value)}
                  placeholder="key"
                />
              </Field>
              {secretNameField('密钥名', 'secretRef', 'MY_API_KEY')}
            </>
          ) : null}

          {form.authKind === 'basic' ? (
            <>
              <Field label="用户名">
                <TextInput
                  value={authText('username')}
                  onChange={(event) => setAuth('username', event.target.value)}
                  placeholder="例如：user"
                />
              </Field>
              {secretNameField('密码密钥名', 'passwordRef', 'MY_PASSWORD')}
            </>
          ) : null}

          <datalist id="vault-secret-names">
            {(secrets.data ?? []).map((item) => (
              <option key={item.name} value={item.name} />
            ))}
          </datalist>

          <Field label="默认请求头（JSON）" error={errors.defaultHeaders} span hint="可选。不填就不加额外请求头">
            <JsonEditor
              value={form.defaultHeaders}
              onChange={(next) => patchForm({ defaultHeaders: next })}
              rows={3}
              error={errors.defaultHeaders}
              placeholder={'例如：{"accept": "application/vnd.github+json"}'}
            />
          </Field>
          <Field label="出网白名单" hint="逗号/换行分隔，留空表示只允许 baseUrl 的 host" span>
            <TextInput
              mono
              value={form.egressAllowHosts}
              onChange={(event) => patchForm({ egressAllowHosts: event.target.value })}
              placeholder="例如：api.github.com, raw.githubusercontent.com"
            />
          </Field>
          <Field label="QPS" error={errors.qps}>
            <TextInput
              mono
              value={form.qps}
              onChange={(event) => patchForm({ qps: event.target.value })}
              placeholder="默认 5"
            />
          </Field>
          <Field label="每日上限" error={errors.daily}>
            <TextInput
              mono
              value={form.daily}
              onChange={(event) => patchForm({ daily: event.target.value })}
              placeholder="默认 10000"
            />
          </Field>
          <Field label="备注" span>
            <TextArea
              rows={3}
              value={form.notes}
              onChange={(event) => patchForm({ notes: event.target.value })}
              placeholder="这个平台用来做什么、额度限制等"
            />
          </Field>
        </FormGrid>
      </Drawer>

      <Modal
        open={testResult !== null || testError !== null}
        title="连通性测试"
        subtitle={testResult ? testResult.platform.baseUrl : ''}
        onClose={() => {
          setTestResult(null);
          setTestError(null);
        }}
        width={620}
      >
        {testError ? (
          <div className="error-box">
            <div className="error-box-title">测试失败</div>
            <div className="error-box-text">{testError}</div>
          </div>
        ) : testResult ? (
          <div className="stack">
            <div className="kv-grid">
              <div className="kv-row">
                <span className="kv-key">结果</span>
                <span className="kv-val">
                  <Badge tone={testResult.result.ok ? 'green' : 'red'}>
                    {testResult.result.ok ? 'ok' : 'failed'}
                  </Badge>
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-key">状态码</span>
                <span className="kv-val mono num">{testResult.result.status}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">耗时</span>
                <span className="kv-val mono num">{testResult.result.latencyMs}ms</span>
              </div>
            </div>
            <JsonView value={testResult.result.sample} label="响应样本" maxHeight={320} />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除平台"
        danger
        confirmLabel="删除"
        busy={deleting}
        message={
          <span>
            确认删除平台 <b className="mono">{pendingDelete?.slug}</b>？该平台下的接口资产会一起失效，操作不可撤销。
          </span>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
