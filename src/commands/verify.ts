import { join } from "node:path";
import type { PlanManifest } from "../mapping/plan.js";
import { d1Query, type WranglerD1Options } from "../d1/wrangler.js";
import { d1Options, loadEnv, outDir, snapshotDir } from "./shared.js";
import { SnapshotStore } from "../snapshot/store.js";
import { harnessId } from "../harness/ids.js";
import { quote } from "../sql/render.js";
import { readJsonFile } from "../util.js";
import * as log from "../log.js";

/**
 * ステップの件数の確認。L Harness で有効にしたシナリオは、移行し直してもステップを変えないので数えない
 * （古い版の計画には steps_by_scenario が無いので、これまでどおり全部を数える）。
 */
export async function stepsCheck(manifest: PlanManifest, d1: WranglerD1Options): Promise<{ label: string; sql: string; expected: number }> {
  const base = `SELECT COUNT(*) AS c FROM scenario_steps s JOIN scenarios c ON c.id = s.scenario_id WHERE c.description LIKE 'L Message%'`;
  const total = manifest.counts.scenario_steps ?? 0;
  const planned = manifest.steps_by_scenario;
  if (!planned || !total) return { label: "ステップ", sql: base, expected: total };
  const active = await d1Query(`SELECT id FROM scenarios WHERE is_active = 1 AND description LIKE 'L Message%'`, d1);
  const kept = active.map((r) => String(r.id)).filter((id) => id in planned);
  if (!kept.length) return { label: "ステップ", sql: base, expected: total };
  log.info(`  L Harness で有効にしているシナリオ ${kept.length}件は、ステップを変えていないので数えません`);
  const keptSteps = kept.reduce((n, id) => n + planned[id], 0);
  return { label: "ステップ（有効にしたシナリオを除く）", sql: `${base} AND c.is_active = 0`, expected: total - keptSteps };
}

export async function runVerify(opts: { local?: boolean }): Promise<void> {
  const env = loadEnv();
  const out = outDir(env);
  const manifest = readJsonFile<PlanManifest>(join(out, "plan.json"));
  if (!manifest) throw new Error("out/plan.json がありません");
  const d1 = d1Options(env, opts.local);
  const acc = quote(manifest.line_account_id);
  const checks: Array<{ label: string; sql: string; expected: number }> = [
    { label: "友だち（移行分）", sql: `SELECT COUNT(*) AS c FROM friends WHERE line_account_id = ${acc} AND json_extract(metadata, '$._lme.friend_id') IS NOT NULL`, expected: manifest.counts.friends ?? 0 },
    { label: "友だちのタグ", sql: `SELECT COUNT(*) AS c FROM friend_tags ft JOIN friends f ON f.id = ft.friend_id WHERE f.line_account_id = ${acc} AND json_extract(f.metadata, '$._lme.friend_id') IS NOT NULL`, expected: manifest.counts.friend_tags ?? 0 },
    { label: "会話履歴", sql: `SELECT COUNT(*) AS c FROM messages_log m JOIN friends f ON f.id = m.friend_id WHERE f.line_account_id = ${acc} AND json_extract(f.metadata, '$._lme.friend_id') IS NOT NULL`, expected: manifest.counts.messages_log ?? 0 },
    { label: "会話（chats）", sql: `SELECT COUNT(*) AS c FROM chats c JOIN friends f ON f.id = c.friend_id WHERE json_extract(f.metadata, '$._lme.friend_id') IS NOT NULL`, expected: manifest.counts.chats ?? 0 },
    { label: "ステップ配信", sql: `SELECT COUNT(*) AS c FROM scenarios WHERE line_account_id = ${acc} AND description LIKE 'L Message%'`, expected: manifest.counts.scenarios ?? 0 },
    await stepsCheck(manifest, d1),
    { label: "テンプレート", sql: `SELECT COUNT(*) AS c FROM templates`, expected: manifest.counts.templates ?? 0 },
    { label: "フォーム", sql: `SELECT COUNT(*) AS c FROM forms`, expected: manifest.counts.forms ?? 0 },
    { label: "フォーム回答", sql: `SELECT COUNT(*) AS c FROM form_submissions`, expected: manifest.counts.form_submissions ?? 0 },
    { label: "レッスン予約", sql: `SELECT COUNT(*) AS c FROM event_bookings WHERE line_account_id = ${acc} AND internal_note LIKE 'L Message から移行%'`, expected: manifest.counts.event_bookings ?? 0 },
    { label: "自動応答", sql: `SELECT COUNT(*) AS c FROM auto_replies WHERE line_account_id = ${acc}`, expected: manifest.counts.auto_replies ?? 0 },
  ];
  let ng = 0;
  log.info("D1 の件数を確認します（「以上」は既存データを含む表）");
  for (const ch of checks) {
    if (ch.expected === 0) continue;
    const rows = await d1Query(ch.sql, d1);
    const c = Number(rows[0]?.c ?? 0);
    const ok = c >= ch.expected;
    if (!ok) ng += 1;
    log.info(`  ${ok ? "✓" : "✗"} ${ch.label}: D1 ${c} / 計画 ${ch.expected}`);
  }
  // 抜き取り: スナップショットの先頭 3 人が API で読めるか
  if (env.harness) {
    const store = new SnapshotStore(snapshotDir(env));
    let i = 0;
    for (const s of store.friends()) {
      if (i++ >= 3) break;
      const id = manifest.counts.friends ? harnessId("friend", s.row.lmessage_friend_id) : null;
      if (!id) break;
      try {
        const f = await env.harness.friend(id);
        const tags = Array.isArray((f as { tags?: unknown[] }).tags) ? (f as { tags: unknown[] }).tags.length : "?";
        log.info(`  ✓ API 抜き取り: ${String((f as { displayName?: string }).displayName ?? "")} タグ${tags}件`);
      } catch (e) {
        ng += 1;
        log.info(`  ✗ API 抜き取り: ${(e as Error).message}`);
      }
    }
  }
  if (ng) throw new Error(`${ng} 件の確認が不一致です。out/report.md と apply のログを確認してください`);
  log.info("すべて一致しました");
}
