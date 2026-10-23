import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { PlanManifest } from "../mapping/plan.js";
import { d1ExecuteFile } from "../d1/wrangler.js";
import { d1Options, loadEnv, outDir } from "./shared.js";
import { readJsonFile } from "../util.js";
import * as log from "../log.js";

interface ApplyState {
  /** 流したファイル。"ファイル名:中身のハッシュ" の形（plan し直して中身が変わったら流し直す） */
  done: string[];
  updated_at: string;
}

/**
 * ファイルを「同じ表のものだけ同時に n 本」で流す。表と表の間は順番どおり（親表 → 子表）に待つ。
 * 1 ファイルは 1 回の wrangler 実行（数秒）なので、大きなアカウントでは並列にすると何倍も速い。
 */
export async function runInTableGroups<T extends { table: string }>(items: T[], parallel: number, fn: (item: T) => Promise<void>): Promise<void> {
  const groups: T[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last[0].table === item.table) last.push(item);
    else groups.push([item]);
  }
  const width = Math.max(1, Math.floor(parallel));
  for (const group of groups) {
    let next = 0;
    const worker = async () => {
      for (;;) {
        const item = group[next++];
        if (!item) return;
        await fn(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, group.length) }, worker));
  }
}

export async function runApply(opts: { local?: boolean; dryRun?: boolean; from?: number; parallel?: number }, deps: { execute?: typeof d1ExecuteFile } = {}): Promise<void> {
  const execute = deps.execute ?? d1ExecuteFile;
  const env = loadEnv();
  const out = outDir(env);
  const manifest = readJsonFile<PlanManifest>(join(out, "plan.json"));
  if (!manifest) throw new Error("out/plan.json がありません。先に `lme2harness plan` を実行してください");
  const statePath = join(out, "apply-state.json");
  const state = readJsonFile<ApplyState>(statePath) ?? { done: [], updated_at: "" };
  const d1 = d1Options(env, opts.local);
  const start = Math.max(1, opts.from ?? 1);
  const parallel = Math.max(1, Math.floor(opts.parallel ?? 1));
  log.info(`${manifest.chunks.length} ファイルを D1「${d1.databaseName}」(${opts.local ? "local" : "remote"}) へ流します${parallel > 1 ? `（同じ表は ${parallel} 本同時）` : ""}`);
  const items = manifest.chunks.map((chunk, i) => ({ n: i + 1, table: chunk.table, chunk })).filter((it) => it.n >= start);
  await runInTableGroups(items, parallel, async ({ n, chunk }) => {
    const label = `[${n}/${manifest.chunks.length}] ${chunk.file} (${chunk.table} ${chunk.statements}文)`;
    if (opts.dryRun) {
      log.info(`  (dry-run) ${label}`);
      return;
    }
    const key = `${chunk.file}:${createHash("sha1").update(readFileSync(join(out, chunk.file))).digest("hex").slice(0, 16)}`;
    if (state.done.includes(key) && !opts.from) {
      log.info(`  済 ${label}`);
      return;
    }
    log.info(`  → ${label}`);
    await execute(join(out, chunk.file), d1);
    // 同時に終わっても state の書き換えは 1 つずつ（JS は 1 スレッド）
    state.done = state.done.filter((d) => d !== chunk.file && !d.startsWith(`${chunk.file}:`));
    state.done.push(key);
    state.updated_at = new Date().toISOString();
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  });
  if (!opts.dryRun) log.info("完了。次は `lme2harness verify`");
}
