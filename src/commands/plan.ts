import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { SnapshotStore } from "../snapshot/store.js";
import { buildPlan, writePlan } from "../mapping/plan.js";
import { quote } from "../sql/render.js";
import { loadEnv, outDir, resolveLineAccountId, snapshotDir } from "./shared.js";
import * as log from "../log.js";

export async function runPlan(opts: { lineAccountId?: string; localSchema?: string }): Promise<void> {
  const env = loadEnv();
  const store = new SnapshotStore(snapshotDir(env));
  if (!store.meta()) throw new Error(`スナップショットがありません（${env.config.snapshot_dir}）。先に \`lme2harness extract\` を実行してください`);
  const lineAccountId = await resolveLineAccountId(env, opts.lineAccountId);

  const existingTags = new Map<string, string>();
  if (env.harness) {
    try {
      for (const t of await env.harness.tags()) existingTags.set(t.name, t.id);
      log.info(`L Harness の既存タグ ${existingTags.size}件を読みました（同名は再利用）`);
    } catch (e) {
      log.warn(`既存タグを読めませんでした: ${(e as Error).message}`);
    }
  }

  log.info("変換中…");
  const { ctx, rowsByTable } = buildPlan(store, { lineAccountId, options: env.config.options, existingTags });
  const out = outDir(env);
  const manifest = writePlan(out, ctx, rowsByTable, store);

  if (opts.localSchema) {
    log.info("ローカル SQLite で検査中…");
    // node:sqlite は読み込むだけで実験機能の警告が出るので、使うときだけ読む
    const { LocalD1 } = await import("../d1/local.js");
    const db = new LocalD1();
    db.loadSchema(opts.localSchema);
    db.exec(`INSERT OR IGNORE INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (${quote(lineAccountId)}, 'check', 'check', 'x', 'x')`);
    // L Harness に既にあるタグを使い回す行があるので、検査用 DB にも同じタグを置く
    for (const [name, id] of existingTags) db.exec(`INSERT OR IGNORE INTO tags (id, name) VALUES (${quote(id)}, ${quote(name)})`);
    for (const c of manifest.chunks) {
      const sql = readFileSync(join(out, c.file), "utf8");
      try {
        db.execStatements([sql]);
      } catch (e) {
        throw new Error(`${c.file} でエラー: ${(e as Error).message}`);
      }
    }
    log.info("  ✓ 全 SQL がローカルで通りました");
    db.close();
  }

  log.info("");
  log.info("変換結果（詳細は out/report.md）:");
  for (const r of Object.values(manifest.reports)) {
    if (r.source === 0 && r.migrated === 0) continue;
    log.info(`  ${r.label}: ${r.source} → ${r.migrated}${r.skipped ? `（除外 ${r.skipped}）` : ""}`);
  }
  log.info(`SQL: ${manifest.chunks.length} ファイル → ${join(env.config.out_dir, "sql")}`);
  if (!existsSync(join(out, "report.md"))) log.warn("レポートを書けませんでした");
  log.info("次は `lme2harness apply`（本番 D1 へ）");
}
