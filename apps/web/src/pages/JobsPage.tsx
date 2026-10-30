import { Fragment, useEffect, useState } from 'react';
import { api, normalizeCandidate, streamImportJobs } from '../api.ts';
import { Badge, DiffBadge, MethodBadge } from '../components/Badge.tsx';
import { Empty, ErrorBox, Loading } from '../components/Empty.tsx';
import { ConfirmDialog } from '../components/Modal.tsx';
import { useToast } from '../components/Toast.tsx';
import { formatTime, shortId } from '../format.ts';
import { bumpData, errorMessage, useDataRev, useResource } from '../hooks.ts';
import { IMPORT_KIND_LABEL } from '../types.ts';
import type { Candidate, ImportJob, ImportKind, ImportStep } from '../types.ts';

/** 任务状态 → 中文 + 颜色 */
function jobStatusView(status: string): { label: string; tone: 'green' | 'orange' | 'red' | 'gray' | 'purple' } {
  switch (status) {
    case 'done':
      return { label: '完成', tone: 'green' };
    case 'running':
      return { label: '进行中', tone: 'purple' };
    case 'queued':
      return { label: '排队中', tone: 'gray' };
    case 'failed':
      return { label: '失败', tone: 'red' };
    case 'interrupted':
      return { label: '已中断', tone: 'orange' };
    default:
      return { label: status || '未知', tone: 'gray' };
  }
}

const STEP_ICON: Record<ImportStep['status'], string> = {
  pending: '○',
  running: '◐',
  done: '●',
  failed: '✕',
  skipped: '–',
};

/** 可发布的候选：还没决定、且不是重复/冲突 */
function publishable(cands: Candidate[]): Candidate[] {
  return cands.filter(
    (c) => c.decision === 'pending' && c.diffKind !== 'duplicate' && c.diffKind !== 'conflict',
  );
}

