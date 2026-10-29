import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { PROJECT_ROOT, resolveDataPath } from '../src/util/paths.ts';

/**
 * 数据文件路径解析。
 *
 * 背景：`.env` 里写的是 `DB_PATH=./data/hub.db`，以前直接 `resolve()` ——
 * 跟着 process.cwd() 走。换个目录启动就会在那边开出一个全新的空库，
 * 看起来就像「每次重启数据都丢了」。主密钥同理，而且更糟：
 * 新密钥会让之前加密的密钥全部解不开。
 *
 * 现在相对路径锚在项目根，与 cwd 无关。
 */

test('项目根指向仓库目录', () => {
  assert.ok(isAbsolute(PROJECT_ROOT));
  // packages/core/src/util/paths.ts 往上四层
  assert.ok(/各个平台接口$/.test(PROJECT_ROOT), PROJECT_ROOT);
});

test('相对路径锚在项目根，不是 cwd', () => {
  const before = process.cwd();
  const fromHere = resolveDataPath('./data/hub.db', './data/hub.db');
  try {
    process.chdir(PROJECT_ROOT === 'C:\\' ? 'C:\\' : '/');
    const fromElsewhere = resolveDataPath('./data/hub.db', './data/hub.db');
    assert.equal(fromElsewhere, fromHere);
  } finally {
    process.chdir(before);
  }
  assert.ok(fromHere.startsWith(PROJECT_ROOT), fromHere);
});

test('相对路径解析结果与 cwd 无关（不 chdir 版本）', () => {
  const a = resolveDataPath('data/hub.db', './data/hub.db');
  const b = resolveDataPath('./data/hub.db', './data/hub.db');
  assert.equal(a, b);
  assert.ok(a.startsWith(PROJECT_ROOT));
});

test('绝对路径原样保留', () => {
  const abs = process.platform === 'win32' ? 'D:/custom/hub.db' : '/tmp/hub.db';
  assert.equal(resolveDataPath(abs, './data/hub.db'), abs);
});

test(':memory: 原样返回（测试库）', () => {
  assert.equal(resolveDataPath(':memory:', './data/hub.db'), ':memory:');
});

test('空值回退到默认值', () => {
  const def = resolveDataPath(undefined, './data/hub.db');
  assert.equal(resolveDataPath('', './data/hub.db'), def);
  assert.equal(resolveDataPath('   ', './data/hub.db'), def);
  assert.ok(def.endsWith('hub.db'));
});

test('主密钥和数据库走同一套规则', () => {
  const db = resolveDataPath('./data/hub.db', './data/hub.db');
  const key = resolveDataPath('./data/master.key', './data/master.key');
  // 同一个目录下，换成目录启动时两个都会跟着变 —— 锚定后都不会
  assert.equal(db.replace(/[^\\/]+$/, ''), key.replace(/[^\\/]+$/, ''));
  assert.ok(key.startsWith(PROJECT_ROOT));
  assert.notEqual(db, key);
});
