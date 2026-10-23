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

export async function runApply(opts: { local?: boolean; dryRun?: boolean; from?: number }): Promise<void> {
  const env = loadEnv();
  const out = outDir(env);
  const manifest = readJsonFile<PlanManifest>(join(out, "plan.json"));
  if (!manifest) throw new Error("out/plan.json がありません。先に `lme2harness plan` を実行してください");
  const statePath = join(out, "apply-state.json");
  const state = readJsonFile<ApplyState>(statePath) ?? { done: [], updated_at: "" };
  const d1 = d1Options(env, opts.local);
  const start = Math.max(1, opts.from ?? 1);
  log.info(`${manifest.chunks.length} ファイルを D1「${d1.databaseName}」(${opts.local ? "local" : "remote"}) へ流します`);
  let n = 0;
  for (const chunk of manifest.chunks) {
    n += 1;
    if (n < start) continue;
    const label = `[${n}/${manifest.chunks.length}] ${chunk.file} (${chunk.table} ${chunk.statements}文)`;
    if (opts.dryRun) {
      log.info(`  (dry-run) ${label}`);
      continue;
    }
    const key = `${chunk.file}:${createHash("sha1").update(readFileSync(join(out, chunk.file))).digest("hex").slice(0, 16)}`;
    if (state.done.includes(key) && !opts.from) {
      log.info(`  済 ${label}`);
      continue;
    }
    log.info(`  → ${label}`);
    await d1ExecuteFile(join(out, chunk.file), d1);
    state.done = state.done.filter((d) => d !== chunk.file && !d.startsWith(`${chunk.file}:`));
    state.done.push(key);
    state.updated_at = new Date().toISOString();
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  if (!opts.dryRun) log.info("完了。次は `lme2harness verify`");
}
