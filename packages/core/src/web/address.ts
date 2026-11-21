import net from 'node:net';

/**
 * 取りに行ってよい IP アドレスか。仕様: docs/spec/15-web.md「SSRF を塞ぐ」
 *
 * ホスト名の文字列ではなく、名前解決した結果の IP で判定する。
 * - internal … 内部のアドレス。`web.fetch.privateHosts` に挙げたホスト名なら許す
 * - never    … どの設定でも許さない（クラウドのメタデータを含むリンクローカル、0.0.0.0/8、マルチキャストなど）
 */

export type AddressVerdict = { ok: true } | { ok: false; kind: 'internal' | 'never'; what: string };

type Range = [string, number, string];

const NEVER_V4: Range[] = [
  ['0.0.0.0', 8, '「このネットワーク」の予約'],
  ['169.254.0.0', 16, 'リンクローカル（クラウドのメタデータ 169.254.169.254 を含む）'],
  ['224.0.0.0', 4, 'マルチキャスト'],
  ['240.0.0.0', 4, '予約済み（ブロードキャストを含む）'],
];
const INTERNAL_V4: Range[] = [
  ['127.0.0.0', 8, 'ループバック（この PC）'],
  ['10.0.0.0', 8, 'プライベート'],
  ['172.16.0.0', 12, 'プライベート'],
  ['192.168.0.0', 16, 'プライベート'],
  ['100.64.0.0', 10, 'CGNAT（通信事業者の内側）'],
  ['192.0.0.0', 24, 'IETF の予約'],
  ['192.0.2.0', 24, '文書用の予約'],
  ['198.18.0.0', 15, 'ベンチマーク用の予約'],
  ['198.51.100.0', 24, '文書用の予約'],
  ['203.0.113.0', 24, '文書用の予約'],
];
const NEVER_V6: Range[] = [
  ['::', 128, '未指定のアドレス'],
  ['fe80::', 10, 'リンクローカル'],
  ['ff00::', 8, 'マルチキャスト'],
  ['2001::', 32, 'Teredo（中の行き先が分からない）'],
];
const INTERNAL_V6: Range[] = [
  ['::1', 128, 'ループバック（この PC）'],
  ['fc00::', 7, 'プライベート（ユニークローカル）'],
  ['fec0::', 10, 'サイトローカル（廃止された内部用）'],
  ['2001:db8::', 32, '文書用の予約'],
  ['100::', 64, '捨てる用の予約'],
];

function list(v4: Range[], v6: Range[]): Array<{ block: net.BlockList; what: string }> {
  return [
    ...v4.map(([a, p, what]) => {
      const block = new net.BlockList();
      block.addSubnet(a, p, 'ipv4');
      return { block, what };
    }),
    ...v6.map(([a, p, what]) => {
      const block = new net.BlockList();
      block.addSubnet(a, p, 'ipv6');
      return { block, what };
    }),
  ];
}

const NEVER = list(NEVER_V4, NEVER_V6);
const INTERNAL = list(INTERNAL_V4, INTERNAL_V6);

export function checkAddress(address: string): AddressVerdict {
  const family = net.isIP(address);
  if (family === 0) return { ok: false, kind: 'never', what: 'IP アドレスとして読めない' };
  // IPv6 の中に IPv4 を入れた書き方は、中の IPv4 で判定する
  if (family === 6) {
    const inner = embeddedV4(address);
    if (inner) {
      const v = checkAddress(inner);
      return v.ok ? v : { ...v, what: `${v.what}（${address} の中の ${inner}）` };
    }
  }
  const type = family === 4 ? 'ipv4' : 'ipv6';
  for (const r of NEVER)
    if (r.block.check(address, type)) return { ok: false, kind: 'never', what: r.what };
  for (const r of INTERNAL)
    if (r.block.check(address, type)) return { ok: false, kind: 'internal', what: r.what };
  return { ok: true };
}

/** ::ffff:a.b.c.d / ::a.b.c.d（互換）/ 64:ff9b::/96（NAT64）/ 2002::/16（6to4）の中の IPv4。 */
function embeddedV4(address: string): string | null {
  const words = expandV6(address);
  if (!words) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zeros = (n: number) => words.slice(0, n).every((w) => w === 0);
  if (zeros(5) && words[5] === 0xffff) return v4(words[6]!, words[7]!);
  if (zeros(6) && (words[6] !== 0 || words[7]! > 1)) return v4(words[6]!, words[7]!);
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0))
    return v4(words[6]!, words[7]!);
  if (words[0] === 0x2002) return v4(words[1]!, words[2]!);
  return null;
}

/** IPv6 を8つの16ビットの数に。末尾が IPv4 の書き方（::ffff:1.2.3.4）も読む。 */
function expandV6(address: string): number[] | null {
  let a = address.toLowerCase().split('%')[0]!;
  const dotted = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[2]!.split('.').map(Number);
    a = `${dotted[1]}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = a.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  if (fill < 0) return null;
  const words = [...h, ...Array(fill).fill('0'), ...t].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff)
    ? words
    : null;
}
