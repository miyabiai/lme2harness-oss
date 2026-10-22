import { existsSync, readFileSync } from "node:fs";

/** あちこちで使う小さな道具（待ち・分割・JSON ファイル・URL 判定）。 */

/** ms ミリ秒待つ。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 配列を size 件ずつの塊に分ける（まとめ取り API の呼び出し単位）。 */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** JSON ファイルを読む。無ければ null。 */
export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** http:// か https:// で始まる文字列か */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}
