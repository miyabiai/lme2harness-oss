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

/** ファイル名の先頭番号（NN_）を外した形。古い連番の名前で記録した流し済みとも突き合わせられるようにする */
function chunkBase(file: string): string {
  return file.replace(/(^|\/)\d+_/, "$1");
}

/** state.done に「同じファイル（番号違いも可）・同じ中身」の記録があるか */
export function isChunkDone(done: string[], file: string, hash: string): boolean {
  const want = `${chunkBase(file)}:${hash}`;
  return done.some((d) => chunkBase(d) === want);
}

/** 同じファイル（番号違いも可）の古い記録を消して、新しい記録を足す */
export function recordChunkDone(done: string[], file: string, hash: string): string[] {
  const base = chunkBase(file);
  return [...done.filter((d) => chunkBase(d) !== base && !chunkBase(d).startsWith(`${base}:`)), `${file}:${hash}`];
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
    const hash = createHash("sha1").update(readFileSync(join(out, chunk.file))).digest("hex").slice(0, 16);
    if (isChunkDone(state.done, chunk.file, hash) && !opts.from) {
      log.info(`  済 ${label}`);
      continue;
    }
    log.info(`  → ${label}`);
    await d1ExecuteFile(join(out, chunk.file), d1);
    state.done = recordChunkDone(state.done, chunk.file, hash);
    state.updated_at = new Date().toISOString();
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  if (!opts.dryRun) log.info("完了。次は `lme2harness verify`");
}
