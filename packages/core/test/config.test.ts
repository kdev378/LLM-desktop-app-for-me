import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  loadConfig,
  saveConfig,
  defaultConfig,
  addEndpoint,
  removeEndpoint,
  findEndpoint,
  isExternalUrl,
  loadCredentials,
  saveCredentials,
  resolveKey,
  readJson,
} from '../dist/index.js';

async function tmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'akari-test-'));
}

test('設定が無ければ既定で始まり、問題は報告されない', async () => {
  const home = await tmpHome();
  const { config, problems, readOnly } = await loadConfig(home);
  assert.equal(problems.length, 0);
  assert.equal(readOnly, false);
  assert.equal(config.agent.permissionMode, 'ask');
  assert.equal(config.agent.maxSteps, 25);
  assert.deepEqual(config.endpoints, []);
});

test('保存した設定を読み直せる。末尾スラッシュは除去される', async () => {
  const home = await tmpHome();
  const { config } = addEndpoint(defaultConfig(), {
    name: 'ローカル',
    baseUrl: 'http://localhost:11434/v1/',
  });
  await saveConfig(config, home);
  const { config: back } = await loadConfig(home);
  assert.equal(back.endpoints.length, 1);
  assert.equal(back.endpoints[0].baseUrl, 'http://localhost:11434/v1');
  assert.equal(back.activeEndpointId, back.endpoints[0].id);
});

test('壊れたJSONは退避され、既定で起動し、退避先が報告される', async () => {
  const home = await tmpHome();
  await fs.writeFile(path.join(home, 'config.json'), '{ これはJSONではない');
  const { config, problems } = await loadConfig(home);
  assert.equal(config.agent.maxSteps, 25);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'recovered');
  const files = await fs.readdir(home);
  assert.ok(
    files.some((f) => f.startsWith('config.broken-')),
    '退避ファイルが残っているはず',
  );
});

test('未知の未来バージョンは読み取り専用になる', async () => {
  const home = await tmpHome();
  await fs.writeFile(
    path.join(home, 'config.json'),
    JSON.stringify({ schemaVersion: 99, endpoints: [] }),
  );
  const { readOnly, problems } = await loadConfig(home);
  assert.equal(readOnly, true);
  assert.equal(problems[0].kind, 'future-version');
});

test('不正な値を黙って既定へ差し替えず、何が不正かを報告する', async () => {
  const home = await tmpHome();
  await fs.writeFile(
    path.join(home, 'config.json'),
    JSON.stringify({ schemaVersion: 1, agent: { maxSteps: 9999 } }),
  );
  const { problems } = await loadConfig(home);
  assert.equal(problems[0].kind, 'invalid');
  assert.match(problems[0].detail ?? '', /maxSteps/);
});

test('有効範囲を外れた設定は保存を拒否する', async () => {
  const home = await tmpHome();
  const bad = { ...defaultConfig(), generation: { temperature: 99, topP: 1, maxTokens: null } };
  await assert.rejects(() => saveConfig(bad as never, home), /有効な範囲/);
});

test('URLでないベースURLは接続先として受け付けない', () => {
  assert.throws(() => addEndpoint(defaultConfig(), { name: 'x', baseUrl: 'ollama:11434' }), /不正/);
});

test('同じ名前の接続先は追加できない', () => {
  const { config } = addEndpoint(defaultConfig(), {
    name: 'ローカル',
    baseUrl: 'http://localhost:1/v1',
  });
  assert.throws(
    () => addEndpoint(config, { name: 'ローカル', baseUrl: 'http://localhost:2/v1' }),
    /既にあります/,
  );
});

test('選択中の接続先を消すと、残りの先頭が選ばれる', () => {
  let c = addEndpoint(defaultConfig(), { name: 'a', baseUrl: 'http://localhost:1/v1' }).config;
  c = addEndpoint(c, { name: 'b', baseUrl: 'http://localhost:2/v1' }).config;
  assert.equal(c.activeEndpointId, c.endpoints[0].id);
  const after = removeEndpoint(c, 'a');
  assert.equal(after.endpoints.length, 1);
  assert.equal(after.activeEndpointId, after.endpoints[0].id);
});

test('名前でもIDでも接続先を引ける', () => {
  const { config, endpoint } = addEndpoint(defaultConfig(), {
    name: 'ローカル',
    baseUrl: 'http://localhost:1/v1',
  });
  assert.equal(findEndpoint(config, 'ローカル')?.id, endpoint.id);
  assert.equal(findEndpoint(config, endpoint.id)?.id, endpoint.id);
  assert.equal(findEndpoint(config, '無い名前'), null);
});

test('存在しない接続先を指していたら報告して選び直す', async () => {
  const home = await tmpHome();
  const { config } = addEndpoint(defaultConfig(), { name: 'a', baseUrl: 'http://localhost:1/v1' });
  await saveConfig({ ...config, activeEndpointId: 'ep_missing' }, home);
  const loaded = await loadConfig(home);
  assert.equal(loaded.problems[0].kind, 'invalid');
  assert.equal(loaded.config.activeEndpointId, loaded.config.endpoints[0].id);
});

test('localhost は外部と判定しない', () => {
  assert.equal(isExternalUrl('http://localhost:11434/v1'), false);
  assert.equal(isExternalUrl('http://127.0.0.1:8080/v1'), false);
  assert.equal(isExternalUrl('http://mybox.local:8000/v1'), false);
  assert.equal(isExternalUrl('https://api.openai.com/v1'), true);
});

test('鍵はパーミッション600で保存される', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX のみ');
  const home = await tmpHome();
  await saveCredentials({ schemaVersion: 1, keys: { ep_x: 'sk-abcdefghijklmnop' } }, home);
  const st = await fs.stat(path.join(home, 'credentials.json'));
  assert.equal(st.mode & 0o777, 0o600);
});

test('env: 参照は環境変数から解決し、未設定なら黙って鍵なしにしない', () => {
  const creds = { schemaVersion: 1 as const, keys: {} };
  process.env.AKARI_TEST_KEY = 'sk-fromenv1234567890';
  assert.deepEqual(resolveKey('env:AKARI_TEST_KEY', creds), {
    kind: 'value',
    value: 'sk-fromenv1234567890',
    source: 'env',
    ref: 'env:AKARI_TEST_KEY',
  });
  delete process.env.AKARI_TEST_KEY;
  assert.deepEqual(resolveKey('env:AKARI_TEST_KEY', creds), {
    kind: 'missing-env',
    ref: 'env:AKARI_TEST_KEY',
    varName: 'AKARI_TEST_KEY',
  });
});

test('パーミッションが緩い credentials.json は警告される', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX のみ');
  const home = await tmpHome();
  await saveCredentials({ schemaVersion: 1, keys: { a: 'sk-abcdefghijklmnop' } }, home);
  await fs.chmod(path.join(home, 'credentials.json'), 0o644);
  const { permissionWarning } = await loadCredentials(home);
  assert.match(permissionWarning ?? '', /パーミッション/);
});

test('原子的書き込みで一時ファイルが残らない', async () => {
  const home = await tmpHome();
  await saveConfig(defaultConfig(), home);
  assert.deepEqual(await fs.readdir(home), ['config.json']);
  assert.equal((await readJson(path.join(home, 'config.json'))).status, 'ok');
});
