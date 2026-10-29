import { settings } from './db/repos.ts';

export type LlmConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  concurrency: number;
};

export type AppConfig = {
  port: number;
  host: string;
  adminToken: string;
  allowPrivateEgress: boolean;
  egressTimeoutMs: number;
  egressMaxBytes: number;
  llm: LlmConfig;
};

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** 环境变量为底，数据库设置覆盖（控制台里改的优先） */
export function loadConfig(): AppConfig {
  const dbLlm = settings.get<Partial<LlmConfig>>('llm', {});
  const envLlm: LlmConfig = {
    enabled: process.env.LLM_ENABLED === 'true',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 60000),
    concurrency: num(process.env.LLM_CONCURRENCY, 4),
  };
  const llm: LlmConfig = { ...envLlm, ...dbLlm };
  return {
    port: num(process.env.PORT, 8778),
    host: process.env.HOST ?? '127.0.0.1',
    adminToken: process.env.ADMIN_TOKEN ?? 'change-me-admin-token',
    allowPrivateEgress: process.env.ALLOW_PRIVATE_EGRESS === 'true',
    egressTimeoutMs: num(process.env.EGRESS_TIMEOUT_MS, 15000),
    egressMaxBytes: num(process.env.EGRESS_MAX_BYTES, 2 * 1024 * 1024),
    llm: {
      ...llm,
      enabled: llm.enabled && Boolean(llm.apiKey),
    },
  };
}
