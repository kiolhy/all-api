import type { EndpointInput, HttpMethod } from '../schema/asset.ts';

export type RequestSpec = {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  /** 原始请求体（未解析） */
  bodyRaw?: string | null;
  bodyContentType?: string | null;
  source: string;
};

export type PendingSecret = { name: string; value: string; hint: string };

/** 归一化后的候选接口 + 所属平台信息 */
export type NormalizedDraft = {
  platformSlug: string;
  platformBaseUrl: string;
  platformName: string;
  endpoint: EndpointInput;
  secrets: PendingSecret[];
};
