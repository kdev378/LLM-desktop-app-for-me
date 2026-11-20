import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, ToolCallBuffer } from '../dist/index.js';

test('SSE: 1イベントを取り出す', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: hello\n\n'), [{ data: 'hello' }]);
});

test('SSE: チャンク境界がイベントの途中に来ても壊れない', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: he'), []);
  assert.deepEqual(p.push('llo\n'), []);
  assert.deepEqual(p.push('\n'), [{ data: 'hello' }]);
});

test('SSE: \\r\\n 改行を扱える', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: a\r\n\r\ndata: b\r\n\r\n'), [{ data: 'a' }, { data: 'b' }]);
});

test('SSE: コメント行を無視する', () => {
  const p = new SseParser();
  assert.deepEqual(p.push(': keep-alive\ndata: x\n\n'), [{ data: 'x' }]);
});

test('SSE: data が複数行なら改行で連結する', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: one\ndata: two\n\n'), [{ data: 'one\ntwo' }]);
});

test('SSE: 値の先頭スペースは1つだけ落とす', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data:  x\n\n'), [{ data: ' x' }]);
});

test('SSE: 末尾に空行が無いイベントを flush で拾う', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: last\n'), []);
  assert.deepEqual(p.flush(), [{ data: 'last' }]);
});

test('ToolCallBuffer: 断片の arguments を index ごとに連結する', () => {
  const b = new ToolCallBuffer();
  b.add({ index: 0, id: 'c1', function: { name: 'read_', arguments: '{"pa' } });
  b.add({ index: 0, function: { name: 'file', arguments: 'th":"a.ts"}' } });
  b.add({ index: 1, id: 'c2', function: { name: 'glob', arguments: '{}' } });
  assert.deepEqual(b.finish(), [
    { index: 0, id: 'c1', name: 'read_file', argumentsRaw: '{"path":"a.ts"}' },
    { index: 1, id: 'c2', name: 'glob', argumentsRaw: '{}' },
  ]);
});

test('ToolCallBuffer: id を返さないサーバには連番を振る', () => {
  const b = new ToolCallBuffer();
  b.add({ index: 0, function: { name: 'x', arguments: '{}' } });
  assert.equal(b.finish()[0].id, 'call_0');
});
