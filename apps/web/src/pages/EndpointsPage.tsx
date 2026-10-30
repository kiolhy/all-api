import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, ExposureBadge, MethodBadge, StatusBadge } from '../components/Badge.tsx';
import { Empty, ErrorBox } from '../components/Empty.tsx';
import {
  Checkbox,
  Field,
  FormGrid,
  JsonEditor,
  Select,
  TextArea,
  TextInput,
} from '../components/Field.tsx';
import { JsonView } from '../components/JsonView.tsx';
import { ConfirmDialog, Drawer, Modal } from '../components/Modal.tsx';
import { ParamsEditor } from '../components/ParamsEditor.tsx';
import { RowMenu } from '../components/RowMenu.tsx';
import { DataTable } from '../components/Table.tsx';
import type { Column } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { formatMs, formatTime, parseJsonOr, splitList } from '../format.ts';
import { bumpData, errorMessage, readHashQuery, useDataRev, usePlatforms, useResource } from '../hooks.ts';
import {
  ENDPOINT_STATUSES,
  ENDPOINT_STATUS_LABEL,
  EXPOSURES,
  EXPOSURE_HINT,
  EXPOSURE_LABEL,
  HTTP_METHODS,
  PARAM_LOCATIONS,
  PARAM_LOCATION_LABEL,
  PARAM_TYPES,
  SENSITIVITY_LABEL,
  SIDE_EFFECT_LABEL,
} from '../types.ts';
import type {
  ApiKey,
  Endpoint,
  EndpointInput,
  EndpointStatus,
  EndpointTestResult,
  Exposure,
  HttpMethod,
  Param,
  Sensitivity,
  SideEffect,
} from '../types.ts';

type PublicNameFilter = '' | 'missing' | 'set';

const DEFAULT_RESPONSE = JSON.stringify(
  {
    contentType: 'application/json',
    pick: [],
    unwrap: null,
    transform: null,
    redactFields: [],
    maxBytes: 2097152,
  },
  null,
  2,
);

interface EndpointFormState {
  platformId: string;
  slug: string;
  group: string;
  method: HttpMethod;
  pathTemplate: string;
  summary: string;
  description: string;
  sideEffect: SideEffect;
  sensitivity: Sensitivity;
  tags: string;
  notes: string;
  exposure: Exposure;
  allowedKeyIds: string[];
  publicName: string;
  params: string;
  body: string;
  response: string;
  examples: string;
}

function emptyForm(platformId: string): EndpointFormState {
  return {
    platformId,
    slug: '',
    group: 'default',
    method: 'GET',
    pathTemplate: '',
    summary: '',
    description: '',
    sideEffect: 'read',
    sensitivity: 'low',
    tags: '',
    notes: '',
    exposure: 'open',
    allowedKeyIds: [],
    publicName: '',
    params: '[]',
    body: 'null',
    response: DEFAULT_RESPONSE,
    examples: '[]',
  };
}

function toForm(endpoint: Endpoint): EndpointFormState {
  return {
    platformId: endpoint.platformId,
    slug: endpoint.slug,
    group: endpoint.group ?? 'default',
    method: endpoint.method,
    pathTemplate: endpoint.pathTemplate,
    summary: endpoint.summary ?? '',
    description: endpoint.description ?? '',
    sideEffect: endpoint.sideEffect ?? 'read',
    sensitivity: endpoint.sensitivity ?? 'low',
    tags: (endpoint.tags ?? []).join(', '),
    notes: endpoint.notes ?? '',
    exposure: endpoint.exposure ?? 'open',
    allowedKeyIds: endpoint.allowedKeyIds ?? [],
    publicName: endpoint.publicName ?? '',
    params: JSON.stringify(endpoint.params ?? [], null, 2),
    body: JSON.stringify(endpoint.body ?? null, null, 2),
    response: JSON.stringify(endpoint.response ?? JSON.parse(DEFAULT_RESPONSE), null, 2),
    examples: JSON.stringify(endpoint.examples ?? [], null, 2),
  };
}

