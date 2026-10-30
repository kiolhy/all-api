import { useState } from 'react';
import { authApi, ApiError, type Session } from '../api.ts';

/** 默认账号提示只在没成功登录过之前显示，避免把默认密码一直挂在登录页上 */
const HINT_KEY = 'hub.login.hint';

function readHintVisible(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function LoginPage({ onLoggedIn }: { onLoggedIn: (session: Session) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHint, setShowHint] = useState(readHintVisible);

  const dismissHint = () => {
    setShowHint(false);
    try {
      window.localStorage.setItem(HINT_KEY, 'off');
    } catch {
      /* 隐私模式下写不进去，忽略 */
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!username.trim() || !password) {
      setError('请填写用户名和密码');
      return;
    }
    setBusy(true);
    try {
      const result = await authApi.login(username.trim(), password);
      dismissHint();
      onLoggedIn({ token: result.token, account: result.account });
    } catch (err) {
      const e = err as ApiError;
      setError(e?.message ?? '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            ⌗
          </span>
          <div>
            <div className="login-title">接口资产中枢</div>
            <div className="login-sub">登录以管理接口、令牌与 AI 工具</div>
          </div>
        </div>

        <label className="login-field">
          <span>用户名</span>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            spellCheck={false}
          />
        </label>

        <label className="login-field">
          <span>密码</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {error ? <div className="login-error">{error}</div> : null}

        <button type="submit" className="btn primary login-submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>

        {showHint ? (
          <div className="login-tip">
            <span className="login-tip-text">
              首次使用默认账号 <code className="mono">admin</code> /{' '}
              <code className="mono">admin123456</code>，登录后请立即到「设置 → 修改密码」更换。
            </span>
            <button
              type="button"
              className="login-tip-close"
              title="不再显示这条提示"
              aria-label="不再显示"
              onClick={dismissHint}
            >
              ×
            </button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
