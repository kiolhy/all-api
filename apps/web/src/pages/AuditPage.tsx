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
  const [reasonFilter, setReasonFilter] = useState('');
  const toolDebounced = useDebounced(tool, 350);
  const limitNumber = Number(limit) || 100;

  const audits = useResource(
    () => api.audit.list({ limit: limitNumber, tool: toolDebounced || undefined }),
    [toolDebounced, limitNumber, rev],
  );

  const rows = audits.data ?? [];
  const failedCount = rows.filter((row) => !row.ok).length;
  const failRate = rows.length > 0 ? Math.round((failedCount / rows.length) * 100) : 0;

  /** 失败原因归类：同一个 errorCode 归一类，没错误码就用状态码 */
  const reasons = (() => {
    const map = new Map<string, number>();
    for (const row of rows) {
      if (row.ok) continue;
      const key = row.errorCode || (row.status ? `http_${row.status}` : 'unknown');
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  })();

  const reasonOf = (row: Audit): string =>
    row.errorCode || (row.status ? `http_${row.status}` : 'unknown');

  const visibleRows = reasonFilter ? rows.filter((row) => !row.ok && reasonOf(row) === reasonFilter) : rows;

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
          {rows.length > 0 ? `（${failRate}%）` : ''}
          {reasonFilter ? ` · 已筛 ${visibleRows.length} 条` : ''}
          {audits.loading ? ' · 加载中…' : ''}
        </div>
      </section>

      {reasons.length > 0 ? (
        <section className="card">
          <div className="card-head">
            <div className="card-title">失败原因</div>
            <div className="card-sub">
              按错误码归类，失败率超过 30% 就该查了；点一个标签只看这一类
            </div>
          </div>
          <div className="reason-chips">
            {reasons.map(([key, count]) => (
              <button
                key={key}
                type="button"
                className={`reason-chip${reasonFilter === key ? ' active' : ''}`}
                onClick={() => setReasonFilter(reasonFilter === key ? '' : key)}
              >
                <span className="mono">{key}</span>
                <span className="reason-count">{count}</span>
                <span className="dim small">{Math.round((count / rows.length) * 100)}%</span>
              </button>
            ))}
            {reasonFilter ? (
              <button type="button" className="btn sm ghost" onClick={() => setReasonFilter('')}>
                清除筛选
              </button>
            ) : null}
          </div>
          {failRate >= 30 ? (
            <div className="notice warn" style={{ margin: '0 12px 12px' }}>
              失败率 {failRate}%，最高的一类是 <b className="mono">{reasons[0]![0]}</b>（{reasons[0]![1]} 条）。
              先看上游是否限流/鉴权失效，再看网关出网配置。
            </div>
          ) : null}
        </section>
      ) : null}

      {audits.error ? (
        <ErrorBox message={audits.error} onRetry={audits.reload} />
      ) : (
        <section className="card">
          <DataTable
            columns={columns}
            rows={visibleRows}
            rowKey={(row) => row.id}
            loading={audits.loading}
            pageSize={50}
            defaultSort={{ key: 'ts', dir: 'desc' }}
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
