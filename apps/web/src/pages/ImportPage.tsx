import { useEffect, useMemo, useRef, useState } from 'react';
import { api, normalizeCandidate, streamImportJobs } from '../api.ts';
import { Badge, DiffBadge, MethodBadge } from '../components/Badge.tsx';
import { Empty, ErrorBox, Loading } from '../components/Empty.tsx';
import { Checkbox, Field, Select, TextArea } from '../components/Field.tsx';
import { JsonView } from '../components/JsonView.tsx';
import { Modal } from '../components/Modal.tsx';
import { useToast } from '../components/Toast.tsx';
import { formatTime } from '../format.ts';
import { bumpData, errorMessage, useDataRev, useResource } from '../hooks.ts';
import { IMPORT_KINDS } from '../types.ts';
import type { Candidate, ImportJob, ImportKind, ImportRunResult, ImportStats } from '../types.ts';

type KindChoice = 'auto' | ImportKind;

/** 正在跑的导入任务 id，存本地：切走再回来能接着看进度 */
const ACTIVE_JOB_KEY = 'aah_active_import_job';
/** 最后一次导入任务 id：任务跑完后仍然保留，回来还能看到候选并发布 */
const LAST_JOB_KEY = 'aah_last_import_job';

const CURL_PLACEHOLDER = `curl 'https://api.example.com/v1/users?limit=20' \\
  -H 'authorization: Bearer \${secret:EXAMPLE_TOKEN}' \\
  -H 'content-type: application/json'

# 也支持 HAR / OpenAPI(JSON|YAML) / 任意含请求的文本
# 一次可以粘多条，用空行分隔`;

