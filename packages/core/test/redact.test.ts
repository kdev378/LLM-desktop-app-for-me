import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactDeep, registerSecret, forgetSecrets } from '../dist/index.js';

test('sk- 形式の鍵を伏せる', () => {
  assert.equal(redact('key is sk-abcdefghij1234567890 here'), 'key is *** here');
});

test('Authorization ヘッダの中身を伏せる', () => {
  assert.equal(redact('authorization: Bearer abcdefghij1234567890'), 'authorization: ***');
});

test('登録した秘密値を伏せる', () => {
  forgetSecrets();
  registerSecret('my-local-secret-value');
  assert.equal(redact('x my-local-secret-value y'), 'x *** y');
  forgetSecrets();
  assert.equal(redact('x my-local-secret-value y'), 'x my-local-secret-value y');
});

test('短すぎる値は登録しない（本文を壊さないため）', () => {
  forgetSecrets();
  registerSecret('abc');
  assert.equal(redact('abc def'), 'abc def');
});

test('鍵らしい名前の項目は値を見ずに落とす', () => {
  assert.deepEqual(
    redactDeep({
      authorization: 'Bearer x',
      apiKey: 'anything',
      nested: { password: 'p', ok: 'plain' },
    }),
    { authorization: '***', apiKey: '***', nested: { password: '***', ok: 'plain' } },
  );
});

test('配列の中の文字列も伏せる', () => {
  assert.deepEqual(redactDeep(['sk-abcdefghij1234567890', 'plain']), ['***', 'plain']);
});
