#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { isAkariError, messageOf, redact } from '@akari/core';
import { VERSION, COMMIT } from './version.js';
import { ExitError, EXIT } from './exit.js';
import { setColor, errorLine, hintLine, out, c } from './term.js';
import { modelsCommand } from './commands/models.js';
import { chatCommand } from './commands/chat.js';
import { doctorCommand } from './commands/doctor.js';
import {
  configList,
  configGet,
  configSet,
  endpointsList,
  endpointsAdd,
  endpointsRemove,
  endpointsUse,
  endpointsProbe,
} from './commands/config.js';
import { runCommand } from './commands/run.js';
import { runsCommand, diffCommand, undoCommand } from './commands/runs.js';

/**
 * akari CLI。仕様: docs/spec/10-cli.md
 * デスクトップと同じ @akari/core を使い、同じ設定・同じ接続先を共有する。
 */

const program = new Command();

program
  .name('akari')
  .description('ローカルLLM用のCLI。デスクトップ版と設定を共有します。')
  .version(`${VERSION} (${COMMIT})`, '-v, --version', 'バージョンを表示')
  .option('-e, --endpoint <名前|ID>', '使う接続先')
  .option('-m, --model <名前>', '使うモデル')
  .option('--json', '1行1JSONで出力する（人向けの装飾を出さない）')
  .option('-q, --quiet', '最終的な出力だけを出す')
  .option('--no-color', '色を使わない')
  .option('--verbose', 'ログ水準を debug にする')
  .helpOption('-h, --help', 'ヘルプを表示')
  .addHelpText(
    'after',
    `
例:
  akari config endpoints add --name "ローカル" --url http://localhost:11434/v1
  akari doctor                        接続と設定の状態を見る
  akari chat                          対話する（ファイルは触らない）
  akari run "テストを通して"           エージェント実行（作業フォルダの中だけ）
  akari diff                          直前の実行が何を変えたか
  akari undo                          直前の実行を元に戻す
  echo "要約して" | akari chat         標準入力から

まだ実装されていないもの: recall / digest / serve / mcp / index / web（docs/spec/11-roadmap.md の P2〜P6）
`,
  );

program
  .command('run [プロンプト...]')
  .description('エージェント実行。作業フォルダの中でファイルを読み書きし、コマンドを実行する')
  .option('-C, --cwd <dir>', '作業フォルダ。既定はカレント')
  .option('-p, --prompt <文>', 'プロンプト。省略時は引数か標準入力から')
  .option('--permission <mode>', 'ask / auto-edit / full')
  .option('-y, --yes', '--permission auto-edit と同じ')
  .option('--max-steps <n>', 'ステップ上限')
  .option('--no-tools', 'ツールを渡さない（純粋な生成）')
  .option('--read-only', '読み取り系のツールだけを渡す')
  .action(async (args: string[] | undefined, o) =>
    run(() => runCommand(args ?? [], { ...globals(), ...o, noTools: o.tools === false })),
  );

program
  .command('runs')
  .description('過去の実行の一覧')
  .option('--limit <n>', '表示件数。既定20')
  .action(async (o) => run(() => runsCommand({ ...globals(), ...o })));

program
  .command('diff')
  .description('実行が行ったファイル変更を差分で見る')
  .option('--run <ID>', '対象の実行。既定は直近でファイルを変更したもの')
  .option('--path <相対パス>', '1ファイルだけ')
  .action(async (o) => run(() => diffCommand({ ...globals(), ...o })));

program
  .command('undo')
  .description('実行が行ったファイル変更を元に戻す')
  .option('--run <ID>', '対象の実行。既定は直近でファイルを変更したもの')
  .option('-y, --yes', '確認しない')
  .action(async (o) => run(() => undoCommand({ ...globals(), ...o })));

program
  .command('models')
  .description('接続先のモデル一覧を出す')
  .action(async () => run(() => modelsCommand(globals())));

program
  .command('chat')
  .description('ツールなしの対話。ファイルは触りません')
  .option('-p, --prompt <文>', 'この文を1回だけ送って終わる')
  .option('-s, --system <文>', 'システムプロンプト')
  .option('-t, --temperature <数値>', '0.0〜2.0')
  .option('--max-tokens <整数>', '生成の上限トークン数')
  .action(async (o) => run(() => chatCommand({ ...globals(), ...o })));

program
  .command('doctor')
  .description('接続先・設定・保存データの状態を出す')
  .option('--export <パス>', '診断を書き出す（鍵と会話本文は含みません）')
  .option('--no-probe', '接続先へ問い合わせず、設定だけを出す')
  .action(async (o) =>
    run(() => doctorCommand({ ...globals(), export: o.export, noProbe: o.probe === false })),
  );

const config = program.command('config').description('設定の確認と変更');

config
  .command('list')
  .description('現在の設定を出す（鍵の値は出ません）')
  .action(async () => run(() => configList(globals())));
