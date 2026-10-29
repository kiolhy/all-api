import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge } from '../components/Badge.tsx';
import { ErrorBox } from '../components/Empty.tsx';
import { Field, FormGrid, TextInput, Toggle } from '../components/Field.tsx';
import { useToast } from '../components/Toast.tsx';
import { formatNumber } from '../format.ts';
import { errorMessage, useResource } from '../hooks.ts';

export function SettingsPage() {
  const toast = useToast();
  const settings = useResource(() => api.settings.get(), []);

  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('30000');
  const [saving, setSaving] = useState(false);

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

  return (    <>
      <header className="page-head">        <div>
          <h1 className="page-title">设置</h1>
          <div className="page-sub">LLM 用于「一键整理」的补全；出网配置由服务端 env 决定，这里只读</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn ghost" onClick={() => settings.reload()}>
            重新加载
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
    </>
  );
}
