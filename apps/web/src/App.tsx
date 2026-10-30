import { useCallback, useEffect, useRef, useState } from 'react';
import { authApi, getSession, setSession, setUnauthorizedHandler, type Session } from './api.ts';
import { ChangePasswordDialog } from './components/ChangePasswordDialog.tsx';
import { ToastProvider } from './components/Toast.tsx';
import { useHashRoute } from './hooks.ts';
import { AccountsPage } from './pages/AccountsPage.tsx';
import { AuditPage } from './pages/AuditPage.tsx';
import { ChatPage } from './pages/ChatPage.tsx';
import { EndpointsPage } from './pages/EndpointsPage.tsx';
import { ImportPage } from './pages/ImportPage.tsx';
import { JobsPage } from './pages/JobsPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { PlatformsPage } from './pages/PlatformsPage.tsx';
import { SecretsPage } from './pages/SecretsPage.tsx';
import { DocsPage } from './pages/DocsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { ToolsPage } from './pages/ToolsPage.tsx';

interface NavItem {
  path: string;
  label: string;
  hint: string;
  adminOnly?: boolean;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: '资产',
    items: [
      { path: '/', label: '概览', hint: '指标与最近审计' },
      { path: '/platforms', label: '平台', hint: '接入平台与鉴权' },
      { path: '/endpoints', label: '接口资产', hint: '参数、开放策略、发布' },
      { path: '/tools', label: '工具', hint: 'AI 侧工具视图' },
    ],
  },
  {
    title: '接入',
    items: [
      { path: '/import', label: '一键整理', hint: 'curl → 接口资产' },
      { path: '/jobs', label: '整理记录', hint: '后台任务与步骤' },
      { path: '/chat', label: '对话', hint: '站内 AI 调试' },
      { path: '/secrets', label: '密钥与令牌', hint: '出站凭据 / 入站令牌' },
      { path: '/docs', label: '交给其他 AI', hint: '生成接入包' },
    ],
  },
  {
    title: '系统',
    items: [
      { path: '/audit', label: '审计', hint: '调用流水' },
      { path: '/settings', label: '设置', hint: 'LLM 与出网' },
      { path: '/accounts', label: '账号', hint: '用户与权限', adminOnly: true },
    ],
  },
];

function Shell() {
  const { path, navigate } = useHashRoute();
  const [session, setSessionState] = useState<Session | null>(() => getSession());
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const clearSession = useCallback(() => {
    setSession(null);
    setSessionState(null);
  }, []);

  // 点菜单外面 / 按 Esc 关闭。不用遮罩层，否则用户按钮本身也被盖住点不动
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // 任何请求 401 都统一退出到登录页
  useEffect(() => {
    setUnauthorizedHandler(clearSession);
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  const handleLoggedIn = useCallback((next: Session) => {
    setSession(next);
    setSessionState(next);
  }, []);

  // 启动时校验一次会话是否还有效
  useEffect(() => {
    if (!session) return;
    let alive = true;
    authApi
      .me()
      .then((res) => {
        if (!alive) return;
        const refreshed = { token: session.token, account: res.account };
        setSession(refreshed);
        setSessionState(refreshed);
      })
      .catch(() => {
        /* 401 已由统一处理器清场 */
      });
    return () => {
      alive = false;
    };
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!session) {
    return <LoginPage onLoggedIn={handleLoggedIn} />;
  }

  const isAdmin = session.account.role === 'admin';

  const doLogout = async () => {
    try {
      await authApi.logout();
    } catch {
      /* 忽略：本地清掉即可 */
    }
    clearSession();
    setMenuOpen(false);
  };

  const renderPage = () => {
    switch (path) {
      case '/platforms':
        return <PlatformsPage />;
      case '/import':
        return <ImportPage />;
      case '/jobs':
        return <JobsPage />;
      case '/endpoints':
        return <EndpointsPage />;
      case '/tools':
        return <ToolsPage />;
      case '/chat':
        return <ChatPage />;
      case '/secrets':
        return <SecretsPage />;
      case '/docs':
        return <DocsPage />;
      case '/audit':
        return <AuditPage />;
      case '/settings':
        return <SettingsPage />;
      case '/accounts':
        return isAdmin ? (
          <AccountsPage me={session.account} />
        ) : (
          <div className="empty">需要管理员权限</div>
        );
      default:
        return <OverviewPage />;
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ⌗
          </span>
          <span className="brand-text">
            接口资产中枢
            <span className="brand-sub">console</span>
          </span>
        </div>

        <div className="user-area" ref={menuRef}>
          <button
            type="button"
            className="user-chip"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="avatar">{session.account.username.slice(0, 1).toUpperCase()}</span>
            <span className="user-name">{session.account.username}</span>
            <span className={`role-badge ${session.account.role}`}>
              {session.account.role === 'admin' ? '管理员' : '成员'}
            </span>
            <span className="caret">▾</span>
          </button>

          {menuOpen ? (
            <div className="user-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setPasswordOpen(true);
                }}
              >
                修改密码
              </button>
              <button type="button" role="menuitem" className="danger" onClick={doLogout}>
                退出登录
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="layout">
        <nav className="sidebar">
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter((it) => !it.adminOnly || isAdmin);
            if (!items.length) return null;
            return (
              <div className="nav-group" key={group.title}>
                <div className="nav-group-title">{group.title}</div>
                {items.map((item) => {
                  const active = item.path === '/' ? path === '/' : path.startsWith(item.path);
                  return (
                    <button
                      key={item.path}
                      type="button"
                      className={`nav-item${active ? ' active' : ''}`}
                      onClick={() => navigate(item.path)}
                    >
                      <span className="nav-label">{item.label}</span>
                      <span className="nav-hint">{item.hint}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          <div className="sidebar-foot">
            <div className="mono dim small">网关 · /gw/v1/tools</div>
            <div className="mono dim small">API · /api/**</div>
          </div>
        </nav>

        <main className="content">{renderPage()}</main>
      </div>

      <ChangePasswordDialog
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        onChanged={clearSession}
      />
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