function buildInput(form: EndpointFormState): {
  input: EndpointInput | null;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const slug = form.slug.trim();
  if (!slug) errors.slug = 'slug 必填';
  else if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) errors.slug = '只能小写字母、数字、下划线、连字符';
  if (!form.pathTemplate.trim()) errors.pathTemplate = 'pathTemplate 必填';
  else if (!form.pathTemplate.trim().startsWith('/')) errors.pathTemplate = '需要以 / 开头';

  let params: Param[] = [];
  try {
    params = parseJsonOr<Param[]>(form.params, []);
    if (!Array.isArray(params)) {
      errors.params = 'params 需要是数组';
      params = [];
    }
  } catch (err) {
    errors.params = errorMessage(err);
  }

  let body: EndpointInput['body'] = null;
  try {
    body = parseJsonOr<EndpointInput['body']>(form.body, null);
  } catch (err) {
    errors.body = errorMessage(err);
  }

  let response: EndpointInput['response'] = JSON.parse(DEFAULT_RESPONSE) as EndpointInput['response'];
  try {
    response = parseJsonOr<EndpointInput['response']>(form.response, response);
  } catch (err) {
    errors.response = errorMessage(err);
  }

  let examples: EndpointInput['examples'] = [];
  try {
    examples = parseJsonOr<EndpointInput['examples']>(form.examples, []);
    if (!Array.isArray(examples)) {
      errors.examples = 'examples 需要是数组';
      examples = [];
    }
  } catch (err) {
    errors.examples = errorMessage(err);
  }

  if (Object.keys(errors).length > 0) return { input: null, errors };

  return {
    errors,
    input: {
      slug,
      group: form.group.trim() || 'default',
      method: form.method,
      pathTemplate: form.pathTemplate.trim(),
      summary: form.summary,
      description: form.description,
      params,
      body,
      response,
      sideEffect: form.sideEffect,
      sensitivity: form.sensitivity,
      tags: splitList(form.tags),
      examples,
      notes: form.notes,
      exposure: form.exposure,
      allowedKeyIds: form.exposure === 'restricted' ? form.allowedKeyIds : [],
      publicName: form.publicName.trim(),
    },
  };
}

