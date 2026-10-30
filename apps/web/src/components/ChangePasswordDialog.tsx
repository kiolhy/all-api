import { useEffect, useState } from 'react';
import { authApi } from '../api.ts';
import { errorMessage } from '../hooks.ts';
import { Field, FormGrid, TextInput } from './Field.tsx';
import { Modal } from './Modal.tsx';

/**
 * 修改密码弹窗。
 * 改完服务端会让所有会话失效，这里回调 onChanged 让外壳清掉本地会话。
 */
export function ChangePasswordDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 每次打开都重置，避免残留上一次输入
  useEffect(() => {
    if (!open) return;
    setOldPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
    setBusy(false);
  }, [open]);

  const submit = async () => {
    setError('');
    if (!oldPassword) {
      setError('请填写当前密码');
      return;
    }
    if (newPassword.length < 6) {
      setError('新密码至少 6 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    if (newPassword === oldPassword) {
      setError('新密码不能和当前密码相同');
      return;
    }
    setBusy(true);
    try {
      await authApi.changePassword(oldPassword, newPassword);
      onClose();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="修改密码"
      subtitle="改完所有已登录会话立即失效，需要用新密码重新登录"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? '提交中…' : '修改密码'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormGrid>
          <Field label="当前密码" span>
            <TextInput
              type="password"
              value={oldPassword}
              onChange={(event) => setOldPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
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
      </form>
      {error ? <div className="field-error">{error}</div> : null}
    </Modal>
  );
}
