#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { isAkariError, messageOf, redact, getProviderError } from '@akari/core';
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
  endpointsSet,
  endpointsRemove,
  endpointsUse,
  endpointsProbe,
} from './commands/config.js';
import { runCommand } from './commands/run.js';
import { runsCommand, diffCommand, undoCommand } from './commands/runs.js';
import {
  conversationsListCommand,
  conversationsShowCommand,
  conversationsRmCommand,
} from './commands/conversations.js';
import { digestCommand, recallCommand } from './commands/context.js';
import { isInteractive } from './term.js';

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
  akari run -c "READMEも直して"        この作業フォルダの直近の会話の続き
  akari conversations                 保存した会話の一覧
  akari diff                          直前の実行が何を変えたか
  akari undo                          直前の実行を元に戻す
  echo "要約して" | akari chat         標準入力から
  akari serve                         ハーネスAPI（外部のツールから HTTP で頼む）

まだ実装されていないもの: mcp / index / web（docs/spec/11-roadmap.md の P4〜P6）
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
  .option('--tools-mode <mode>', 'auto / native / prompted / both。判定を無視して渡し方を決める')
  .option('--timeout <秒>', 'この実行だけ、最初の応答までの待ち上限を変える')
  .option('--think <量>', 'auto / off / low / medium / high。思考（reasoning）の量')
  .option('-c, --continue', 'この作業フォルダの直近の会話の続きから')
  .option('--conversation <ID>', '指定した会話の続きから（前方一致でよい）')
  .option('--no-save', 'この実行のやり取りを保存しない')
  .action(async (args: string[] | undefined, o) =>
    run(() => runCommand(args ?? [], { ...globals(), ...o, noTools: o.tools === false })),
  );

// 引数なしの akari で入る対話画面（docs/spec/17-interactive.md）。名前で呼ぶものではないので隠す
program
  .command('interactive', { hidden: true })
  .description('対話画面')
  .option('-C, --cwd <dir>', '作業フォルダ。既定はカレント')
  .option('--permission <mode>', 'ask / auto-edit / full')
  .option('-y, --yes', '--permission auto-edit と同じ')
  .option('--max-steps <n>', 'ステップ上限')
  .option('--no-tools', 'ツールを渡さない')
  .option('--read-only', '読み取り系のツールだけを渡す')
  .option('--tools-mode <mode>', 'auto / native / prompted / both')
  .option('--timeout <秒>', '最初の応答までの待ち上限')
  .option('--think <量>', 'auto / off / low / medium / high')
  .option('-c, --continue', 'この作業フォルダの直近の会話の続きから')
  .option('--conversation <ID>', '指定した会話の続きから（前方一致でよい）')
  .option('--no-save', 'やり取りを保存しない')
  .action(async (o) =>
    run(async () => {
      const g = globals();
      if (g.json)
        throw new ExitError(EXIT.usage, '対話画面では --json を使えません。', {
          hint: 'akari run --json "…" を使ってください。',
        });
      if (!isInteractive()) {
        throw new ExitError(EXIT.usage, '対話できる端末ではありません。', {
          hint: 'akari run "…" のように渡すか、標準入力からパイプしてください。',
        });
      }
      const { interactiveCommand } = await import('./tui/index.js');
      await interactiveCommand({ ...g, ...o, noTools: o.tools === false });
    }),
  );

program
  .command('serve')
  .description(
    'ハーネスAPI。外部のツールから HTTP で実行を頼めるようにする（この PC の中からだけ）',
  )
  .option('--port <n>', '待ち受けるポート。既定は設定の server.port（7801）')
  .option('--workspace <dir>', '実行ごとに指定が無いときの作業フォルダ')
  .option('--print-token', 'トークンを標準出力へ出す')
  .action(async (o) =>
    run(async () => {
      const { serveCommand } = await import('./commands/serve.js');
      await serveCommand({ ...globals(), ...o });
    }),
  );

program
  .command('runs')
  .description('過去の実行の一覧')
  .option('--limit <n>', '表示件数。既定20')
  .action(async (o) => run(() => runsCommand({ ...globals(), ...o })));

const conversations = program
  .command('conversations')
  .description('保存した会話の一覧と操作')
  .option('--limit <n>', '表示件数。既定20')
  .action(async (o) => run(() => conversationsListCommand({ ...globals(), ...o })));
