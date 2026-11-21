#!/usr/bin/env node
import { runHelper } from './helper.js';

/**
 * 埋め込みの係の入口。Akari（@akari/core の BuiltinEmbedder）が、要るときに裏で起こす。
 *   node helper-main.js --root <データの置き場> --model <ID> --idle-ms <ミリ秒> [--runtime auto|node|wasm]
 */
const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const root = arg('--root');
if (!root) {
  process.stderr.write('--root が要ります\n');
  process.exit(2);
}
const runtime = arg('--runtime', 'auto') as 'auto' | 'node' | 'wasm';
try {
  await runHelper({
    dataRoot: root,
    modelId: arg('--model', 'ruri-v3-70m')!,
    idleMs: Number(arg('--idle-ms', '600000')),
    runtime,
  });
  process.exit(0);
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}
