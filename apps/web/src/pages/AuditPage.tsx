import { useState } from 'react';
import { api } from '../api.ts';
import { Badge, ChannelBadge } from '../components/Badge.tsx';
import { Empty, ErrorBox } from '../components/Empty.tsx';
import { Field, Select, TextInput } from '../components/Field.tsx';
import { JsonView } from '../components/JsonView.tsx';
import { DataTable } from '../components/Table.tsx';
import type { Column } from '../components/Table.tsx';
import { formatMs, formatTime, shortId } from '../format.ts';
import { useDataRev, useDebounced, useResource } from '../hooks.ts';
import type { Audit } from '../types.ts';

export function AuditPage() {
  const rev = useDataRev();
  const [tool, setTool] = useState('');
  const [limit, setLimit] = useState('100');
  const toolDebounced = useDebounced(tool, 350);
  const limitNumber = Number(limit) || 100;

  const audits = useResource(
    () => api.audit.list({ limit: limitNumber, tool: toolDebounced || undefined }),
    [toolDebounced, limitNumber, rev],
  );

  const rows = audits.data ?? [];
  const failedCount = rows.filter((row) => !row.ok).length;

  const columns: Column<Audit>[] = [
    {
      key: 'ts',
      title: '时间',
      width: '150px',
      render: (row) => <span className="mono dim">{formatTime(row.ts)}</span>,
    },
    { key: 'channel', title: '通道', width: '80px', render: (row) => <ChannelBadge channel={row.channel} /> },
    {
      key: 'tool',
      title: '工具',
      render: (row) => (
        <div className="cell-stack">
          <span className="mono">{row.toolName || '—'}</span>
          <span className="mono dim small">{shortId(row.requestId)}</span>
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态码',
      width: '90px',
      align: 'right',
      render: (row) => (
        <span className={`mono num ${row.ok ? 'ok-text' : 'err-text'}`}>{row.status || '—'}</span>
      ),
    },
    {
      key: 'latency',
      title: '耗时',
      width: '90px',
      align: 'right',
      render: (row) => <span className="mono num dim">{formatMs(row.latencyMs)}</span>,
    },
    {
      key: 'host',
      title: '上游 host',
      render: (row) => <span className="mono dim">{row.upstreamHost || '—'}</span>,
    },
    {
      key: 'errorCode',
      title: '错误码',
      width: '150px',
      render: (row) =>
        row.errorCode ? <span className="mono err-text">{row.errorCode}</span> : <span className="dim">—</span>,
    },
  ];

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">审计</h1>
          <div className="page-sub">网关 / MCP / 对话的调用流水，失败行标红，点箭头看 reqMeta 与 respMeta</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn ghost" onClick={() => audits.reload()}>
            刷新
          </button>
        </div>
      </header>

      <section className="card filter-bar">
        <Field label="工具名">
          <TextInput
            value={tool}
            onChange={(event) => setTool(event.target.value)}
            placeholder="按工具名过滤，例如 github_list_repos"
          />
        </Field>
        <Field label="条数">
          <Select value={limit} onChange={(event) => setLimit(event.target.value)}>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
            <option value="500">500</option>
          </Select>
        </Field>
        <div className="filter-summary dim small">
          共 {rows.length} 条 · 失败 {failedCount} 条
          {audits.loading ? ' · 加载中…' : ''}
        </div>
      </section>

      {audits.error ? (
        <ErrorBox message={audits.error} onRetry={audits.reload} />
      ) : (
        <section className="card">
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={audits.loading}
            rowClassName={(row) => (row.ok ? '' : 'row-failed')}
            renderExpanded={(row) => (
              <div className="expand-panel">
                <div className="kv-grid">
                  <div className="kv-row">
                    <span className="kv-key">requestId</span>
                    <span className="kv-val mono dim">{row.requestId}</span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-key">endpointId</span>
                    <span className="kv-val mono dim">{row.endpointId || '—'}</span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-key">apiKeyId</span>
                    <span className="kv-val mono dim">{row.apiKeyId || '—'}</span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-key">结果</span>
                    <span className="kv-val">
                      <Badge tone={row.ok ? 'green' : 'red'}>{row.ok ? 'ok' : 'failed'}</Badge>
                    </span>
                  </div>
                </div>
                <div className="expand-grid">
                  <div>
                    <div className="sub-title">reqMeta</div>
                    <JsonView value={row.reqMeta} maxHeight={240} />
                  </div>
                  <div>
                    <div className="sub-title">respMeta</div>
                    <JsonView value={row.respMeta} maxHeight={240} />
                  </div>
                </div>
              </div>
            )}
            empty={
              <Empty
                title="还没有调用记录"
                hint="发布接口后，用「对话」页或网关 /gw/v1/call 触发一次调用，这里就会出现流水。"
              />
            }
          />
        </section>
      )}
    </>
  );
}
