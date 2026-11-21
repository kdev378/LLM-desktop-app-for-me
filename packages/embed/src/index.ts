/**
 * @akari/embed の軽い面（モデルの素性・係との取り決め）。モデルを動かす部品は '@akari/embed/engine'
 * （onnxruntime を読み込むので、要るときだけ読み込む）。仕様: docs/spec/14-memory.md
 */
export * from './model.js';
export * from './protocol.js';