conversations
  .command('show <ID>')
  .description('会話の中身を表示する（ID は前方一致でよい）')
  .option('--reasoning', '思考の出力も表示する')
  .option('--full', '道具の結果を省略せずに表示する')
  .action(async (id, o) => run(() => conversationsShowCommand(id, { ...globals(), ...o })));
conversations
  .command('rm <ID>')
  .description('会話をゴミ箱へ移す（30日後に消える）')
  .option('-y, --yes', '確認しない')
  .action(async (id, o) => run(() => conversationsRmCommand(id, { ...globals(), ...o })));

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
  .option('--timeout <秒>', 'この実行だけ、最初の応答までの待ち上限を変える')
  .option('--think <量>', 'auto / off / low / medium / high。思考（reasoning）の量')
  .option('-c, --continue', '直近の chat の続きから')
  .option('--conversation <ID>', '指定した会話の続きから（前方一致でよい）')
  .option('--no-save', 'この対話を保存しない')
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
  .option('--timeout <秒>', '最初の応答までの待ち上限（既定300）')
  .action(async (o) => run(() => endpointsAdd({ ...globals(), ...o })));
endpoints
  .command('set [名前|ID]')
  .description('既にある接続先を書き換える（省略時は選択中のもの）')
  .option('--name <名前>', '表示名を変える')
  .option('--url <ベースURL>', 'ベースURLを変える')
  .option('--model <名前>', '既定のモデルを変える')
  .option('--key <値>', 'APIキー（credentials.json に平文で保存されます）')
  .option('--key-env <変数名>', 'APIキーを環境変数から読む')
  .option('--timeout <秒>', '最初の応答までの待ち上限')
  .action(async (n, o) => run(() => endpointsSet(n, { ...globals(), ...o })));
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

program
  .command('digest')
  .description('いまモデルが前提にしている圧縮版を、5分類で表示する')
  .option('-C, --cwd <dir>', 'この作業フォルダの直近の会話（既定はカレント）')
  .option('--conversation <ID>', '会話を指定する（前方一致でよい）')
  .action(async (o) => run(() => digestCommand({ ...globals(), ...o })));

program
  .command('recall [語句]')
  .description('会話の生の記録を検索する（圧縮された部分も含む）')
  .option('-C, --cwd <dir>', 'この作業フォルダの直近の会話（既定はカレント）')
  .option('--conversation <ID>', '会話を指定する（前方一致でよい）')
  .option('--read <ID>', 'そのメッセージの原文を読む')
  .option('--limit <n>', '表示件数。既定10')
  .action(async (q, o) => run(() => recallCommand(q, { ...globals(), ...o })));

const collect = (v: string, prev: string[]) => [...prev, v];
const mcp = program.command('mcp').description('MCP サーバの登録（Akari から外部の道具を使う）');
mcp
  .command('add')
  .description('MCP サーバを登録する（起動する内容を見せて同意を取ります）')
  .requiredOption('--name <名前>', '道具名の接頭辞にもなる（英数字・_・- の32文字まで）')
  .option('--command <コマンド>', '子プロセスとして起動する（stdio）')
  .option('--arg <引数>', 'コマンドの引数。繰り返して並べる', collect, [])
  .option(
    '--env <名前=値>',
    '子プロセスへ渡す環境変数。値は env:NAME で Akari の環境変数から',
    collect,
    [],
  )
  .option('--cwd <dir>', '子プロセスの作業ディレクトリ（既定は作業フォルダ）')
  .option('--url <URL>', 'HTTP（Streamable HTTP）でつなぐ')
  .option('--header <名前: 値>', 'HTTP のヘッダ。値は env:NAME で書ける', collect, [])
  .option('--bearer-env <変数名>', 'Authorization: Bearer の鍵を環境変数から読む')
  .option('--trust <ask|read-only|full>', '承認の扱い。既定 ask（毎回聞く）')
  .option('-y, --yes', '確認なしで同意する（内容を確かめたうえで）')
  .action(async (o) =>
    run(() => import('./commands/mcp.js').then((m) => m.mcpAdd({ ...globals(), ...o }))),
  );
mcp
  .command('list')
  .description('登録済みの MCP サーバと、同意の状態')
  .action(async () => run(() => import('./commands/mcp.js').then((m) => m.mcpList(globals()))));
