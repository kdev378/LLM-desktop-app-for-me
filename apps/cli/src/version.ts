/** リリース時にビルドで置き換える。docs/spec/09-security.md の「配布」を参照。 */
export const VERSION = '0.1.0';
export const COMMIT = process.env.AKARI_COMMIT ?? 'dev';
