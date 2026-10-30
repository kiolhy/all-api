import { useEffect, useRef, useState } from 'react';
import { api, streamAudit } from '../api.ts';
import { Badge, ChannelBadge } from '../components/Badge.tsx';
import { ErrorBox } from '../components/Empty.tsx';
import { DataTable } from '../components/Table.tsx';
import type { Column } from '../components/Table.tsx';
import { formatMs, formatNumber, formatTime, percent, shortId } from '../format.ts';
import { errorMessage, useDataRev, usePlatforms, useResource } from '../hooks.ts';
import type { Audit } from '../types.ts';

/** 实时流最多保留多少条，避免长时间开着把内存吃满 */
const LIVE_LIMIT = 50;

const auditColumns: Column<Audit>[] = [
  { key: 'ts', title: '时间', width: '150px', render: (row) => <span className="mono dim">{formatTime(row.ts)}</span> },
  { key: 'channel', title: '通道', width: '80px', render: (row) => <ChannelBadge channel={row.channel} /> },
  { key: 'tool', title: '工具', render: (row) => <span className="mono">{row.toolName || '—'}</span> },
  {
    key: 'status',
    title: '状态',
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
    title: '上游',
    render: (row) => <span className="mono dim">{row.upstreamHost || '—'}</span>,
  },
  {
    key: 'error',
    title: '错误码',
    render: (row) =>
      row.errorCode ? <span className="mono err-text">{row.errorCode}</span> : <span className="dim">—</span>,
  },
];

