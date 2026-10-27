import type { ChatMessage, ToolDefinition } from '../provider/types.js';
import type { TranscriptEntry } from '../agent/transcript.js';

/**
 * 文脈の量の見積もりと、どこを圧縮するかの選び方。仕様: docs/spec/16-context.md
 */

/** 文字数からの概算の係数。日本語混じりのコードでの当たり具合は未実測（16-context.md「未解決」）。 */
export const CHARS_PER_TOKEN = 2.2;

/** 送るものの概算トークン数（メッセージと道具の定義）。 */
export function estimateTokens(messages: ChatMessage[], tools?: ToolDefinition[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length + 8; // 役割などの包みの分
    for (const c of m.toolCalls ?? []) chars += c.name.length + c.argumentsRaw.length + 16;
  }
  if (tools && tools.length > 0) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 圧縮を始める量。
 * - 文脈長が分かる: 文脈長 × compactAtRatio。概算しか無いときは 0.6 以下に倒す
 *   （外して溢れるより、早めに圧縮するほうが被害が小さい）
 * - 分からない: compactAtTokens
 */
export function compactThreshold(
  settings: { compactAtRatio: number; compactAtTokens: number },
  windowTokens: number | null,
  estimatedOnly: boolean,
): number {
  if (windowTokens === null) return settings.compactAtTokens;
  const ratio = estimatedOnly ? Math.min(settings.compactAtRatio, 0.6) : settings.compactAtRatio;
  return Math.floor(windowTokens * ratio);
}

/**
 * 圧縮の単位。モデルの応答1回と、それに続く道具の結果・Akari の指摘を不可分にまとめる。
 * `tool_calls` と対応する `tool` を切り離すと、OpenAI互換APIは 400 を返すため。
 * 利用者の発言は1件で1単位。
 */
export type Unit = { kind: 'assistant' | 'user'; entries: TranscriptEntry[] };

export function splitUnits(entries: TranscriptEntry[]): Unit[] {
  const units: Unit[] = [];
  for (const e of entries) {
    const isHuman = e.role === 'user' && e.source !== 'akari';
    if (e.role === 'assistant') {
      units.push({ kind: 'assistant', entries: [e] });
    } else if (isHuman) {
      units.push({ kind: 'user', entries: [e] });
    } else {
      // 道具の結果と Akari の指摘は、直前の応答にくっつける
      const last = units.at(-1);
      if (last && last.kind === 'assistant') last.entries.push(e);
      else units.push({ kind: 'user', entries: [e] });
    }
  }
  return units;
}

/**
 * 圧縮する単位を選ぶ。
 *
 * 圧縮しないもの:
 * - 会話の最初の依頼（目的）。これを失うと何をしていたか分からなくなる
 * - 一番新しい依頼（今の実行で頼まれたこと）
 * - 直近 keepRecent 手（モデルの応答の単位で数える）とその後ろ
 * - すでに圧縮したもの
 */
export function selectForCompaction(
  entries: TranscriptEntry[],
  covered: ReadonlySet<string>,
  keepRecent: number,
): Unit[] {
  const humans = entries.filter((e) => e.role === 'user' && e.source !== 'akari');
  const protectedIds = new Set<string>(
    [humans[0]?.id, humans.at(-1)?.id].filter((x): x is string => x !== undefined),
  );
  const units = splitUnits(entries.filter((e) => !covered.has(e.id)));

  // 後ろから数えて keepRecent 番目のモデルの応答より前だけが候補
  let seen = 0;
  let cut = units.length;
  for (let i = units.length - 1; i >= 0; i--) {
    if (units[i]!.kind === 'assistant') {
      seen += 1;
      if (seen === keepRecent) {
        cut = i;
        break;
      }
    }
  }
  if (seen < keepRecent) return [];
  return units
    .slice(0, cut)
    .filter((u) => !(u.kind === 'user' && u.entries.every((e) => protectedIds.has(e.id))));
}

/**
 * 送るときだけ、長い道具の出力を先頭と末尾を残して切る。生の記録は変えない。
 * 切ったことは本文に明記する（16-context.md「それでも入りきらないとき」）。
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.max(0, maxChars - headLen);
  const omitted = text.length - headLen - tailLen;
  return (
    `${text.slice(0, headLen)}\n\n[akari] 文脈に入りきらないため、ここで ${omitted} 文字を省きました。` +
    `原文は recall_read で読めます。\n\n${text.slice(text.length - tailLen)}`
  );
}