export function JobsPage() {
  const toast = useToast();
  const rev = useDataRev();
  const jobs = useResource(() => api.import.jobs(), [rev]);
  /** SSE 推来的最新列表；为 null 时回退到初始拉取结果 */
  const [live, setLive] = useState<ImportJob[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'done' | 'failed' | 'running'>('all');

  /** 按 jobId 缓存候选，展开时才拉 */
  const [cands, setCands] = useState<Record<string, Candidate[]>>({});
  const [loadingCands, setLoadingCands] = useState('');
  const [candsError, setCandsError] = useState<Record<string, string | null>>({});
  const [publishing, setPublishing] = useState('');
  const [busyCand, setBusyCand] = useState('');
  /** 刚发布的候选 → 生成的接口 id，用于「去改」直达编辑抽屉 */
  const [acceptedEndpoints, setAcceptedEndpoints] = useState<Record<string, string>>({});

  const list = live ?? jobs.data ?? [];

  /** 手动刷新：丢掉流里的缓存，重新拉一次 */
  const reload = () => {
    setLive(null);
    jobs.reload();
  };

  // 订阅导入事件流：有任务在跑时服务端会推每一帧，不用轮询
  useEffect(() => {
    const ac = new AbortController();
    let alive = true;

    void streamImportJobs((event) => {
      if (!alive) return;
      if (event.type === 'snapshot') {
        setLive(event.jobs);
        return;
      }
      const j = event.job;
      if (!j) return;
      setLive((prev) => {
        const base = prev ?? jobs.data ?? [];
        const idx = base.findIndex((x) => x.id === j.id);
        if (idx < 0) return [j, ...base];
        const next = base.slice();
        next[idx] = j;
        return next;
      });
    }, ac.signal).catch(() => {
      /* 流断了：退回初始列表，手动刷新仍可用 */
    });

    return () => {
      alive = false;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = list.filter((j) => {
    if (filter === 'all') return true;
    if (filter === 'running') return j.status === 'running' || j.status === 'queued';
    return j.status === filter;
  });

  const counts = {
    all: list.length,
    done: list.filter((j) => j.status === 'done').length,
    failed: list.filter((j) => j.status === 'failed' || j.status === 'interrupted').length,
    running: list.filter((j) => j.status === 'running' || j.status === 'queued').length,
  };

  /** 拉某个任务的候选：15 秒拿不到就报错，不再无限转圈 */
  const loadCands = async (jobId: string) => {
    setLoadingCands(jobId);
    setCandsError((prev) => ({ ...prev, [jobId]: null }));
    let timer = 0;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('候选加载超时（15 秒）')), 15000);
      });
      const detail = await Promise.race([api.import.job(jobId), timeout]);
      const parsed = (Array.isArray(detail.candidates) ? detail.candidates : [])
        .map((item) => normalizeCandidate(item))
        .filter((item): item is Candidate => item !== null);
      setCands((prev) => ({ ...prev, [jobId]: parsed }));
    } catch (err) {
      const text = errorMessage(err);
      setCandsError((prev) => ({ ...prev, [jobId]: text }));
      toast.error(text);
    } finally {
      window.clearTimeout(timer);
      setLoadingCands('');
    }
  };

  const toggleOpen = (job: ImportJob) => {
    const next = openId === job.id ? null : job.id;
    setOpenId(next);
    if (next && !cands[job.id]) void loadCands(job.id);
  };

  /** 发布全部：采纳所有待定候选 → 建接口 + 上线 + 编译工具 */
  const publishAll = async (job: ImportJob) => {
    setPublishing(job.id);
    try {
      const res = await api.import.acceptAll(job.id);
      toast.success(`发布完成：新建 ${res.created ?? 0}，更新 ${res.updated ?? 0}`);
      await loadCands(job.id);
      reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPublishing('');
    }
  };

  const acceptOne = async (job: ImportJob, cand: Candidate) => {
    setBusyCand(cand.id);
    try {
      const res = await api.import.accept(cand.id);
      if (res.endpointId) {
        setAcceptedEndpoints((prev) => ({ ...prev, [cand.id]: res.endpointId }));
      }
      setCands((prev) => ({
        ...prev,
        [job.id]: (prev[job.id] ?? []).map((c) =>
          c.id === cand.id ? { ...c, decision: 'accept' as const } : c,
        ),
      }));
      toast.success('已发布，需要调整就点「去改」');
      reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyCand('');
    }
  };

  const rejectOne = async (job: ImportJob, cand: Candidate) => {
    setBusyCand(cand.id);
    try {
      await api.import.reject(cand.id);
      setCands((prev) => ({
        ...prev,
        [job.id]: (prev[job.id] ?? []).map((c) =>
          c.id === cand.id ? { ...c, decision: 'reject' as const } : c,
        ),
      }));
      toast.success('已忽略');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyCand('');
    }
  };

  const doRemove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.import.remove(removing.id);
      toast.success('记录已删除');
      setRemoving(null);
      reload();
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (jobs.loading) return <Loading label="加载整理记录…" />;
  if (jobs.error) return <ErrorBox message={jobs.error} />;

  return (
    <div>
      <header className="page-head">
        <div>
          <h1 className="page-title">整理记录</h1>
          <div className="page-sub">
            每次一键整理都会留下一条记录。任务在后台跑，切页面、刷新都不会中断；
            <b>整理完在这里直接发布</b>，不用回到导入页。
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn ghost" onClick={() => reload()}>
            刷新
          </button>
        </div>
      </header>

      <div className="chips">
        {(
          [
            ['all', `全部 ${counts.all}`],
            ['running', `进行中 ${counts.running}`],
            ['done', `完成 ${counts.done}`],
            ['failed', `失败/中断 ${counts.failed}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`chip${filter === key ? ' active' : ''}`}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Empty title="没有记录" hint="到「一键整理」页粘一条 curl 试试。" />
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 150 }}>时间</th>
                <th style={{ width: 90 }}>状态</th>
                <th style={{ width: 70 }}>格式</th>
                <th style={{ width: 70 }}>站点</th>
                <th>结果</th>
                <th style={{ width: 90 }}>进度</th>
                <th style={{ width: 210 }} />
              </tr>
            </thead>
            <tbody>
              {shown.map((job) => {
                const view = jobStatusView(job.status);
                const s = job.stats;
                const expanded = openId === job.id;
                const jobCands = cands[job.id];
                const todo = jobCands ? publishable(jobCands).length : 0;
                const accepted = jobCands ? jobCands.filter((c) => c.decision === 'accept').length : 0;
                const canPublish = job.status === 'done' && jobCands !== undefined && todo > 0;

                return (
                  <Fragment key={job.id}>
                    <tr className={expanded ? 'row-open' : undefined}>
                      <td className="mono small">{formatTime(job.createdAt ?? '')}</td>
                      <td>
                        <Badge tone={view.tone}>{view.label}</Badge>
                      </td>
                      <td className="small">{job.kind ? (IMPORT_KIND_LABEL[job.kind as ImportKind] ?? job.kind) : '-'}</td>
                      <td className="mono small">{job.siteCount ?? 0}</td>
                      <td className="small">
                        {job.status === 'failed' ? (
                          <span className="danger">{job.error || '失败'}</span>
                        ) : (
                          <span className="dim">
                            解析 {s?.parsed ?? 0} · 候选 {s?.candidates ?? 0} · 重复 {s?.duplicates ?? 0}
                            {s?.aiEnriched ? ` · AI ${s.aiEnriched}` : ''}
                            {accepted > 0 ? ` · 已发布 ${accepted}` : ''}
                          </span>
                        )}
                      </td>
                      <td className="small mono">
                        {job.status === 'done' ? 100 : (job.progress ?? 0)}%
                      </td>
                      <td>
                        <div className="row-actions">
                          {canPublish ? (
                            <button
                              type="button"
                              className="btn primary sm"
                              disabled={publishing === job.id}
                              onClick={() => void publishAll(job)}
                            >
                              {publishing === job.id ? '发布中…' : `发布全部（${todo}）`}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => toggleOpen(job)}
                          >
                            {expanded ? '收起' : '详情'}
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm danger"
                            onClick={() => setRemoving(job)}
                            disabled={job.status === 'running' || job.status === 'queued'}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>

                    {expanded ? (
                      <tr>
                        <td colSpan={7}>
                          <div className="job-detail">
                            <div className="step-list">
                              {(job.steps ?? []).map((st) => (
                                <div key={st.key} className={`step step-${st.status}`}>
                                  <span className="step-icon mono">{STEP_ICON[st.status]}</span>
                                  <span className="step-label">{st.label}</span>
                                  <span className="step-detail">{st.detail}</span>
                                </div>
                              ))}
                              {(job.steps ?? []).length === 0 ? (
                                <div className="dim small">这条记录没有步骤信息（旧版本任务）</div>
                              ) : null}
                            </div>

                            {s?.sites?.length ? (
                              <div className="job-sites">
                                <div className="dim small">涉及站点</div>
                                {s.sites.map((site) => (
                                  <div key={site.slug} className="mono small">
                                    {site.name || site.slug} · {site.baseUrl} · {site.count} 个接口
                                  </div>
                                ))}
                              </div>
                            ) : null}

                            {s?.aiErrors?.length ? (
                              <div className="notice warn">
                                AI 步骤有降级：{s.aiErrors.slice(0, 4).join('；')}
                              </div>
                            ) : null}

                            {/* 候选：可逐条发布 */}
                            {loadingCands === job.id ? (
                              <div className="dim small">加载候选…</div>
                            ) : null}

                            {candsError[job.id] ? (
                              <div className="notice warn">
                                候选加载失败：{candsError[job.id]}
                                <button
                                  type="button"
                                  className="btn sm ghost"
                                  style={{ marginLeft: 8 }}
                                  onClick={() => void loadCands(job.id)}
                                >
                                  重试
                                </button>
                              </div>
                            ) : null}

                            {jobCands && jobCands.length > 0 ? (
                              <div className="job-cands">
                                <div className="job-cands-head">
                                  <span className="dim small">
                                    候选 {jobCands.length} 个 · 待发布 {todo} 个
                                    {accepted > 0 ? ` · 已发布 ${accepted} 个` : ''}
                                  </span>
                                  {canPublish ? (
                                    <button
                                      type="button"
                                      className="btn primary sm"
                                      disabled={publishing === job.id}
                                      onClick={() => void publishAll(job)}
                                    >
                                      {publishing === job.id ? '发布中…' : '发布全部'}
                                    </button>
                                  ) : null}
                                </div>

                                {jobCands.map((cand) => {
                                  const payload = cand.payload;
                                  const decided = cand.decision !== 'pending';
                                  const blocked =
                                    cand.diffKind === 'duplicate' || cand.diffKind === 'conflict';
                                  return (
                                    <article
                                      key={cand.id}
                                      className={`job-cand${cand.decision === 'reject' ? ' is-rejected' : ''}`}
                                    >
                                      <div className="job-cand-head">
                                        <MethodBadge method={payload.method} />
                                        <span className="mono">{payload.publicName || payload.slug}</span>
                                        <DiffBadge kind={cand.diffKind} />
                                        {cand.decision === 'accept' ? (
                                          <Badge tone="green">已发布</Badge>
                                        ) : null}
                                        {cand.decision === 'reject' ? (
                                          <Badge tone="gray">已忽略</Badge>
                                        ) : null}
                                        <span className="dim small mono ellipsis" title={payload.pathTemplate}>
                                          {payload.pathTemplate}
                                        </span>
                                        <div className="row-actions">
                                          {acceptedEndpoints[cand.id] ? (
                                            <button
                                              type="button"
                                              className="btn ghost sm"
                                              onClick={() => {
                                                window.location.hash = `/endpoints?edit=${acceptedEndpoints[cand.id]}`;
                                              }}
                                            >
                                              去改
                                            </button>
                                          ) : (
                                            <button
                                              type="button"
                                              className="btn sm"
                                              disabled={decided || blocked || busyCand === cand.id}
                                              onClick={() => void acceptOne(job, cand)}
                                              title={blocked ? '重复或冲突的候选不能直接发布' : undefined}
                                            >
                                              发布
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            className="btn ghost sm"
                                            disabled={decided || busyCand === cand.id}
                                            onClick={() => void rejectOne(job, cand)}
                                          >
                                            忽略
                                          </button>
                                        </div>
                                      </div>

                                      {payload.summary ? (
                                        <div className="candidate-summary">{payload.summary}</div>
                                      ) : null}
                                      {payload.description ? (
                                        <div className="candidate-desc">{payload.description}</div>
                                      ) : null}
                                      {payload.notes ? (
                                        <div className="candidate-notes">{payload.notes}</div>
                                      ) : null}
                                    </article>
                                  );
                                })}
                              </div>
                            ) : null}

                            <div className="mono dim small" title={job.id}>
                              任务 {shortId(job.id)} · 创建 {formatTime(job.createdAt ?? '')}
                              {job.finishedAt ? ` · 结束 ${formatTime(job.finishedAt)}` : ''}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        title="删除整理记录"
        danger
        confirmLabel="删除"
        busy={busy}
        message={
          <span>
            确认删除任务 <b className="mono">{shortId(removing?.id)}</b> 及其候选？
            已经发布的接口不受影响。
          </span>
        }
        onCancel={() => setRemoving(null)}
        onConfirm={() => void doRemove()}
      />
    </div>
  );
}
