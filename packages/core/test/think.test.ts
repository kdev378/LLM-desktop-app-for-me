import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkSplitter } from '../dist/index.js';

/**
 * 本文に混ざる思考ブロックの切り分け。
 * Qwen3 系のように <think>…</think> を本文へ入れるモデル向け。
 * 仕様: docs/spec/02-provider.md
 */

/** チャンクに割って流し、まとめた結果を返す。 */
function feed(text: string, chunkSize: number) {
  const s = new ThinkSplitter();
  let body = '';
  let reasoning = '';
  for (let i = 0; i < text.length; i += chunkSize) {
    const r = s.push(text.slice(i, i + chunkSize));
    body += r.text;
    reasoning += r.reasoning;
  }
  const tail = s.flush();
  return {
    body: body + tail.text,
    reasoning: reasoning + tail.reasoning,
    unterminated: s.unterminated,
  };
}

test('think ブロックを本文から外す', () => {
  const r = feed('<think>まず考える</think>答えは2です。', 1000);
  assert.equal(r.body, '答えは2です。');
  assert.equal(r.reasoning, 'まず考える');
});

test('タグが何文字で割れても壊れない', () => {
  const input = '前置き<think>思考の中身</think>本題です。';
  for (const size of [1, 2, 3, 5, 7, 11, 100]) {
    const r = feed(input, size);
    assert.equal(r.body, '前置き本題です。', `chunk=${size}`);
    assert.equal(r.reasoning, '思考の中身', `chunk=${size}`);
  }
});

test('複数の think ブロックをすべて外す', () => {
  const r = feed('a<think>1</think>b<think>2</think>c', 3);
  assert.equal(r.body, 'abc');
  assert.equal(r.reasoning, '12');
});

test('<thinking> 表記も扱う', () => {
  const r = feed('<thinking>考え</thinking>答え', 4);
  assert.equal(r.body, '答え');
  assert.equal(r.reasoning, '考え');
});

test('think が無ければ本文はそのまま', () => {
  const r = feed('ふつうの答えです。', 2);
  assert.equal(r.body, 'ふつうの答えです。');
  assert.equal(r.reasoning, '');
});

test('閉じタグが来ないまま終わったら、本文へ混ぜず思考として扱う', () => {
  const r = feed('答える前に<think>途中で切れた', 4);
  assert.equal(r.body, '答える前に');
  assert.equal(r.reasoning, '途中で切れた');
  assert.equal(r.unterminated, true);
});

test('思考の中の akari-tool ブロックを本文へ漏らさない', () => {
  // 代替方式のとき、思考の中の下書きをツール呼び出しとして拾わないことが要件
  const input = [
    '<think>',
    '```akari-tool',
    '{"name":"delete_file","arguments":{"path":"important.ts"}}',
    '```',
    'いや、消すのはやめよう',
    '</think>',
    'ファイルは消しませんでした。',
  ].join('\n');
  const r = feed(input, 5);
  assert.ok(!r.body.includes('akari-tool'), '本文に漏れないこと');
  assert.ok(!r.body.includes('delete_file'));
  assert.match(r.body, /ファイルは消しませんでした。/);
  assert.match(r.reasoning, /delete_file/);
});

test('タグに似た文字列は誤検出しない', () => {
  const r = feed('<thin>これはタグではない</thin>', 3);
  assert.equal(r.body, '<thin>これはタグではない</thin>');
  assert.equal(r.reasoning, '');
});

test('タグが無ければ1文字も保留しない（ストリームを塊にしない）', () => {
  // 常に末尾を保留すると、普通の応答でも表示が遅れて塊になる。
  const s = new ThinkSplitter();
  assert.deepEqual(s.push('こん'), { text: 'こん', reasoning: '' });
  assert.deepEqual(s.push('にちは'), { text: 'にちは', reasoning: '' });
  assert.deepEqual(s.flush(), { text: '', reasoning: '' });
});

test('タグの前半に見える末尾だけを保留する', () => {
  const s = new ThinkSplitter();
  // '<' はタグの始まりかもしれないので保留する
  assert.deepEqual(s.push('答えは<'), { text: '答えは', reasoning: '' });
  // タグではなかったと分かった時点で流す
  assert.deepEqual(s.push('2です'), { text: '<2です', reasoning: '' });
});

test('保留した末尾は次のチャンクで正しく判定される', () => {
  const s = new ThinkSplitter();
  assert.deepEqual(s.push('本文<thi'), { text: '本文', reasoning: '' });
  const r = s.push('nk>考え</think>続き');
  assert.equal(r.reasoning, '考え');
  assert.equal(r.text, '続き');
});