mcp
  .command('tools <名前>')
  .description('そのサーバへつなぎ、道具の一覧と注釈を出す')
  .action(async (n) =>
    run(() => import('./commands/mcp.js').then((m) => m.mcpTools(n, globals()))),
  );
mcp
  .command('trust <名前>')
  .description('手で書いた・変えた設定を確かめて、起動に同意する')
  .option('-y, --yes', '確認なしで同意する（内容を確かめたうえで）')
  .action(async (n, o) =>
    run(() => import('./commands/mcp.js').then((m) => m.mcpTrust(n, { ...globals(), ...o }))),
  );
mcp
  .command('rm <名前>')
  .description('MCP サーバの登録を消す')
  .action(async (n) =>
    run(() => import('./commands/mcp.js').then((m) => m.mcpRemove(n, globals()))),
  );
mcp
  .command('serve')
  .description('Akari の道具を MCP（stdio）で出す。Claude Code などから使う')
  .option('-w, --workspace <dir>', '作業フォルダ（既定はカレント）')
  .option('--permission <read-only|auto-edit|full>', '出す道具。既定 read-only（読み取りだけ）')
  .option('--http', 'HTTP で出す（まだ実装していません）')
  .action(async (o) =>
    run(() => import('./commands/mcp.js').then((m) => m.mcpServe({ ...globals(), ...o }))),
  );
mcp
  .command('doctor')
  .description('有効なサーバ全部へつなぎ、起動時間と道具の数を出す')
  .action(async () => run(() => import('./commands/mcp.js').then((m) => m.mcpDoctor(globals()))));

// まだ無い機能。あるように見せない。
for (const [name, desc, when] of [
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
    // 「繋がらない」はどのコマンドで起きても 4。
    // models だけ 4 で chat と run が 1 では、呼び出し側が原因を判別できない。
    const pe = getProviderError(err);
    if (pe) {
      errorLine(pe.message);
      if (pe.kind === 'unreachable') {
        hintLine('サーバが起動しているか、URLが正しいかを確認してください。');
      }
      process.exitCode = pe.kind === 'unreachable' ? EXIT.unreachable : EXIT.runtime;
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

/** 全体のオプションのうち、値を取るもの。値をプロンプトと取り違えないため。 */
const VALUE_OPTIONS = new Set([
  '-e',
  '--endpoint',
  '-m',
  '--model',
  '-C',
  '--cwd',
  '--permission',
  '--max-steps',
  '--tools-mode',
  '--timeout',
  '--think',
  '--conversation',
]);

function hasPositional(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return i + 1 < args.length;
    if (!a.startsWith('-')) return true;
    if (VALUE_OPTIONS.has(a)) i += 1;
  }
  return false;
}

async function main(): Promise<void> {
  let argv = process.argv;
  if (argv.includes('--no-color') || process.env.NO_COLOR) setColor(false);

  // サブコマンド名でない文字列が最初に来たら run とみなす（akari "テストを通して"）。
  const known = new Set(program.commands.map((cmd) => cmd.name()));
  const first = argv[2];
  if (first !== undefined && !first.startsWith('-') && !known.has(first)) {
    argv = [...argv.slice(0, 2), 'run', ...argv.slice(2)];
  }

  // サブコマンドもプロンプトも無ければ対話画面（17-interactive.md）。
  // 端末でなければ（パイプの中など）、今までどおりヘルプを出す
  if (!hasPositional(argv.slice(2))) {
    const flags = argv.slice(2);
    const onlyInfo = flags.some((a) => ['-h', '--help', '-v', '--version'].includes(a));
    if (!onlyInfo && (isInteractive() || flags.length > 0)) {
      argv = [...argv.slice(0, 2), 'interactive', ...flags];
    } else if (flags.length === 0) {
      out(c.bold(`Akari CLI ${VERSION}`));
      out('');
      program.outputHelp();
      return;
    }
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
  // コマンドが自分で受けている（run の中断、serve の停止）なら、そちらに任せる。
  // ここで先に終わらせると、実行を止める・記録を閉じるといった後始末が走らない
  if (process.listenerCount('SIGINT') > 1) return;
  process.stderr.write('\n中断しました。\n');
  process.exit(EXIT.interrupted);
});

await main();