config
  .command('get <項目>')
  .description('例: akari config get agent.maxSteps')
  .action(async (p) => run(() => configGet(p, globals())));
config
  .command('set <項目> <値>')
  .description('例: akari config set agent.maxSteps 40')
  .action(async (p, v) => run(() => configSet(p, v, globals())));

const endpoints = config.command('endpoints').description('接続先の操作');
endpoints
  .command('list')
  .description('接続先の一覧')
  .action(async () => run(() => endpointsList(globals())));
endpoints
  .command('add')
  .description('接続先を追加する')
  .requiredOption('--name <名前>', '表示名')
  .requiredOption('--url <ベースURL>', '例: http://localhost:11434/v1')
  .option('--model <名前>', '既定のモデル')
  .option('--key <値>', 'APIキー（credentials.json に平文で保存されます）')
  .option('--key-env <変数名>', 'APIキーを環境変数から読む（外部APIではこちらを推奨）')
  .option('--timeout <秒>', '最初の応答までの待ち上限（既定120）')
  .action(async (o) => run(() => endpointsAdd({ ...globals(), ...o })));
endpoints
  .command('rm <名前|ID>')
  .description('接続先を削除する')
  .action(async (n) => run(() => endpointsRemove(n, globals())));
endpoints
  .command('use <名前|ID>')
  .description('使う接続先を切り替える')
  .action(async (n) => run(() => endpointsUse(n, globals())));
endpoints
  .command('probe [名前|ID]')
  .description('対応機能を判定して保存する')
  .option(
    '--context <トークン数>',
    'そのモデルの文脈長を手で設定する（対象モデルが決まっていること）',
  )
  .action(async (n, o) => run(() => endpointsProbe(n, { ...globals(), ...o })));

// まだ無い機能。あるように見せない。
for (const [name, desc, when] of [
  ['recall', '生の記録の検索', 'P2'],
  ['digest', '文脈の圧縮版の表示', 'P2'],
  ['serve', 'ハーネスAPI', 'P3'],
  ['mcp', 'MCP の登録と公開', 'P4'],
  ['index', 'ベクトル索引', 'P5'],
  ['web', 'Web検索と取得', 'P6'],
] as const) {
  program
    .command(name, { hidden: true })
    .description(`${desc}（未実装）`)
    .allowUnknownOption()
    .action(() => {
      errorLine(`${name} はまだ実装されていません。`);
      hintLine(`${desc} は docs/spec/11-roadmap.md の ${when} で入ります。`);
      process.exitCode = EXIT.usage;
    });
}

function globals() {
  const o = program.opts();
  return {
    endpoint: o.endpoint as string | undefined,
    model: o.model as string | undefined,
    json: o.json === true,
    quiet: o.quiet === true,
    verbose: o.verbose === true,
  };
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ExitError) {
      if (!err.silent) {
        errorLine(err.message, err.detail);
        if (err.hint) hintLine(err.hint);
      }
      process.exitCode = err.code;
      return;
    }
    if (isAkariError(err)) {
      errorLine(err.message, err.detail);
      if (err.hint) hintLine(err.hint);
      process.exitCode = EXIT.runtime;
      return;
    }
    if ((err as Error)?.name === 'AbortError') {
      process.exitCode = EXIT.interrupted;
      return;
    }
    errorLine(messageOf(err));
    // スタックにも鍵が混ざりうるので、伏字化を通してから出す。
    if (process.env.AKARI_DEBUG)
      process.stderr.write(redact(String((err as Error)?.stack ?? '')) + '\n');
    else hintLine('詳しい内容は AKARI_DEBUG=1 を付けて再実行すると出ます。');
    process.exitCode = EXIT.runtime;
  }
}

async function main(): Promise<void> {
  let argv = process.argv;
  if (argv.includes('--no-color') || process.env.NO_COLOR) setColor(false);

  // 引数なしは、まだ何ができるかを示す。エージェント実行があるように見せない。
  // サブコマンド名でない文字列が最初に来たら run とみなす（akari "テストを通して"）。
  const known = new Set(program.commands.map((cmd) => cmd.name()));
  const first = argv[2];
  if (first !== undefined && !first.startsWith('-') && !known.has(first)) {
    argv = [...argv.slice(0, 2), 'run', ...argv.slice(2)];
  }

  if (argv.length <= 2) {
    out(c.bold(`Akari CLI ${VERSION}`));
    out('');
    program.outputHelp();
    return;
  }

  // commander に process.exit させない。終了コードは仕様（docs/spec/10-cli.md）で決めている。
  program.exitOverride();
  for (const cmd of program.commands) cmd.exitOverride();

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode === 0 ? EXIT.ok : EXIT.usage;
      return;
    }
    throw err;
  }
}

// パイプの先（head など）が先に閉じても落ちないようにする。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(EXIT.ok);
    throw err;
  });
}

process.on('SIGINT', () => {
  process.stderr.write('\n中断しました。\n');
  process.exit(EXIT.interrupted);
});

await main();
