import { useEffect, useState } from 'react';
import { authApi, api, setSession } from '../api.ts';
import { Badge } from '../components/Badge.tsx';
import { ErrorBox } from '../components/Empty.tsx';
import { Field, FormGrid, TextInput, Toggle } from '../components/Field.tsx';
import { useToast } from '../components/Toast.tsx';
import { formatNumber, formatTime } from '../format.ts';
import { bumpData, errorMessage, useResource } from '../hooks.ts';
import type { ApplyUpdateResult, UpdateState } from '../types.ts';

export function SettingsPage() {
  const toast = useToast();
  const settings = useResource(() => api.settings.get(), []);

  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('30000');
  const [saving, setSaving] = useState(false);

  // ── 在线更新 ──
  const [state, setState] = useState<UpdateState | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyUpdateResult | null>(null);

  const behind = state?.behind ?? 0;

  // ── 修改密码 ──
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');

  const submitPassword = async () => {
    setPwError('');
    if (!oldPassword) {
      setPwError('请填写当前密码');
      return;
    }
    if (newPassword.length < 6) {
      setPwError('新密码至少 6 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError('两次输入的新密码不一致');
      return;
    }
    if (newPassword === oldPassword) {
      setPwError('新密码不能和当前密码相同');
      return;
    }
    setPwBusy(true);
    try {
      await authApi.changePassword(oldPassword, newPassword);
      toast.success('密码已修改，请用新密码重新登录');
      setSession(null);
      window.location.hash = '/';
      window.location.reload();
    } catch (err) {
      setPwError(errorMessage(err));
      setPwBusy(false);
    }
  };

  useEffect(() => {
    let alive = true;
    api.update
      .local()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {
        /* 未登录或端点不可用时静默，不打断设置页其他功能 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const doCheck = async () => {
    setChecking(true);
    try {
      const s = await api.update.check(true);
      setState(s);
      if (!s.isGit) toast.error('不是 git 仓库，无法在线更新');
      else if (s.dirty) toast.error('工作区有未提交改动');
      else if (s.behind > 0) toast.success(`落后 ${s.behind} 个提交，可以更新`);
      else toast.success('已是最新版本');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const doApply = async () => {
    setApplying(true);
    setApplyResult(null);
    try {
      const result = await api.update.apply();
      setApplyResult(result);
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      // 拉完刷新本地状态，让界面反映新提交
      const fresh = await api.update.local().catch(() => null);
      if (fresh) setState(fresh);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setApplying(false);
    }
  };

  const egress = settings.data?.egress;
  const llm = settings.data?.llm;

  useEffect(() => {
    const data = settings.data;
    if (!data) return;
    setEnabled(Boolean(data.llm?.enabled));
    setBaseUrl(data.llm?.baseUrl ?? '');
    setModel(data.llm?.model ?? '');
    setTimeoutMs(String(data.llm?.timeoutMs ?? data.egress?.timeoutMs ?? 30000));
    setApiKey('');
  }, [settings.data]);

  const save = async () => {
    const timeout = Number(timeoutMs);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      toast.error('timeoutMs 需要是正数');
      return;
    }
    if (enabled && !apiKey.trim() && !llm?.apiKeySet) {
      toast.error('要启用 LLM，必须填 apiKey');
      return;
    }
    setSaving(true);
    try {
      const result = await api.settings.save({
        llm: {
          enabled,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          timeoutMs: Math.round(timeout),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
      });
      setApiKey('');
      // 用服务端返回的真实状态回填，避免「以为开了其实没开」
      if (enabled && !result?.llm?.enabled) {
        toast.error('已保存，但 LLM 仍是关闭状态：缺少 apiKey');
        setEnabled(false);
      } else {
        toast.success(result?.llm?.enabled ? '设置已保存，LLM 已启用' : '设置已保存');
      }
      settings.reload();
      // 让概览页等别处跟着刷新 LLM 状态，别一个说已启用一个说未启用
      bumpData();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    setSaving(true);
    try {
      await api.settings.save({ llm: { clearApiKey: true } });
      toast.success('已清除 apiKey，LLM 已关闭');
      setApiKey('');
      setEnabled(false);
      settings.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <div className="page-sub">LLM 用于「一键整理」的补全；出网配置由服务端 env 决定，这里只读</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn ghost" onClick={() => settings.reload()}>
            刷新
          </button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={saving || settings.loading}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </header>

      {settings.error ? <ErrorBox message={settings.error} onRetry={settings.reload} /> : null}

      {llm?.blockedByApiKey ? (
        <div className="notice warn">
          <b>LLM 当前是关闭的</b>，因为还没有配置 apiKey。填上 apiKey 并打开「启用」开关后保存，
          才能生效。没有 apiKey 时，「一键整理」只用规则解析。
        </div>
      ) : null}
      {llm?.enabled ? (
        <div className="notice ok">
          LLM 已启用：<span className="mono">{llm.model}</span> @ <span className="mono">{llm.baseUrl}</span>
        </div>
      ) : null}

      <section className="card">
        <div className="card-head">
          <div className="card-title">LLM</div>
          <div className="card-sub">
            {llm?.apiKeySet ? <Badge tone="green">已配置 apiKey</Badge> : <Badge tone="gray">未配置 apiKey</Badge>}
            {llm?.updatedAt ? (
              <span className="dim small">
                {' '}
                · 最后修改 {formatTime(llm.updatedAt)}
                {llm.updatedBy ? ` by ${llm.updatedBy}` : ''}
              </span>
            ) : null}
          </div>
        </div>
        <div className="card-body">
          <FormGrid>
            <Field label="启用" hint="关闭后 import 只用规则解析">
              <Toggle checked={enabled} onChange={setEnabled} label={enabled ? '已启用' : '未启用'} />
            </Field>
            <Field label="model">
              <TextInput mono value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" />
            </Field>
            <Field label="baseUrl" span>
              <TextInput
                mono
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </Field>
            <Field label="apiKey" hint="留空表示不修改（服务端已保存的值保留）" span>
              <div className="inline-checks">
                <TextInput
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={llm?.apiKeySet ? '已保存，留空表示不改' : '填入你的 API Key'}
                  autoComplete="new-password"
                />
                {llm?.apiKeySet ? (
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => void clearKey()}
                    disabled={saving}
                  >
                    清除已存 Key
                  </button>
                ) : null}
              </div>
            </Field>
            <Field label="timeoutMs">
              <TextInput mono value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} />
            </Field>
          </FormGrid>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div className="card-title">出网配置</div>
          <div className="card-sub">只读 · 由服务端环境变量控制</div>
        </div>
        <div className="card-body">
          <div className="kv-grid">
            <div className="kv-row">
              <span className="kv-key">allowPrivate</span>
              <span className="kv-val mono">{String(egress?.allowPrivate ?? '—')}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">timeoutMs</span>
              <span className="kv-val mono num">{formatNumber(egress?.timeoutMs)}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">maxBytes</span>
              <span className="kv-val mono num">{formatNumber(egress?.maxBytes)}</span>
            </div>
          </div>
          <div className="dim small" style={{ marginTop: 10 }}>
            平台级白名单在「平台」页维护；全局 allowPrivate / 超时 / 体积上限请改服务端 env 后重启。
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div className="card-title">修改密码</div>
          <div className="card-sub">改完所有已登录会话立即失效，需要用新密码重新登录</div>
        </div>
        <div className="card-body">
          <FormGrid>
            <Field label="当前密码" span>
              <TextInput
                type="password"
                value={oldPassword}
                onChange={(event) => setOldPassword(event.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <Field label="新密码" hint="至少 6 位">
              <TextInput
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <Field label="确认新密码">
              <TextInput
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </FormGrid>
          {pwError ? <div className="field-error">{pwError}</div> : null}
        </div>
        <div className="card-foot">
          <button
            type="button"
            className="btn primary"
            onClick={() => void submitPassword()}
            disabled={pwBusy}
          >
            {pwBusy ? '提交中…' : '修改密码'}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div className="card-title">版本与更新</div>
          <div className="card-sub">从 git 远程拉取 · 需要重启生效</div>
        </div>
        <div className="card-body">
          <div className="kv-grid">
            <div className="kv-row">
              <span className="kv-key">版本</span>
              <span className="kv-val mono">{state?.version ?? '—'}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">提交</span>
              <span className="kv-val mono">
                {state?.shortCommit ? (
                  <span title={state.commitSubject}>{state.shortCommit}</span>
                ) : (
                  '—'
                )}
              </span>
            </div>
            <div className="kv-row">
              <span className="kv-key">分支</span>
              <span className="kv-val mono">{state?.branch || '—'}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">远程</span>
              <span className="kv-val mono small">{state?.remote || '未配置'}</span>
            </div>
            <div className="kv-row">
              <span className="kv-key">状态</span>
              <span className="kv-val">
                {checking ? (
                  <span className="dim">检查中…</span>
                ) : behind > 0 ? (
                  <Badge tone="orange">落后 {behind} 个提交</Badge>
                ) : state?.dirty ? (
                  <Badge tone="red">有未提交改动</Badge>
                ) : state?.checkedAt ? (
                  <Badge tone="green">已是最新</Badge>
                ) : (
                  <span className="dim">未检查</span>
                )}
              </span>
            </div>
          </div>

          {!state?.isGit ? (
            <div className="notice warn" style={{ marginTop: 10 }}>
              当前目录不是 git 仓库，没法在线更新。想用这个功能：
              把项目 `git clone` 下来，再从 clone 出来的目录启动。
            </div>
          ) : null}

          {behind > 0 && state?.latestSubject ? (
            <div className="notice" style={{ marginTop: 10 }}>
              远程最新：<span className="mono">{state.latestCommit.slice(0, 7)}</span> ·{' '}
              {state.latestSubject}
            </div>
          ) : null}

          {state?.dirty ? (
            <div className="notice warn" style={{ marginTop: 10 }}>
              工作区有未提交的改动。更新会覆盖它们，先提交或还原再继续。
            </div>
          ) : null}

          {applyResult ? (
            <div className={`notice ${applyResult.ok ? 'ok' : 'warn'}`} style={{ marginTop: 10 }}>
              <div style={{ marginBottom: 6 }}>{applyResult.message}</div>
              {applyResult.steps.map((s) => (
                <div key={s.name} className="dim small mono">
                  {s.ok ? '✔' : '✖'} {s.name}
                  {s.skipped ? '（跳过）' : ''}
                  {s.detail ? ` — ${s.detail}` : ''}
                </div>
              ))}
            </div>
          ) : null}

          {applyResult?.restartRequired ? (
            <div className="notice warn" style={{ marginTop: 10 }}>
              <b>需要重启才能生效。</b>代码已经换新，但进程里跑的还是旧代码。
              <div className="mono small" style={{ marginTop: 6 }}>
                Ctrl+C 停掉服务，再重新启动即可。
              </div>
            </div>
          ) : null}

          <div className="handoff-row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn ghost"
              disabled={checking || applying || !state?.isGit}
              onClick={() => void doCheck()}
            >
              {checking ? '检查中…' : '检查更新'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={applying || checking || behind <= 0 || Boolean(state?.dirty)}
              onClick={() => void doApply()}
            >
              {applying ? '更新中…' : '立即更新'}
            </button>
            <span className="dim small">
              {applying
                ? '正在拉取并重建前端，可能要一两分钟'
                : '更新 = git pull + 必要时装依赖 + 重建前端'}
            </span>
          </div>
        </div>
      </section>
    </>
  );
}
