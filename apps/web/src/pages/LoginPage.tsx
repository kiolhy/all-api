import { useState } from 'react';
import { authApi, ApiError, type Session } from '../api.ts';

export function LoginPage({ onLoggedIn }: { onLoggedIn: (session: Session) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

        <div className="login-tip">
          首次使用默认账号 <code className="mono">admin</code> / <code className="mono">admin123456</code>，
          登录后请立即在「修改密码」里更换。
        </div>
      </form>
    </div>
  );
}
