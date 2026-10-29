import { isAbsolute, resolve } from 'node:path';

/**
 * 项目根目录。
 *
 * 本文件在 `packages/core/src/util/paths.ts`，往上四层就是仓库根。
 * 用它当基准，是为了让数据文件的位置**不跟着 process.cwd() 走** ——
 * 否则换个目录启动，就会在那边生成一个全新的空库，看起来像「数据全丢了」。
 */
export const PROJECT_ROOT = resolve(import.meta.dirname, '../../../..');

/** 前端构建产物目录。同样锚在项目根，不然换个目录启动就找不到前端包。 */
export const WEB_DIST = resolve(PROJECT_ROOT, 'apps/web/dist');

/**
 * 把配置里的路径解析成绝对路径。
 *
 * - `:memory:` 原样返回（测试用）
 * - 绝对路径原样返回
 * - 相对路径锚在项目根，而不是 cwd
 */
export function resolveDataPath(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim() || fallback;
  if (value === ':memory:') return value;
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value);
}
