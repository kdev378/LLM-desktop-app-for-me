import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { denied, type ToolResult, type ToolSpec } from './types.js';
import { isSecretName } from './workspace.js';

/**
 * 秘密のファイルの読み取りを、モデルが利用者に求める。
 * 仕様: docs/spec/05-agent.md「秘密のファイルの読み取りを、モデルが利用者に求める」
 *
 * どの権限でも毎回利用者に聞く（実行ループの承認で）。許すと、その実行の間だけ、
 * そのファイルを read_file とコマンドの両方から読める。作業フォルダの外は求められない。
 * 作業フォルダに秘密のファイルがあるときだけ渡す（ほかの道具を探す邪魔をしない）。
 */

export const SECRET_ACCESS_TOOL_NAME = 'request_secret_access';

const args = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
});

export const requestSecretAccessTool: ToolSpec = {
  name: SECRET_ACCESS_TOOL_NAME,
  description:
    '作業フォルダの中の秘密のファイル（.env など）を読む許可を、理由を添えて利用者に求める。' +
    '許されれば、この実行の間は read_file とコマンドから読める。断られたら、別の手段で読もうとしないこと。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '作業フォルダからの相対パス' },
      reason: { type: 'string', description: 'なぜ読む必要があるか。利用者に見せる' },
    },
    required: ['path', 'reason'],
  },
  async check(raw, ctx): Promise<ToolResult | null> {
    const a = args.safeParse(raw);
    if (!a.success) {
      return denied(
        `引数が正しくありません: ${a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' / ')}`,
        'invalid',
      );
    }
    const r = await ctx.workspace.resolve(a.data.path, 'read');
    if (r.ok) {
      return r.exists
        ? {
            ok: true,
            summary: `${r.relative} は許可なしで読めます`,
            content: `${r.relative} は秘密のファイルの規則に当たらないので、許可なしで読めます。`,
          }
        : denied(`ファイルがありません: ${a.data.path}`, 'not-found');
    }
    if (!r.secret)
      return denied(
        `${r.message}（許可を求められるのは、作業フォルダの中の秘密のファイルだけです）`,
      );
    return null;
  },
  async preview(raw) {
    const a = args.safeParse(raw);
    if (!a.success) return undefined;
    return {
      kind: 'text',
      text:
        `モデルが秘密のファイルの読み取りを求めています: ${a.data.path}\n理由: ${a.data.reason}\n` +
        '許すと、この実行の間だけ read_file とコマンドから読めます（中身はモデルへ渡り、会話に保存されます）。',
    };
  },
  async run(raw, ctx) {
    const a = args.parse(raw);
    // 読み取りの判定は実体のパスで行う（シンボリックリンク越しに別のファイルを許さない）
    const absolute = await fs.realpath(path.resolve(ctx.workspace.root, a.path));
    if (!isSecretName(path.basename(absolute))) {
      return denied(`${a.path} は秘密のファイルではありません。`, 'invalid');
    }
    ctx.workspace.grantSecret(absolute);
    return {
      ok: true,
      summary: `${a.path} の読み取りが許されました（この実行の間だけ）`,
      content: `利用者が ${a.path} の読み取りを許しました。この実行の間は read_file とコマンドから読めます。`,
    };
  },
};
