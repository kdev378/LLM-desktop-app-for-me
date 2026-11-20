import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * 設定とデータの根。デスクトップとCLIで同じ場所を指す。
 * AKARI_HOME が設定されていればそれを使う（テストと持ち運び用）。
 * 仕様: docs/spec/03-config.md
 */
export function akariHome(): string {
  const override = process.env.AKARI_HOME;
  if (override && override.trim() !== '') return path.resolve(override);

  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Akari');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Akari');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && xdg.trim() !== '' ? xdg : path.join(home, '.config'), 'akari');
}

export const paths = {
  home: akariHome,
  config: (root = akariHome()) => path.join(root, 'config.json'),
  credentials: (root = akariHome()) => path.join(root, 'credentials.json'),
  conversations: (root = akariHome()) => path.join(root, 'conversations'),
  projects: (root = akariHome()) => path.join(root, 'projects'),
  backups: (root = akariHome()) => path.join(root, 'backups'),
  logs: (root = akariHome()) => path.join(root, 'logs'),
  trash: (root = akariHome()) => path.join(root, 'trash'),
  quarantine: (root = akariHome()) => path.join(root, 'quarantine'),
  lock: (root = akariHome()) => path.join(root, 'akari.lock'),
};

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** ホームディレクトリを ~ に置き換える。診断とログで実パスを晒さないため。 */
export function tildify(p: string): string {
  const home = os.homedir();
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
