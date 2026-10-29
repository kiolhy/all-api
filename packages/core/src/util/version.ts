import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from './paths.ts';

/**
 * 版本号唯一来源：根 `package.json`。
 *
 * 以前 app.ts 里硬编码 `'0.2.0'`、package.json 写 `0.1.0`，
 * 两处对不上 —— 在线更新要显示当前版本，不能有第二个真相。
 */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
