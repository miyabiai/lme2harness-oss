/**
 * 日時の正規化。
 * エルメは JST を "2026-10-08 19:28:46"（オフセット無し）または "2026-07-30T13:00:00+09:00" で返す。
 * L Harness の多くの列は strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours') 形式（JST・オフセット無し・ミリ秒付き）。
 * 一部の列は datetime('now')（UTC "YYYY-MM-DD HH:MM:SS"）。
 */

/** JST（UTC+9）のずれ（ms） */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** エルメの日時文字列を epoch ms に変換する。オフセット無しは JST とみなす。日付だけなら 00:00 JST。 */
export function parseSourceDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const s = value.trim();
  if (!s) return null;
  // "2026-10-08 19:28:46" / "2026-10-08 19:28:46.0" / "2026-10-08"
  const m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const [, y, mo, d, h = "00", mi = "00", se = "00", frac = "0", tz] = m;
  const ms = Math.round(Number(`0.${frac}`) * 1000);
  const utcLike = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se), ms);
  if (!tz) return utcLike - JST_OFFSET_MS;
  if (tz === "Z") return utcLike;
  const sign = tz.startsWith("-") ? -1 : 1;
  const digits = tz.slice(1).replace(":", "");
  const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60 * 1000;
  return utcLike - offset;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/**
 * L Harness のアプリ側が書く形式（jstNow()）: "YYYY-MM-DDTHH:MM:SS.mmm+09:00"。
 * DB の DEFAULT はオフセット無しだが、アプリは +09:00 付きで書き、friend_scenarios.started_at の
 * 解釈も +9h 前提なので、こちらに揃える。
 */
export function toHarnessJst(epochMs: number): string {
  const d = new Date(epochMs + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}+09:00`;
}

/** UTC ISO8601（"Z" 付き）。予約テーブルが使う。 */
export function toIsoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function nowJst(): string {
  return toHarnessJst(Date.now());
}

/** エルメ日時 → L Harness JST 文字列。変換できなければ fallback（既定は今）。 */
export function sourceToHarnessJst(value: string | null | undefined, fallback?: string): string {
  const t = parseSourceDate(value);
  return t === null ? fallback ?? nowJst() : toHarnessJst(t);
}
