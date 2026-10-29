import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDataPath } from '../util/paths.ts';
import { migrations } from './migrations.ts';

let dbInstance: DatabaseSync | null = null;

export function dbPath(): string {
  return resolveDataPath(process.env.DB_PATH, './data/hub.db');
}

/** 备份目录：跟库文件放一起 */
function backupDir(path: string): string {
  return join(dirname(path), 'backups');
}

/**
 * 启动时备份一次。
 *
 * 单机自用没有别的兜底 —— 迁移写坏了、手滑删了，都只能靠这个。
 *
 * 关键：WAL 模式下数据可能还没落进 `hub.db`（主库也许只有 4KB）。
 * 所以必须先 checkpoint 把 WAL 合进去，再拷 —— 否则备份出来的是个空库。
 */
function backupOnStart(path: string): string | null {
  if (!existsSync(path)) return null;
  if (statSync(path).size < 4096) return null;

  const dir = backupDir(path);
  mkdirSync(dir, { recursive: true });

  /** 已经有一份像样的备份就别重复，避免反复重启刷文件 */
  const recentEnough = readdirSync(dir).some((name) => {
    const st = statSync(join(dir, name));
    return st.size >= 8192 && Date.now() - st.mtimeMs < 60 * 60 * 1000;
  });
  if (recentEnough) return null;

  // 先把 WAL 合进主库
  let welded = true;
  try {
    const tmp = new DatabaseSync(path);
    tmp.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    tmp.close();
  } catch {
    welded = false;
  }

  const stamp = new Date()
    .toLocaleString('sv-SE')
    .replace(/[: ]/g, '-')
    .slice(0, 19);
  const target = join(dir, `hub-${stamp}.db`);
  copyFileSync(path, target);

  // 合并不了就把 WAL 一起拷，还原时三个文件放回去才能用
  if (!welded && existsSync(`${path}-wal`)) {
    copyFileSync(`${path}-wal`, `${target}-wal`);
  }

  // 只留最近 10 份
  const all = readdirSync(dir)
    .filter((n) => n.startsWith('hub-') && n.endsWith('.db'))
    .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of all.slice(10)) {
    try {
      unlinkSync(join(dir, old.n));
      if (existsSync(join(dir, `${old.n}-wal`))) unlinkSync(join(dir, `${old.n}-wal`));
    } catch {
      /* 删不掉就算了 */
    }
  }
  return target;
}

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;
  const path = dbPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  // 备份必须在打开之前做：打开后可能自动回放 WAL，原文件就被改了
  if (path !== ':memory:') backupOnStart(path);

  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  runMigrations(db);
  // 把上次异常退出留在 WAL 里的内容合进主库，之后 hub.db 才是自包含的
  if (path !== ':memory:') checkpoint(db);
  dbInstance = db;
  return db;
}

/**
 * 把 WAL 合回主库。
 *
 * WAL 模式下数据先写进 `-wal`，主库文件可能只有 4KB。只拷 `hub.db` 去备份
 * 会得到一个空库 —— 所以退出前一定要 checkpoint。
 */
function checkpoint(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    /* 有别的连接在用时会失败，下次再合 */
  }
}

export function closeDb(): void {
  if (!dbInstance) return;
  try {
    checkpoint(dbInstance);
    dbInstance.close();
  } finally {
    dbInstance = null;
  }
}

/** 测试用：切到内存库并重建 */
export function resetDbForTests(): DatabaseSync {
  closeDb();
  dbInstance = null;
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  dbInstance = db;
  return db;
}

function runMigrations(db: DatabaseSync): void {
  db.exec(
    `create table if not exists _migrations (version integer primary key, name text not null, applied_at text not null);`,
  );
  const applied = new Set(
    (db.prepare('select version from _migrations').all() as Array<{ version: number }>).map((r) =>
      Number(r.version),
    ),
  );
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('insert into _migrations (version, name, applied_at) values (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** node:sqlite 不接受 boolean / undefined */
export function b(v: boolean | undefined | null): number {
  return v ? 1 : 0;
}