export function ImportPage() {
  const toast = useToast();
  const rev = useDataRev();
  const platforms = useResource(() => api.platforms.list(), [rev]);
  const jobs = useResource(() => api.import.jobs().catch(() => [] as ImportJob[]), [rev]);
  // /api/health 是公开端点，普通成员也能读，用来判断 LLM 是否可用
  const health = useResource(() => api.health().catch(() => null), []);
  const llmOff = health.data?.llm?.enabled === false;

  const [text, setText] = useState('');
  const [kind, setKind] = useState<KindChoice>('auto');
  const [platformSlug, setPlatformSlug] = useState('');
  const [useAi, setUseAi] = useState(true);
  const [probeUpstream, setProbeUpstream] = useState(true);
  const [autoPublish, setAutoPublish] = useState(false);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ImportRunResult | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busyCandidate, setBusyCandidate] = useState('');
  const [acceptingAll, setAcceptingAll] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [siteFilter, setSiteFilter] = useState('');

  /** 当前跟踪的任务 id。用 ref 是为了让 SSE 回调读到最新值 */
  const trackedRef = useRef(localStorage.getItem(ACTIVE_JOB_KEY) ?? '');
  const [trackedId, setTrackedId] = useState(trackedRef.current);

  const trackJob = (id: string) => {
    trackedRef.current = id;
    setTrackedId(id);
  };

  const activeJobId = String(job?.id ?? result?.jobId ?? trackedId ?? '');

  /**
   * 「全部采纳」会直接写库 + 编译工具，不再逐条确认。
   * 点之前先把账算清楚：新建几个、更新几个、跳过几个。
   * 判重口径跟服务端 accept-all 一致：只处理 pending，且跳过 conflict / duplicate。
   */
  const bulkPreview = useMemo(() => {
    const pending = candidates.filter((c) => c.decision === 'pending');
    return {
      total: candidates.length,
      pending: pending.length,
      create: pending.filter((c) => c.diffKind === 'new').length,
      update: pending.filter((c) => c.diffKind === 'modified').length,
      conflict: pending.filter((c) => c.diffKind === 'conflict').length,
      duplicate: pending.filter((c) => c.diffKind === 'duplicate').length,
      handled: candidates.length - pending.length,
      // 导入阶段就被判重、压根没进候选列表的那些
      skippedAtImport: job?.stats?.duplicates ?? 0,
    };
  }, [candidates, job]);

  const loadJob = async (jobId: string) => {
    setLoadError(null);
    try {
      const detail = await api.import.job(jobId);
      setJob(detail.job ?? { id: jobId });
      const list = Array.isArray(detail.candidates)
        ? detail.candidates.map((item) => normalizeCandidate(item)).filter((item): item is Candidate => item !== null)
        : [];
      setCandidates(list);
      return detail.job;
    } catch (err) {
      setLoadError(errorMessage(err));
      toast.error(errorMessage(err));
      return null;
    }
  };

  // 挂载时若没有正在跑的任务，恢复上一次整理的结果，
  // 否则离开页面再回来候选列表是空的，就没法发布了。
  useEffect(() => {
    if (trackedRef.current) return;
    const last = localStorage.getItem(LAST_JOB_KEY);
    if (last) trackJob(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 订阅导入任务事件流（SSE），替代 1.2s 轮询。
   *
   * 服务端每完成一步推一帧，步骤几乎是即时出现的。
   * 只有「任务结束」时才额外拉一次候选（流里只带任务元数据）。
   */
  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    const finished = new Set<string>();
    /** 本次会话里真的见过它跑的任务：只有这些才弹完成提示 */
    const sawRunning = new Set<string>();

    const settle = async (j: ImportJob, wasRunning: boolean) => {
      if (finished.has(j.id)) return;
      finished.add(j.id);

      localStorage.removeItem(ACTIVE_JOB_KEY);
      localStorage.setItem(LAST_JOB_KEY, j.id);

      // 拉一次候选（含备注、对外名）
      await loadJob(j.id);
      if (!alive) return;

      bumpData();
      jobs.reload();

      if (!wasRunning) return; // 只是恢复历史任务，不打扰
      if (j.status === 'failed') {
        toast.error(j.error || '整理失败');
      } else {
        const n = j.stats?.candidates ?? 0;
        const note = j.stats?.agentSummary ? `（${j.stats.agentSummary}）` : '';
        toast.success(`整理完成：候选 ${n} 条${note}`);
      }
    };

    const apply = (j: ImportJob) => {
      setJob(j);
      const isRunning = j.status === 'running' || j.status === 'queued';
      setRunning(isRunning);
      if (isRunning) sawRunning.add(j.id);
      else void settle(j, sawRunning.has(j.id));
    };

    void streamImportJobs((event) => {
      if (!alive) return;
      if (event.type === 'snapshot') {
        const mine = event.jobs.find((x) => x.id === trackedRef.current);
        if (mine) apply(mine);
        return;
      }
      if (event.job && event.job.id === trackedRef.current) apply(event.job);
    }, ac.signal).catch(() => {
      /* 流断了：保持现状，用户可点「重新载入」 */
    });

    return () => {
      alive = false;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async () => {    if (!text.trim()) {
      toast.error('先粘贴点内容：curl / HAR / OpenAPI 都行');
      return;
    }
    setRunning(true);
    setLoadError(null);
    setCandidates([]);
    setResult(null);
    setJob(null);
    try {
      // 异步：服务端立即返回 jobId，后台继续跑；这里开始轮询
      const started = await api.import.run({
        text,
        kind: kind === 'auto' ? undefined : kind,
        platformSlug: platformSlug || undefined,
        useAi,
        autoPublish,
        probeUpstream,
      });
      // 记住要跟踪的任务；进度靠 SSE 推，不再轮询
      trackJob(started.jobId);
      localStorage.setItem(ACTIVE_JOB_KEY, started.jobId);
      toast.success('已提交，后台整理中（可以切到别的页面）');
    } catch (err) {
      toast.error(errorMessage(err));
      setRunning(false);
    }
  };

  const accept = async (candidate: Candidate) => {
    setBusyCandidate(candidate.id);
    try {
      await api.import.accept(candidate.id);
      setCandidates((prev) =>
        prev.map((item) => (item.id === candidate.id ? { ...item, decision: 'accept' } : item)),
      );
      toast.success(`已采纳 ${candidate.payload?.slug ?? candidate.id}`);
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyCandidate('');
    }
  };

  const reject = async (candidate: Candidate) => {
    setBusyCandidate(candidate.id);
    try {
      await api.import.reject(candidate.id);
      setCandidates((prev) =>
        prev.map((item) => (item.id === candidate.id ? { ...item, decision: 'reject' } : item)),
      );
      toast.info(`已忽略 ${candidate.payload?.slug ?? candidate.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyCandidate('');
    }
  };

  const acceptAll = async () => {
    if (!activeJobId) return;
    setConfirmingAll(false);
    setAcceptingAll(true);
    try {
      const res = await api.import.acceptAll(activeJobId);
      toast.success(`全部采纳完成：新建 ${res.created ?? 0}，更新 ${res.updated ?? 0}`);
      await loadJob(activeJobId);
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAcceptingAll(false);
    }
  };

  const stats = job?.stats ?? result?.stats;

  /** 按站点手动筛选候选 */
  const filteredCandidates = useMemo(() => {
    if (!siteFilter) return candidates;
    return candidates.filter((c) => c.platformSlug === siteFilter);
  }, [candidates, siteFilter]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">一键整理</h1>
          <div className="page-sub">粘贴 curl / HAR / OpenAPI，AI 归一出接口候选，确认后入库</div>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setText('');
              setCandidates([]);
              setResult(null);
              setJob(null);
              setLoadError(null);
            }}
          >
            清空
          </button>
        </div>
      </header>

      <div className="split-import">
        <section className="card import-input">
          <div className="card-head">
            <div className="card-title">输入</div>
            <div className="card-sub">支持多条，用空行分隔</div>
          </div>
          <div className="card-body">
            <TextArea
              mono
              rows={16}
              value={text}
              placeholder={CURL_PLACEHOLDER}
              onChange={(event) => setText(event.target.value)}
            />
            <div className="toolbar">
              <Field label="类型">
                <Select value={kind} onChange={(event) => setKind(event.target.value as KindChoice)}>
                  <option value="auto">自动识别</option>
                  {IMPORT_KINDS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="目标平台">
                <Select
                  value={platformSlug}
                  onChange={(event) => setPlatformSlug(event.target.value)}
                >
                  <option value="">自动匹配 / 由内容推断</option>
                  {(platforms.data ?? []).map((platform) => (
                    <option key={platform.id} value={platform.slug}>
                      {platform.slug} · {platform.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="选项">
                <div className="inline-checks">
                  <Checkbox checked={useAi} onChange={setUseAi} label="用 AI 分析" />
                  <Checkbox
                    checked={probeUpstream}
                    onChange={setProbeUpstream}
                    label="真实探测（只读接口）"
                  />
                  <Checkbox
                    checked={autoPublish}
                    onChange={setAutoPublish}
                    label="直接发布（整理完立即上线接口）"
                  />
                </div>
              </Field>
            </div>
            {useAi && llmOff ? (
              <div className="notice warn">
                LLM 未启用 —— 这次整理只会做规则解析，<b>AI 备注和接口介绍不会生成</b>。
                到「设置」页填好 API Key 后重新整理即可。
              </div>
            ) : null}
            <div className="toolbar-actions">
              <button type="button" className="btn primary" onClick={() => void run()} disabled={running}>
                {running ? '整理中…' : '开始整理'}
              </button>
              <span className="dim small">
                {text.trim() ? `已输入 ${text.length} 字符` : '未输入内容'}
              </span>
            </div>
          </div>

          {(jobs.data ?? []).length > 0 ? (
            <div className="card-foot jobs-strip">
              <span className="dim small">最近任务</span>
              {(jobs.data ?? []).slice(0, 5).map((item) => {
                const id = String(item.id ?? '');
                if (!id) return null;
                return (
                  <button
                    key={id}
                    type="button"
                    className={`chip${id === activeJobId ? ' active' : ''}`}
                    onClick={() => void loadJob(id)}
                    title={id}
                  >
                    {id.slice(0, 8)} · {item.status ?? 'unknown'}
                    {item.stats ? ` · ${item.stats.candidates}` : ''}
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>

        <section className="card import-output">
          <div className="card-head">
            <div className="card-title">候选</div>
            <div className="card-sub">
              {activeJobId ? (
                <span className="mono dim">job {activeJobId.slice(0, 12)}</span>
              ) : (
                '整理后在这里逐条采纳 / 忽略'
              )}
            </div>
            <div className="card-actions">
              <button
                type="button"
                className="btn sm"
                onClick={() => setConfirmingAll(true)}
                disabled={!activeJobId || acceptingAll || bulkPreview.pending === 0}
              >
                {acceptingAll ? '采纳中…' : `全部采纳${bulkPreview.pending ? ` (${bulkPreview.pending})` : ''}`}
              </button>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => activeJobId && void loadJob(activeJobId)}
                disabled={!activeJobId}
              >
                重新载入
              </button>
            </div>
          </div>

          <div className="card-body">
            {stats ? (
              <div className="chips">
                <Badge tone="blue">识别 {stats.parsed ?? 0} 条</Badge>
                <Badge tone="green">候选 {stats.candidates ?? 0} 条</Badge>
                <Badge tone="orange">去重 {stats.duplicates ?? 0} 条</Badge>
                {stats.probe && stats.probe.attempted > 0 ? (
                  <Badge tone={stats.probe.failed > 0 ? 'orange' : 'green'}>
                    探测 {stats.probe.succeeded}/{stats.probe.attempted} 成功
                  </Badge>
                ) : null}
                <Badge tone={stats.aiUsed ? 'purple' : 'gray'}>
                  {stats.aiUsed ? `AI 分析 ${stats.aiEnriched ?? 0} 个` : '未用 AI'}
                </Badge>
                {job?.status ? <Badge tone="gray">job {job.status}</Badge> : null}
              </div>
            ) : null}

            {stats?.agentSummary ? (
              <div className="notice ok">
                Agent 流水线：{stats.agentSummary}
                {stats.agentElapsedMs ? `，耗时 ${(stats.agentElapsedMs / 1000).toFixed(1)}s` : ''}
                {stats.probe && stats.probe.skipped > 0
                  ? `（${stats.probe.skipped} 个接口因写操作或缺样例值未探测）`
                  : ''}
              </div>
            ) : null}

            {stats?.aiErrors?.length ? (
              <div className="notice warn">
                AI 部分步骤失败，已降级为规则解析：
                {stats.aiErrors.slice(0, 3).join('；')}
              </div>
            ) : null}

            {loadError ? <ErrorBox message={loadError} /> : null}

            {/* 步骤进度：后台整理时实时显示 */}
            {job?.steps?.length ? (
              <div className="step-list">
                {job.steps.map((s) => (
                  <div key={s.key} className={`step step-${s.status}`}>
                    <span className="step-dot" aria-hidden />
                    <span className="step-label">{s.label}</span>
                    <span className="step-detail">{s.detail}</span>
                  </div>
                ))}
                {job.progress !== undefined && job.progress > 0 && job.progress < 100 ? (
                  <div className="progress">
                    <div className="progress-fill" style={{ width: `${job.progress}%` }} />
                  </div>
                ) : null}
              </div>
            ) : null}

            {running ? <Loading label="后台整理中…（可以切到别的页面，不会中断）" /> : null}

            {!running && candidates.length === 0 ? (
              <Empty
                title="还没有候选"
                hint="左侧粘贴一条 curl，点「开始整理」。识别出的接口会带 new/modified/conflict/duplicate 标记。"
              />
            ) : null}

            {/* 站点筛选：多个站点时按站点过滤 */}
            {stats?.sites && stats.sites.length > 1 ? (
              <div className="chips">
                <button
                  type="button"
                  className={`chip${siteFilter === '' ? ' active' : ''}`}
                  onClick={() => setSiteFilter('')}
                >
                  全部站点（{candidates.length}）
                </button>
                {stats.sites.map((site) => (
                  <button
                    key={site.slug}
                    type="button"
                    className={`chip${siteFilter === site.slug ? ' active' : ''}`}
                    onClick={() => setSiteFilter(site.slug)}
                    title={site.baseUrl}
                  >
                    {site.name || site.slug}（{site.count}）
                  </button>
                ))}
              </div>
            ) : null}

            <div className="candidate-list">
              {filteredCandidates.map((candidate) => {
                const payload = candidate.payload ?? ({} as Candidate['payload']);
                const params = Array.isArray(payload.params) ? payload.params : [];
                const decided = candidate.decision !== 'pending';
                return (
                  <article
                    key={candidate.id}
                    className={`candidate${candidate.decision === 'reject' ? ' is-rejected' : ''}`}
                  >
                    <div className="candidate-head">
                      <div className="candidate-title">
                        <DiffBadge kind={candidate.diffKind} />
                        <span className="mono strong">{payload.slug || '(未命名)'}</span>
                        <span className="method-line">
                          <MethodBadge method={payload.method || 'GET'} />
                          <span className="mono dim">{payload.pathTemplate || '—'}</span>
                        </span>
                      </div>
                      <div className="candidate-actions">
                        {decided ? (
                          <Badge tone={candidate.decision === 'accept' ? 'green' : 'gray'}>
                            {candidate.decision === 'accept' ? '已采纳' : '已忽略'}
                          </Badge>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn sm primary"
                              disabled={busyCandidate === candidate.id}
                              onClick={() => void accept(candidate)}
                            >
                              采纳
                            </button>
                            <button
                              type="button"
                              className="btn sm ghost"
                              disabled={busyCandidate === candidate.id}
                              onClick={() => void reject(candidate)}
                            >
                              忽略
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="candidate-meta">
                      <span className="dim">平台</span>
                      <span className="mono">{candidate.platformSlug || '—'}</span>
                      <span className="dim">分组</span>
                      <span className="mono">{payload.group || 'default'}</span>
                      <span className="dim">读写</span>
                      <span className="mono">{payload.sideEffect || 'read'}</span>
                      <span className="dim">时间</span>
                      <span className="mono dim">{formatTime(candidate.createdAt)}</span>
                    </div>

                    {payload.summary ? <div className="candidate-summary">{payload.summary}</div> : null}

                    {payload.description ? (
                      <div className="candidate-desc">{payload.description}</div>
                    ) : null}

                    {payload.notes ? (
                      <div className="candidate-notes">{payload.notes}</div>
                    ) : null}

                    {params.length > 0 ? (
                      <table className="table mini-table">
                        <thead>
                          <tr>
                            <th>参数</th>
                            <th>位置</th>
                            <th>类型</th>
                            <th>必填</th>
                            <th>说明</th>
                          </tr>
                        </thead>
                        <tbody>
                          {params.map((param, index) => (
                            <tr key={`${candidate.id}-p-${index}`}>
                              <td className="mono">{param?.name ?? '—'}</td>
                              <td className="mono dim">{param?.in ?? '—'}</td>
                              <td className="mono dim">{param?.type ?? '—'}</td>
                              <td>{param?.required ? <Badge tone="orange">必填</Badge> : <span className="dim">否</span>}</td>
                              <td className="dim">{param?.description || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="dim small">无参数</div>
                    )}

                    <JsonView value={candidate} label="原始 JSON" collapsed maxHeight={260} />
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      <Modal
        open={confirmingAll}
        title="确认全部采纳"
        subtitle="这一步会直接写库并编译工具，不再逐条确认"
        onClose={() => setConfirmingAll(false)}
        width={480}
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setConfirmingAll(false)} disabled={acceptingAll}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => void acceptAll()}
              disabled={acceptingAll || bulkPreview.create + bulkPreview.update === 0}
            >
              {acceptingAll
                ? '采纳中…'
                : `确认发布 ${bulkPreview.create + bulkPreview.update} 个`}
            </button>
          </>
        }
      >
        <div className="kv-grid">
          <div className="kv-row">
            <span className="kv-key">将新建</span>
            <span className="kv-val">{bulkPreview.create} 个接口</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">将更新</span>
            <span className="kv-val">{bulkPreview.update} 个接口</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">跳过 · 批次内冲突</span>
            <span className="kv-val">{bulkPreview.conflict} 个</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">跳过 · 重复</span>
            <span className="kv-val">{bulkPreview.duplicate + bulkPreview.skippedAtImport} 个</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">已处理过</span>
            <span className="kv-val">{bulkPreview.handled} 个</span>
          </div>
        </div>
        {bulkPreview.conflict > 0 ? (
          <div className="notice warn">
            有 {bulkPreview.conflict} 个接口和本批次里其他接口撞了（方法 + 路径 + 参数相同），
            会被跳过。要保留的话先回去逐条处理。
          </div>
        ) : null}
        {bulkPreview.create + bulkPreview.update === 0 ? (
          <div className="notice warn">
            没有可发布的接口 —— 全部被判重或已处理过。重复导入同一份文档时这是正常的。
          </div>
        ) : null}
      </Modal>
    </>
  );
}
