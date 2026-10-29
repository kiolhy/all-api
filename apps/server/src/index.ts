import { buildApp } from './app.ts';
import {
  getDb,
  loadConfig,
  closeDb,
  seedAdminAccount,
  sessions,
  dbPath,
  masterKeyPath,
} from '@aah/core';
import { recoverInterruptedJobs } from './import-runner.ts';

const cfg = loadConfig();
const app = buildApp();

// 先把数据文件位置打出来：换了目录启动会开出一个全新的空库，
// 不打日志的话看起来就像「数据丢了」。
app.log.info(`数据库: ${dbPath()}`);
app.log.info(`主密钥: ${masterKeyPath()}`);

getDb();
sessions.purgeExpired();

// 上次异常退出可能留下 running 状态的导入任务，标成中断，避免前端一直转圈
recoverInterruptedJobs();

const seed = seedAdminAccount();

try {
  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info(`接口资产中枢已启动 http://${cfg.host}:${cfg.port}`);
  if (seed.created) {
    app.log.warn(
      seed.usedDefaultPassword
        ? `已创建管理员账号 ${seed.username}，初始密码 admin123456 —— 请登录后立刻修改`
        : `已创建管理员账号 ${seed.username}（密码来自 ADMIN_PASSWORD）`,
    );
  }
  if (!cfg.llm.enabled) app.log.warn('LLM 未启用：一键整理将只做规则解析（设置 LLM_ENABLED=true 与 LLM_API_KEY）');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info('正在关闭…');
    await app.close();
    closeDb();
    process.exit(0);
  });
}
