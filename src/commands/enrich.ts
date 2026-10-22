import { loadEnv, requireHarness, resolveLineAccountId } from "./shared.js";
import * as log from "../log.js";

/** POST /api/admin/refresh-profiles の結果（data に包まれる版と包まれない版がある） */
interface RefreshProfilesResult {
  processed?: number;
  updated?: number;
  notFound?: number;
  otherErrors?: number;
  hasMore?: boolean;
  nextOffset?: number;
}

/**
 * 移行した友だちの表示名・アイコン・ステータスメッセージを LINE から取り直す。
 * L Harness 標準の POST /api/admin/refresh-profiles を offset 送りで呼ぶだけ
 * （チャネルアクセストークンは L Harness 側が持っているものを使う。こちらでは扱わない）。
 * ブロック中（is_following=0）の人は対象外。
 */
export async function runEnrich(opts: { limit?: number }): Promise<void> {
  const env = loadEnv();
  requireHarness(env);
  const accountId = await resolveLineAccountId(env);
  const base = env.config.harness_url!.replace(/\/+$/, "");
  // 無料プランの Worker は1回の呼び出しで外部通信50件まで。1人=LINE取得+DB更新なので20人ずつ
  const batch = Math.min(Math.max(opts.limit ?? 20, 1), 500);
  let offset = 0;
  let updated = 0;
  let notFound = 0;
  let errors = 0;
  for (let round = 0; round < 1000; round++) {
    const url = `${base}/api/admin/refresh-profiles?offset=${offset}&limit=${batch}&accountId=${encodeURIComponent(accountId)}`;
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${env.secrets.HARNESS_API_KEY}` }, signal: AbortSignal.timeout(120_000) });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: RefreshProfilesResult } & RefreshProfilesResult;
    const d: RefreshProfilesResult = json.data ?? json;
    if (!res.ok || json.success === false) throw new Error(`refresh-profiles が失敗しました (HTTP ${res.status}${json.error ? `: ${json.error}` : ""})`);
    updated += d.updated ?? 0;
    notFound += d.notFound ?? 0;
    errors += d.otherErrors ?? 0;
    log.info(`  … ${offset + (d.processed ?? 0)}人まで（更新 ${updated}）`);
    if (!d.hasMore) break;
    offset = d.nextOffset ?? offset + (d.processed ?? batch);
  }
  log.info(`完了: 更新 ${updated}人 / 取得できず ${notFound}人 / エラー ${errors}件`);
}