export function OverviewPage() {
  const rev = useDataRev();
  const platforms = usePlatforms();
  const stats = useResource(() => api.stats(), [rev]);
  const audits = useResource(() => api.audit.list({ limit: 10 }), [rev]);
  const health = useResource(() => api.health().catch(() => null), [rev]);

  /** 实时流里的记录；null 表示还没收到首帧，回退到初始拉取结果 */
  const [live, setLive] = useState<Audit[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  /** 新调用到达后延迟刷新指标，避免每来一条就打一次 /api/stats */
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleStatsReload = () => {
    if (statsTimer.current) return;
    statsTimer.current = setTimeout(() => {
      statsTimer.current = null;
      stats.reload();
    }, 3000);
  };

  // 订阅实时流水：断线自动重连（1s → 2s → 4s … 最多 15s），不用手动刷新
  useEffect(() => {
    let alive = true;
    let attempt = 0;
    let controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      controller = new AbortController();
      setStreamError(null);
      void streamAudit(
        (event) => {
          if (!alive) return;
          if (event.type === 'snapshot') {
            // 暂停期间不覆盖已有内容
            if (!pausedRef.current) setLive(event.records);
            return;
          }
          if (pausedRef.current) return;
          setLive((prev) => {
            const base = prev ?? [];
            if (base.some((r) => r.id === event.record.id)) return base;
            return [event.record, ...base].slice(0, LIVE_LIMIT);
          });
          scheduleStatsReload();
        },
        controller.signal,
        () => {
          attempt = 0;
          if (alive) setConnected(true);
        },
      )
        .catch((err: unknown) => {
          if (!alive) return;
          setStreamError(errorMessage(err));
        })
        .finally(() => {
          if (!alive) return;
          setConnected(false);
          attempt += 1;
          const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
          retryTimer = setTimeout(connect, delay);
        });
    };

    connect();

    return () => {
      alive = false;
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      if (statsTimer.current) {
        clearTimeout(statsTimer.current);
        statsTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = live ?? audits.data ?? [];

  const data = stats.data;
  const calls = data?.calls;
  const failRate = calls && calls.total > 0 ? percent(calls.failed, calls.total) : '0%';
  // 平台数统一取共享 store，跟「平台」页和接口页下拉同一份数据
  const platformCount = platforms.data ? platforms.data.length : data?.platforms;

  const metrics: Array<{ label: string; value: string; hint: string; tone?: string }> = [
    { label: '平台', value: formatNumber(platformCount), hint: '已接入平台' },
    { label: '接口', value: formatNumber(data?.endpoints), hint: '全部接口资产' },
    { label: '已发布', value: formatNumber(data?.published), hint: '可被 AI 调用' },
    { label: '工具', value: formatNumber(data?.tools), hint: 'MCP 工具数' },
    { label: '今日调用', value: formatNumber(calls?.today), hint: `累计 ${formatNumber(calls?.total)}` },
    { label: '失败率', value: failRate, hint: `失败 ${formatNumber(calls?.failed)} 次`, tone: (calls?.failed ?? 0) > 0 ? 'warn' : undefined },
    { label: '平均延迟', value: formatMs(calls?.avgLatency), hint: '网关端到端' },
  ];

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">概览</h1>
          <div className="page-sub">
            接口资产中枢运行概况
            {health.data ? (
              <span className="dim">
                {' · '}v{health.data.version}
                {' · '}
              </span>
            ) : null}
            {health.data ? (
              <Badge tone={health.data.llm?.enabled ? 'green' : 'gray'}>
                {health.data.llm?.enabled
                  ? `LLM 已启用 · ${health.data.llm.model || '未指定模型'}`
                  : 'LLM 未启用'}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn ghost" onClick={() => { stats.reload(); audits.reload(); health.reload(); platforms.reload(); }}>
            刷新
          </button>
        </div>
      </header>

      {stats.error ? (
        <ErrorBox message={stats.error} onRetry={stats.reload} />
      ) : (
        <div className="grid-metrics">
          {metrics.map((metric) => (
            <div key={metric.label} className={`metric${metric.tone ? ` ${metric.tone}` : ''}`}>
              <div className="metric-label">{metric.label}</div>
              <div className="metric-value mono num">{stats.loading && !data ? '—' : metric.value}</div>
              <div className="metric-hint">{metric.hint}</div>
            </div>
          ))}
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <div className="card-title">
            实时调用流水
            <span className={`live-dot${connected && !paused ? ' on' : ''}`} title={connected ? '已连接' : '未连接'} />
          </div>
          <div className="card-sub">
            {paused
              ? '已暂停，新的调用不会进来'
              : connected
                ? `网关每调用一次实时推一条 · 保留最近 ${LIVE_LIMIT} 条`
                : streamError
                  ? `连接失败：${streamError} · 正在自动重连`
                  : '正在连接…'}
          </div>
          <div className="card-actions">
            <button type="button" className="btn sm ghost" onClick={() => setPaused((v) => !v)}>
              {paused ? '继续' : '暂停'}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                audits.reload();
                stats.reload();
                health.reload();
                platforms.reload();
              }}
            >
              刷新
            </button>
          </div>
        </div>
        {audits.error ? (
          <ErrorBox message={audits.error} onRetry={audits.reload} />
        ) : (
          <DataTable
            columns={auditColumns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={audits.loading && rows.length === 0}
            rowClassName={(row) => (row.ok ? '' : 'row-failed')}
            empty={
              <div className="table-empty">
                还没有调用记录。发布接口后到「对话」页试一句，或在网关 `/gw/v1/call` 调一次 —— 调用会实时出现在这里。
              </div>
            }
          />
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div className="card-title">调用分布</div>
          <div className="card-sub">按成功/失败拆分</div>
        </div>
        <div className="card-body split-stats">
          <div className="kv-row">
            <span className="kv-key">成功</span>
            <span className="kv-val mono num ok-text">{formatNumber(calls?.ok)}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">失败</span>
            <span className="kv-val mono num err-text">{formatNumber(calls?.failed)}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">最近请求</span>
            <span className="kv-val mono dim">
              {rows.length > 0
                ? `${shortId(rows[0]!.requestId)} · ${formatTime(rows[0]!.ts)}`
                : '—'}
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-key">发布占比</span>
            <span className="kv-val mono num">
              {data && data.endpoints > 0 ? percent(data.published, data.endpoints) : '0%'}
            </span>
          </div>
        </div>
        <div className="card-foot">
          {connected ? (
            <Badge tone="green">实时</Badge>
          ) : (
            <Badge tone="gray">已断开</Badge>
          )}
          <span className="dim">
            {paused ? '已暂停刷新，点「继续」恢复' : '新调用会实时出现在上面的流水里'}
          </span>
        </div>
      </section>
    </>
  );
}
