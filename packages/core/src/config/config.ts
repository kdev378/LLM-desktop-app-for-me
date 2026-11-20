import fs from 'node:fs/promises';
import path from 'node:path';
import { paths, ensureDir } from '../util/paths.js';
import { readJson, writeJsonAtomic } from '../util/json.js';
import { AkariError } from '../util/errors.js';
import {
  CONFIG_SCHEMA_VERSION,
  configSchema,
  defaultConfig,
  describeIssues,
  type Config,
} from './schema.js';

/**
 * 設定の読み書き。仕様: docs/spec/03-config.md
 *
 * 方針:
 * - 不正な値を黙って既定へ差し替えない。何がなぜ不正かを返す。
 * - 未来の schemaVersion は読み取り専用にする。古いデータを壊さないため。
 * - 壊れた config.json は退避して残す。消さない。
 */

export type LoadedConfig = {
  config: Config;
  /** 未来のバージョンで作られていた場合 true。書き込みを拒否する。 */
  readOnly: boolean;
  /** 起動時に利用者へ見せるべき問題。空なら問題なし。 */
  problems: ConfigProblem[];
};

export type ConfigProblem = {
  kind: 'invalid' | 'recovered' | 'future-version' | 'migrated';
  message: string;
  detail?: string;
};

export async function loadConfig(root?: string): Promise<LoadedConfig> {
  const home = root ?? paths.home();
  const file = paths.config(home);
  const problems: ConfigProblem[] = [];

  const res = await readJson<Record<string, unknown>>(file);

  if (res.status === 'missing') {
    return { config: defaultConfig(), readOnly: false, problems };
  }

  if (res.status === 'unreadable') {
    // JSON として読めない。退避して既定で起動する。消さない。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const broken = path.join(home, `config.broken-${stamp}.json`);
    try {
      await fs.rename(file, broken);
      problems.push({
        kind: 'recovered',
        message: '設定ファイルが壊れていたため、既定の設定で起動しました。',
        detail: `元のファイルは ${broken} に残してあります。`,
      });
    } catch (err) {
      problems.push({
        kind: 'invalid',
        message: '設定ファイルが読めず、退避もできませんでした。',
        detail: `${file}: ${(err as Error).message}`,
      });
    }
    return { config: defaultConfig(), readOnly: false, problems };
  }

  const raw = res.value;
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1;

  if (version > CONFIG_SCHEMA_VERSION) {
    const parsed = configSchema.safeParse({ ...raw, schemaVersion: CONFIG_SCHEMA_VERSION });
    problems.push({
      kind: 'future-version',
      message: `新しいバージョンのAkariで作られた設定です（形式 v${version}）。壊さないよう、書き込みを止めています。`,
      detail: 'Akari を更新するか、設定ファイルを退避してください。',
    });
    return {
      config: parsed.success ? parsed.data : defaultConfig(),
      readOnly: true,
      problems,
    };
  }

  const migrated = migrate(raw, version);
  if (migrated.changed) {
    problems.push({
      kind: 'migrated',
      message: `設定を形式 v${version} から v${CONFIG_SCHEMA_VERSION} へ更新しました。`,
    });
  }

  const parsed = configSchema.safeParse(migrated.value);
  if (!parsed.success) {
    // 直せない不正。既定で起動しつつ、何が不正かを必ず見せる。
    problems.push({
      kind: 'invalid',
      message: '設定に不正な項目があります。設定画面で直してください。',
      detail: describeIssues(parsed.error).join('\n'),
    });
    return { config: defaultConfig(), readOnly: false, problems };
  }

  const config = parsed.data;
  // activeEndpointId が存在しない接続先を指していたら、指し直す（黙って落とさず報告する）
  if (config.activeEndpointId && !config.endpoints.some((e) => e.id === config.activeEndpointId)) {
    problems.push({
      kind: 'invalid',
      message: `選択中の接続先 ${config.activeEndpointId} が見つかりません。`,
      detail:
        config.endpoints.length > 0
          ? '別の接続先を選び直してください。'
          : '接続先を登録してください。',
    });
    config.activeEndpointId = config.endpoints[0]?.id ?? null;
  }

  return { config, readOnly: false, problems };
}

export async function saveConfig(config: Config, root?: string): Promise<void> {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new AkariError('config.invalid', '設定を保存できません。値が有効な範囲を外れています。', {
      detail: describeIssues(parsed.error).join('\n'),
    });
  }
  const home = root ?? paths.home();
  await ensureDir(home);
  await writeJsonAtomic(paths.config(home), {
    ...parsed.data,
    schemaVersion: CONFIG_SCHEMA_VERSION,
  });
}

/**
 * 形式の移行。未知の項目は保持したまま返す（黙って捨てない）。
 * v1 が最初の形式なので、今は変換すべきものが無い。
 */
function migrate(
  raw: Record<string, unknown>,
  from: number,
): { value: Record<string, unknown>; changed: boolean } {
  let value = raw;
  let changed = false;
  let version = from;

  // 将来ここに v1 -> v2 などを足す。各段階は冪等にする。
  if (version < CONFIG_SCHEMA_VERSION) {
    value = { ...value, schemaVersion: CONFIG_SCHEMA_VERSION };
    changed = true;
    version = CONFIG_SCHEMA_VERSION;
  }
  return { value, changed };
}