export function EndpointsPage() {
  const toast = useToast();
  const rev = useDataRev();
  const platforms = usePlatforms();

  const [platformId, setPlatformId] = useState('');
  const [status, setStatus] = useState<EndpointStatus | ''>('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');

  // 支持从别的页面跳过来带搜索词，例如 #/endpoints?q=query_orders
  useEffect(() => {
    const preset = readHashQuery('q').trim();
    if (preset) {
      setQInput(preset);
      setQ(preset);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(qInput.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [qInput]);

  const endpoints = useResource(
    () => api.endpoints.list({ platformId, status, q }),
    [platformId, status, q, rev],
  );
  const apiKeyList = useResource(() => api.apiKeys.list(), [rev]);

  const [exposureFilter, setExposureFilter] = useState<Exposure | ''>('');
  const [publicNameFilter, setPublicNameFilter] = useState<PublicNameFilter>('');
  const allRows = endpoints.data ?? [];
  const missingPublicName = allRows.filter((row) => !row.publicName?.trim()).length;
  const visibleRows = allRows.filter((row) => {
    if (exposureFilter && row.exposure !== exposureFilter) return false;
    if (publicNameFilter === 'missing' && row.publicName?.trim()) return false;
    if (publicNameFilter === 'set' && !row.publicName?.trim()) return false;
    return true;
  });

  const [editing, setEditing] = useState<Endpoint | 'new' | null>(null);
  const [form, setForm] = useState<EndpointFormState>(emptyForm(''));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [publishTarget, setPublishTarget] = useState<Endpoint | null>(null);
  const [publishNote, setPublishNote] = useState('');
  const [publishing, setPublishing] = useState(false);

  const [archiveTarget, setArchiveTarget] = useState<Endpoint | null>(null);
  const [archiving, setArchiving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Endpoint | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [testTarget, setTestTarget] = useState<Endpoint | null>(null);
  const [testArgs, setTestArgs] = useState('{}');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<EndpointTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // ── 批量操作 ──
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const runBulk = async (action: 'publish' | 'archive') => {
    const targets = (endpoints.data ?? []).filter(
      (item) => selectedIds.includes(item.id) && (action === 'publish' || item.status !== 'archived'),
    );
    if (targets.length === 0) {
      toast.error('先勾选要处理的接口');
      return;
    }
    setBulkBusy(true);
    let ok = 0;
    const failed: string[] = [];
    for (const item of targets) {
      try {
        if (action === 'publish') await api.endpoints.publish(item.id, '批量发布');
        else await api.endpoints.archive(item.id);
        ok += 1;
      } catch (err) {
        failed.push(`${item.slug}：${errorMessage(err)}`);
      }
    }
    setBulkBusy(false);
    setSelectedIds([]);
    endpoints.reload();
    bumpData();
    if (failed.length === 0) {
      toast.success(`${action === 'publish' ? '发布' : '归档'}成功 ${ok} 个`);
    } else {
      toast.error(`${ok} 个成功，${failed.length} 个失败：${failed[0]}`);
    }
  };

  const openCreate = () => {
    const firstPlatform = platforms.data?.[0];
    setEditing('new');
    setForm(emptyForm(firstPlatform?.id ?? platformId));
    setErrors({});
  };

  const openEdit = (endpoint: Endpoint) => {
    setEditing(endpoint);
    setForm(toForm(endpoint));
    setErrors({});
  };

  // 支持 #/endpoints?edit=<id>：从别处跳过来直接打开这个接口的编辑抽屉
  useEffect(() => {
    const targetId = readHashQuery('edit').trim();
    if (!targetId) return;
    let alive = true;
    api.endpoints
      .get(targetId)
      .then((endpoint) => {
        if (alive) openEdit(endpoint);
      })
      .catch(() => {
        /* 接口被删了或没权限，静默忽略 */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchForm = (patch: Partial<EndpointFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const save = async () => {
    const { input, errors: nextErrors } = buildInput(form);
    setErrors(nextErrors);
    if (!input) return;
    setSaving(true);
    try {
      if (editing && editing !== 'new') {
        await api.endpoints.update(editing.id, input);
        toast.success(`接口 ${input.slug} 已保存`);
      } else {
        if (!form.platformId) {
          toast.error('先选一个平台');
          return;
        }
        await api.endpoints.create(form.platformId, input);
        toast.success(`接口 ${input.slug} 已创建`);
      }
      setEditing(null);
      endpoints.reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!publishTarget) return;
    setPublishing(true);
    try {
      await api.endpoints.publish(publishTarget.id, publishNote.trim() || undefined);
      toast.success(`${publishTarget.slug} 已发布`);
      setPublishTarget(null);
      setPublishNote('');
      endpoints.reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPublishing(false);
    }
  };

  const archive = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    try {
      await api.endpoints.archive(archiveTarget.id);
      toast.success(`${archiveTarget.slug} 已归档`);
      setArchiveTarget(null);
      endpoints.reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setArchiving(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.endpoints.remove(deleteTarget.id);
      toast.success(`${deleteTarget.slug} 已删除`);
      setDeleteTarget(null);
      endpoints.reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const openTest = (endpoint: Endpoint) => {
    setTestTarget(endpoint);
    setTestResult(null);
    setTestError(null);
    const example = endpoint.examples?.[0]?.args;
    setTestArgs(JSON.stringify(example ?? {}, null, 2));
  };

  const runTest = async () => {
    if (!testTarget) return;
    let args: Record<string, unknown>;
    try {
      args = parseJsonOr<Record<string, unknown>>(testArgs, {});
    } catch (err) {
      setTestError(errorMessage(err));
      return;
    }
    setTestBusy(true);
    setTestError(null);
    setTestResult(null);
    try {
      const result = await api.endpoints.test(testTarget.id, args);
      setTestResult(result);
      if (result.ok) toast.success(`试运行成功（${result.status} · ${result.latencyMs}ms）`);
      else toast.error(`试运行失败（${result.status}）`);
    } catch (err) {
      setTestError(errorMessage(err));
      toast.error(errorMessage(err));
    } finally {
      setTestBusy(false);
    }
  };

  const columns: Column<Endpoint>[] = [
    {
      key: 'slug',
      title: '接口',
      width: '250px',
      render: (row) => (
        <div className="cell-stack">
          <span className="mono strong">{row.slug}</span>
          {row.publicName?.trim() ? (
            <span className="dim small">
              对外：<span className="mono">{row.publicName}</span>
            </span>
          ) : (
            <span className="warn-text small">⚠ 未配对外名，会暴露上游结构</span>
          )}
        </div>
      ),
    },
    {
      key: 'method',
      title: '请求',
      render: (row) => (
        <div className="method-line">
          <MethodBadge method={row.method} />
          <span className="mono ellipsis" title={row.pathTemplate}>
            {row.pathTemplate}
          </span>
          {row.sideEffect === 'write' && ['GET', 'HEAD', 'OPTIONS'].includes(row.method) ? (
            <Badge
              tone="orange"
              title={`读写属性是「写」，方法却是 ${row.method}：AI 会当成只读工具去调用。改成 POST/PUT/PATCH/DELETE 才能发布。`}
            >
              方法冲突
            </Badge>
          ) : null}
        </div>
      ),
    },
    { key: 'status', title: '状态', width: '90px', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'exposure',
      title: '开放',
      width: '110px',
      render: (row) => (
        <ExposureBadge
          exposure={row.exposure}
          allowedCount={(row.allowedKeyIds ?? []).length}
        />
      ),
    },
    {
      key: 'version',
      title: '版本',
      width: '70px',
      align: 'right',
      render: (row) => <span className="mono num dim">v{row.version}</span>,
    },
    {
      key: 'sideEffect',
      title: '读写',
      width: '80px',
      render: (row) => (
        <Badge tone={row.sideEffect === 'write' ? 'orange' : 'green'}>
          {row.sideEffect === 'write' ? '写' : '读'}
        </Badge>
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
      width: '190px',
      align: 'right',
      render: (row) => (
        <div className="row-actions">
          <button type="button" className="btn sm" onClick={() => openTest(row)}>
            试运行
          </button>
          <button type="button" className="btn sm ghost" onClick={() => openEdit(row)}>
            编辑
          </button>
          <RowMenu
            items={[
              {
                label: row.status === 'published' ? '重新发布' : '发布',
                onClick: () => {
                  setPublishTarget(row);
                  setPublishNote('');
                },
              },
              {
                label: '归档',
                disabled: row.status === 'archived',
                hint: row.status === 'archived' ? '已经是归档状态' : undefined,
                onClick: () => setArchiveTarget(row),
              },
              {
                label: '删除',
                danger: true,
                onClick: () => setDeleteTarget(row),
              },
            ]}
          />
        </div>
      ),
    },
  ];

  const renderExpanded = (row: Endpoint) => (
    <div className="expand-panel">
      <div className="expand-grid">
        <div>
          <div className="sub-title">参数（{row.params?.length ?? 0}）</div>
          {(row.params?.length ?? 0) > 0 ? (
            <table className="table mini-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>位置</th>
                  <th>类型</th>
                  <th>必填</th>
                  <th>说明</th>
                  <th>密钥引用</th>
                </tr>
              </thead>
              <tbody>
                {row.params.map((param, index) => (
                  <tr key={`${row.id}-param-${index}`}>
                    <td className="mono">{param.name}</td>
                    <td className="mono dim">{param.in}</td>
                    <td className="mono dim">{param.type}</td>
                    <td>{param.required ? <Badge tone="orange">必填</Badge> : <span className="dim">否</span>}</td>
                    <td className="dim">{param.description || '—'}</td>
                    <td className="mono dim">{param.secretRef || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dim small">无参数</div>
          )}
        </div>
        <div>
          <div className="sub-title">响应映射</div>
          <div className="kv-grid">
            <div className="kv-row">
              <span className="kv-key">contentType</span>
              <span className="kv-val mono">{row.response?.contentType ?? '—'}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">pick</span>
              <span className="kv-val mono">{(row.response?.pick ?? []).join(', ') || '（原样）'}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">unwrap</span>
              <span className="kv-val mono">{row.response?.unwrap ?? '—'}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">transform</span>
              <span className="kv-val mono">{row.response?.transform ?? '—'}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">redact</span>
              <span className="kv-val mono">{(row.response?.redactFields ?? []).join(', ') || '—'}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">maxBytes</span>
              <span className="kv-val mono num">{row.response?.maxBytes ?? '—'}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">contentHash</span>
              <span className="kv-val mono dim">{row.contentHash?.slice(0, 16) ?? '—'}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">来源</span>
              <span className="kv-val mono dim">
                {row.sourceKind || '—'}
                {row.sourceRef ? ` · ${row.sourceRef}` : ''}
              </span>
            </div>
          </div>
        </div>
      </div>
      {row.body ? <JsonView value={row.body} label="请求体" collapsed maxHeight={220} /> : null}
      {row.examples?.length ? <JsonView value={row.examples} label="示例" collapsed maxHeight={200} /> : null}
      {row.description || row.notes ? (
        <div className="expand-notes">
          {row.description ? <div>{row.description}</div> : null}
          {row.notes ? <div className="dim">{row.notes}</div> : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">接口资产</h1>
          <div className="page-sub">接口清单、参数映射、发布与试运行</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn ghost" onClick={() => endpoints.reload()}>
            刷新
          </button>
          <button type="button" className="btn primary" onClick={openCreate}>
            新建接口
          </button>
        </div>
      </header>

      <section className="card filter-bar">
        <Field label="平台">
          <Select value={platformId} onChange={(event) => setPlatformId(event.target.value)}>
            <option value="">全部平台</option>
            {(platforms.data ?? []).map((platform) => (
              <option key={platform.id} value={platform.id}>
                {platform.slug}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="状态">
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value as EndpointStatus | '')}
          >
            <option value="">全部状态</option>
            {ENDPOINT_STATUSES.map((item) => (
              <option key={item} value={item}>
                {ENDPOINT_STATUS_LABEL[item]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="开放">
          <Select
            value={exposureFilter}
            onChange={(event) => setExposureFilter(event.target.value as Exposure | '')}
          >
            <option value="">全部</option>
            {EXPOSURES.map((item) => (
              <option key={item} value={item}>
                {EXPOSURE_LABEL[item]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="对外名" hint="未配对外名会暴露上游结构">
          <Select
            value={publicNameFilter}
            onChange={(event) => setPublicNameFilter(event.target.value as PublicNameFilter)}
          >
            <option value="">全部</option>
            <option value="missing">⚠ 未配置</option>
            <option value="set">已配置</option>
          </Select>
        </Field>
        <Field label="搜索" hint="slug / summary / path">
          <TextInput
            value={qInput}
            placeholder="输入关键词，自动过滤"
            onChange={(event) => setQInput(event.target.value)}
          />
        </Field>
        <div className="filter-summary dim small">
          共 {visibleRows.length} 条{endpoints.loading ? ' · 加载中…' : ''}
          {missingPublicName > 0 ? (
            <span className="warn-text"> · {missingPublicName} 条未配对外名</span>
          ) : null}
        </div>
      </section>

      {selectedIds.length > 0 ? (
        <div className="bulk-bar">
          <span className="bulk-bar-count">已选 {selectedIds.length} 个接口</span>
          <div className="bulk-bar-actions">
            <button
              type="button"
              className="btn sm primary"
              disabled={bulkBusy}
              onClick={() => void runBulk('publish')}
            >
              {bulkBusy ? '处理中…' : '批量发布'}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={bulkBusy}
              onClick={() => void runBulk('archive')}
            >
              批量归档
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setSelectedIds([])}>
              取消选择
            </button>
          </div>
        </div>
      ) : null}

      {endpoints.error ? (
        <ErrorBox message={endpoints.error} onRetry={endpoints.reload} />
      ) : (
        <section className="card">
          <DataTable
            columns={columns}
            rows={visibleRows}
            rowKey={(row) => row.id}
            loading={endpoints.loading}
            renderExpanded={renderExpanded}
            pageSize={20}
            defaultSort={{ key: 'updatedAt', dir: 'desc' }}
            selectable
            selectedKeys={selectedIds}
            onSelectionChange={setSelectedIds}
            empty={
              <Empty
                title="还没有接口资产"
                hint="去「一键整理」页粘贴一条 curl，或点右上角「新建接口」手工录入。"
                action={
                  <button
                    type="button"
                    className="btn primary sm"
                    onClick={() => {
                      window.location.hash = '/import';
                    }}
                  >
                    去一键整理
                  </button>
                }
              />
            }
          />
        </section>
      )}

      <Drawer
        open={editing !== null}
        title={editing === 'new' ? '新建接口' : editing ? `编辑接口 · ${editing.slug}` : '接口'}
        subtitle="params / body / response / examples 均按契约的 JSON 结构直接编辑"
        onClose={() => setEditing(null)}
        width={760}
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setEditing(null)} disabled={saving}>
              取消
            </button>
            <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <FormGrid>
          <Field label="所属平台">
            <Select
              value={form.platformId}
              disabled={editing !== 'new'}
              onChange={(event) => patchForm({ platformId: event.target.value })}
            >
              <option value="">选择平台</option>
              {(platforms.data ?? []).map((platform) => (
                <option key={platform.id} value={platform.id}>
                  {platform.slug} · {platform.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="slug" error={errors.slug}>
            <TextInput
              mono
              value={form.slug}
              onChange={(event) => patchForm({ slug: event.target.value })}
              placeholder="例如：list_users"
            />
          </Field>
          <Field label="分组">
            <TextInput
              value={form.group}
              onChange={(event) => patchForm({ group: event.target.value })}
              placeholder="default"
            />
          </Field>
          <Field label="method">
            <Select
              value={form.method}
              onChange={(event) => patchForm({ method: event.target.value as HttpMethod })}
            >
              {HTTP_METHODS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="pathTemplate" error={errors.pathTemplate} span>
            <TextInput
              mono
              value={form.pathTemplate}
              onChange={(event) => patchForm({ pathTemplate: event.target.value })}
              placeholder="例如：/v1/users/{id}"
            />
          </Field>
          <Field label="summary" span>
            <TextInput
              value={form.summary}
              onChange={(event) => patchForm({ summary: event.target.value })}
              placeholder="一句话说明这个接口做什么"
            />
          </Field>
          <Field label="读写属性" hint="写操作不会被 AI 自动试运行">
            <Select
              value={form.sideEffect}
              onChange={(event) => patchForm({ sideEffect: event.target.value as SideEffect })}
            >
              <option value="read">{SIDE_EFFECT_LABEL.read}</option>
              <option value="write">{SIDE_EFFECT_LABEL.write}</option>
            </Select>
          </Field>
          <Field label="敏感度">
            <Select
              value={form.sensitivity}
              onChange={(event) => patchForm({ sensitivity: event.target.value as Sensitivity })}
            >
              <option value="low">{SENSITIVITY_LABEL.low}</option>
              <option value="medium">{SENSITIVITY_LABEL.medium}</option>
              <option value="high">{SENSITIVITY_LABEL.high}</option>
            </Select>
          </Field>
          <Field label="tags" hint="逗号分隔" span>
            <TextInput
              value={form.tags}
              onChange={(event) => patchForm({ tags: event.target.value })}
              placeholder="users, admin"
            />
          </Field>
          <Field
            label="对外名称"
            hint="调用方看到的工具名。留空则用「平台__接口」，会暴露上游结构"
            span
          >
            <TextInput
              mono
              value={form.publicName}
              onChange={(event) => patchForm({ publicName: event.target.value })}
              placeholder="例如：query_user"
            />
          </Field>
          <Field label="开放策略" hint={EXPOSURE_HINT[form.exposure]} span>
            <div className="exposure-picker">
              {EXPOSURES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`exposure-option${form.exposure === value ? ' active' : ''}`}
                  onClick={() => patchForm({ exposure: value })}
                >
                  <span className="exposure-option-label">{EXPOSURE_LABEL[value]}</span>
                  <span className="exposure-option-hint">{EXPOSURE_HINT[value]}</span>
                </button>
              ))}
            </div>
          </Field>
          {form.exposure === 'restricted' ? (
            <Field
              label="允许调用的 API Key"
              hint={
                (apiKeyList.data ?? []).length === 0
                  ? '还没有 API Key，先到「密钥」页创建一个'
                  : '不勾选则任何人都调不通'
              }
              span
            >
              <div className="key-picker">
                {(apiKeyList.data ?? []).map((key) => (
                  <Checkbox
                    key={key.id}
                    checked={form.allowedKeyIds.includes(key.id)}
                    onChange={(next) =>
                      patchForm({
                        allowedKeyIds: next
                          ? [...form.allowedKeyIds, key.id]
                          : form.allowedKeyIds.filter((id) => id !== key.id),
                      })
                    }
                    label={
                      <span>
                        {key.label} <span className="mono dim small">{key.prefix}…</span>
                        {key.enabled ? null : <span className="dim small"> (已停用)</span>}
                      </span>
                    }
                  />
                ))}
              </div>
            </Field>
          ) : null}
          <Field label="description" span>
            <TextArea
              rows={2}
              value={form.description}
              onChange={(event) => patchForm({ description: event.target.value })}
            />
          </Field>
          <div className="span-2">
            <ParamsEditor
              value={form.params}
              error={errors.params}
              onChange={(next) => patchForm({ params: next })}
            />
          </div>
          <Field label="body（JSON 或 null）" error={errors.body} span>
            <JsonEditor
              value={form.body}
              rows={5}
              error={errors.body}
              onChange={(next) => patchForm({ body: next })}
            />
          </Field>
          <Field label="response（JSON）" error={errors.response} span>
            <JsonEditor
              value={form.response}
              rows={7}
              error={errors.response}
              onChange={(next) => patchForm({ response: next })}
            />
          </Field>
          <Field label="examples（JSON 数组）" error={errors.examples} span>
            <JsonEditor
              value={form.examples}
              rows={4}
              error={errors.examples}
              onChange={(next) => patchForm({ examples: next })}
              placeholder={`[{"args":{"id":"1"},"note":"取一个用户"}]`}
            />
          </Field>
          <Field label="notes" span>
            <TextArea
              rows={2}
              value={form.notes}
              onChange={(event) => patchForm({ notes: event.target.value })}
            />
          </Field>
        </FormGrid>
      </Drawer>

      <Drawer
        open={testTarget !== null}
        title={`试运行 · ${testTarget?.slug ?? ''}`}
        subtitle={
          testTarget ? `${testTarget.method} ${testTarget.pathTemplate} · 走网关真实出网` : undefined
        }
        onClose={() => setTestTarget(null)}
        width={680}
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setTestTarget(null)}>
              关闭
            </button>
            <button type="button" className="btn primary" onClick={() => void runTest()} disabled={testBusy}>
              {testBusy ? '执行中…' : '执行'}
            </button>
          </>
        }
      >
        <Field label="args（JSON）" hint="按 params 定义填，路径参数用键名对应">
          <JsonEditor value={testArgs} rows={8} onChange={setTestArgs} />
        </Field>
        {testError ? <ErrorBox message={testError} /> : null}
        {testResult ? (
          <div className="stack">
            <div className="kv-grid">
              <div className="kv-row">
                <span className="kv-key">状态码</span>
                <span className="kv-val">
                  <Badge tone={testResult.ok ? 'green' : 'red'}>{testResult.status}</Badge>
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-key">耗时</span>
                <span className="kv-val mono num">{formatMs(testResult.latencyMs)}</span>
              </div>
              <div className="kv-row">
                <span className="kv-key">上游</span>
                <span className="kv-val mono">{testResult.upstreamHost || '—'}</span>
              </div>
            </div>
            <JsonView value={testResult.data} label="返回数据" maxHeight={360} />
          </div>
        ) : null}
      </Drawer>

      <Modal
        open={publishTarget !== null}
        title="发布接口"
        subtitle={publishTarget ? `${publishTarget.slug} 将版本号 +1，并写入不可变快照` : undefined}
        onClose={() => setPublishTarget(null)}
        width={460}
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setPublishTarget(null)} disabled={publishing}>
              取消
            </button>
            <button type="button" className="btn primary" onClick={() => void publish()} disabled={publishing}>
              {publishing ? '发布中…' : '确认发布'}
            </button>
          </>
        }
      >
        <Field label="发布备注（可选）">
          <TextInput
            value={publishNote}
            onChange={(event) => setPublishNote(event.target.value)}
            placeholder="例如：补齐 limit 参数"
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={archiveTarget !== null}
        title="归档接口"
        confirmLabel="归档"
        busy={archiving}
        message={
          <span>
            归档后 <b className="mono">{archiveTarget?.slug}</b> 将不再出现在可用工具里，可随时重新发布。
          </span>
        }
        onCancel={() => setArchiveTarget(null)}
        onConfirm={() => void archive()}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除接口"
        danger
        confirmLabel="删除"
        busy={deleting}
        message={
          <span>
            确认删除 <b className="mono">{deleteTarget?.slug}</b>？关联工具与历史快照会一并清理，不可撤销。
          </span>
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
      />
    </>
  );
}
