import { useState } from 'react';
import { accountsApi, ApiError } from '../api.ts';
import { Badge } from '../components/Badge.tsx';
import { Empty, ErrorBox } from '../components/Empty.tsx';
import { Checkbox, Field, Select, TextInput } from '../components/Field.tsx';
import { DataTable } from '../components/Table.tsx';
import type { Column } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { formatTime } from '../format.ts';
import { useResource } from '../hooks.ts';
import type { Account, Role } from '../types.ts';

export function AccountsPage({ me }: { me: Account }) {
  const toast = useToast();
  const [rev, setRev] = useState(0);
  const accounts = useResource(() => accountsApi.list(), [rev]);

  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const [resetTarget, setResetTarget] = useState<Account | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  const reload = () => setRev((v) => v + 1);

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError('');
    if (!username.trim() || !password) {
      setFormError('用户名和密码都要填');
      return;
    }
    setBusy(true);
    try {
      await accountsApi.create(username.trim(), password, role);
      toast.success(`已创建账号 ${username.trim()}`);
      setUsername('');
      setPassword('');
      setRole('member');
      setCreating(false);
      reload();
    } catch (err) {
      setFormError((err as ApiError)?.message ?? '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (account: Account, enabled: boolean) => {
    try {
      await accountsApi.setEnabled(account.id, enabled);
      toast.success(enabled ? '已启用' : '已停用');
      reload();
    } catch (err) {
      toast.error((err as ApiError)?.message ?? '操作失败');
    }
  };

  const changeRole = async (account: Account, next: Role) => {
    try {
      await accountsApi.setRole(account.id, next);
      toast.success('角色已更新');
      reload();
    } catch (err) {
      toast.error((err as ApiError)?.message ?? '操作失败');
    }
  };

  const remove = async (account: Account) => {
    if (!window.confirm(`确定删除账号 ${account.username}？该操作不可撤销。`)) return;
    try {
      await accountsApi.remove(account.id);
      toast.success('已删除');
      reload();
    } catch (err) {
      toast.error((err as ApiError)?.message ?? '删除失败');
    }
  };

  const submitReset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!resetTarget) return;
    try {
      await accountsApi.resetPassword(resetTarget.id, resetPassword);
      toast.success('密码已重置，该账号的会话已失效');
      setResetTarget(null);
      setResetPassword('');
      reload();
    } catch (err) {
      toast.error((err as ApiError)?.message ?? '重置失败');
    }
  };

  const columns: Column<Account>[] = [
    {
      key: 'username',
      title: '用户名',
      render: (row) => (
        <div className="cell-stack">
          <span className="mono">
            {row.username}
            {row.id === me.id ? <span className="dim small"> · 当前登录</span> : null}
          </span>
          <span className="mono dim small">{row.id}</span>
        </div>
      ),
    },
    {
      key: 'role',
      title: '角色',
      width: '130px',
      render: (row) =>
        row.id === me.id ? (
          <Badge tone={row.role === 'admin' ? 'purple' : 'gray'}>
            {row.role === 'admin' ? '管理员' : '成员'}
          </Badge>
        ) : (
          <Select
            value={row.role}
            onChange={(e) => changeRole(row, e.target.value as Role)}
            className="compact"
          >
            <option value="admin">管理员</option>
            <option value="member">成员</option>
          </Select>
        ),
    },
    {
      key: 'enabled',
      title: '状态',
      width: '90px',
      render: (row) => <Badge tone={row.enabled ? 'green' : 'red'}>{row.enabled ? '启用' : '停用'}</Badge>,
    },
    {
      key: 'lastLogin',
      title: '最近登录',
      width: '150px',
      render: (row) => (
        <span className="mono dim small">{row.lastLoginAt ? formatTime(row.lastLoginAt) : '从未'}</span>
      ),
    },
    {
      key: 'actions',
      title: '',
      width: '200px',
      align: 'right',
      render: (row) => (
        <div className="row-actions">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setResetTarget(row);
              setResetPassword('');
            }}
          >
            重置密码
          </button>
          {row.id === me.id ? null : (
            <>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => toggleEnabled(row, !row.enabled)}
              >
                {row.enabled ? '停用' : '启用'}
              </button>
              <button type="button" className="btn ghost sm danger" onClick={() => remove(row)}>
                删除
              </button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">账号</h1>
          <p className="page-sub">控制台登录账号。管理员可以创建、停用、重置密码。</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setCreating((v) => !v)}>
          {creating ? '取消' : '+ 新建账号'}
        </button>
      </div>

      {creating ? (
        <form className="panel" onSubmit={submitCreate}>
          <div className="panel-title">新建账号</div>
          <div className="form-row">
            <Field label="用户名">
              <TextInput
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="2-32 位字母数字"
                autoFocus
                spellCheck={false}
              />
            </Field>
            <Field label="初始密码" hint="至少 6 位，不能是纯数字">
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <Field label="角色">
              <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="member">成员</option>
                <option value="admin">管理员</option>
              </Select>
            </Field>
          </div>
          {formError ? <div className="field-error">{formError}</div> : null}
          <div className="panel-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? '创建中…' : '创建'}
            </button>
          </div>
        </form>
      ) : null}

      {resetTarget ? (
        <form className="panel" onSubmit={submitReset}>
          <div className="panel-title">重置 {resetTarget.username} 的密码</div>
          <Field label="新密码" hint="重置后该账号所有已登录会话立即失效">
            <TextInput
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              autoFocus
              autoComplete="new-password"
            />
          </Field>
          <div className="panel-actions">
            <button type="button" className="btn ghost" onClick={() => setResetTarget(null)}>
              取消
            </button>
            <button type="submit" className="btn primary">
              确认重置
            </button>
          </div>
        </form>
      ) : null}

      {accounts.error ? <ErrorBox message={accounts.error} onRetry={reload} /> : null}

      {accounts.loading && !accounts.data ? (
        <div className="empty">加载中…</div>
      ) : (accounts.data ?? []).length === 0 ? (
        <Empty title="还没有其他账号" hint="点右上角「新建账号」添加一个成员账号。" />
      ) : (
        <DataTable columns={columns} rows={accounts.data ?? []} rowKey={(row) => row.id} />
      )}
    </div>
  );
}
