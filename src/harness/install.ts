import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * create-line-harness が作った L Harness の導入フォルダを探し、設定値を読む。
 *
 * create-line-harness はセットアップ完了時に `<導入フォルダ>/.line-harness-config.json` を書く
 * （既定の導入先は ~/.line-harness）。古い版や手動導入では無いことがあるので、
 * `apps/worker/wrangler.toml` からも読めるようにしておく。
 */
export interface HarnessInstall {
  dir: string;
  workerUrl?: string;
  workerName?: string;
  d1DatabaseName?: string;
  d1DatabaseId?: string;
  accountId?: string;
  adminUrl?: string;
  version?: string;
  /** どこから読んだか（表示用） */
  source: string;
}

interface SavedConfig {
  workerUrl?: string;
  workerPublicUrl?: string;
  workerName?: string;
  projectName?: string;
  d1DatabaseName?: string;
  d1DatabaseId?: string;
  accountId?: string;
  cfAccountId?: string;
  adminUrl?: string;
  adminPublicUrl?: string;
  installedVersion?: string;
}

/** 探す順: 指定フォルダ → 今いるフォルダとその親 → ~/.line-harness */
export function candidateDirs(explicit?: string, cwd = process.cwd(), home = homedir()): string[] {
  if (explicit) return [resolve(cwd, explicit)];
  const dirs = [cwd, resolve(cwd, ".."), resolve(cwd, "line-harness"), resolve(cwd, "line-harness-oss")];
  if (home) dirs.push(join(home, ".line-harness"));
  return [...new Set(dirs)];
}

export function findHarnessInstall(explicit?: string, cwd = process.cwd(), home = homedir()): HarnessInstall | null {
  for (const dir of candidateDirs(explicit, cwd, home)) {
    const hit = readHarnessInstall(dir);
    if (hit) return hit;
  }
  return null;
}

export function readHarnessInstall(dir: string): HarnessInstall | null {
  const configPath = join(dir, ".line-harness-config.json");
  const tomlPath = join(dir, "apps", "worker", "wrangler.toml");
  const fromToml = existsSync(tomlPath) ? parseWranglerToml(readFileSync(tomlPath, "utf8")) : null;
  if (existsSync(configPath)) {
    let saved: SavedConfig;
    try {
      saved = JSON.parse(readFileSync(configPath, "utf8")) as SavedConfig;
    } catch {
      saved = {};
    }
    return {
      dir,
      workerUrl: saved.workerPublicUrl || saved.workerUrl || fromToml?.workerUrl,
      workerName: saved.workerName || saved.projectName || fromToml?.workerName,
      d1DatabaseName: saved.d1DatabaseName || fromToml?.d1DatabaseName,
      d1DatabaseId: saved.d1DatabaseId || fromToml?.d1DatabaseId,
      accountId: saved.cfAccountId || saved.accountId || fromToml?.accountId,
      adminUrl: saved.adminPublicUrl || saved.adminUrl || fromToml?.adminUrl,
      version: saved.installedVersion,
      source: configPath,
    };
  }
  if (fromToml && (fromToml.d1DatabaseName || fromToml.workerName)) return { dir, ...fromToml, source: tomlPath };
  return null;
}

/** wrangler.toml から必要な値だけ拾う（TOML の完全な解釈はしない）。 */
export function parseWranglerToml(text: string): Omit<HarnessInstall, "dir" | "source"> {
  const out: Omit<HarnessInstall, "dir" | "source"> = {};
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (sec) {
      section = sec[1];
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (section === "" && k === "name") out.workerName = v;
    else if (section === "" && k === "account_id") out.accountId = v;
    else if (section === "d1_databases" && k === "database_name" && !out.d1DatabaseName) out.d1DatabaseName = v;
    else if (section === "d1_databases" && k === "database_id" && !out.d1DatabaseId) out.d1DatabaseId = v;
    else if (section === "vars" && k === "WORKER_PUBLIC_URL") out.workerUrl = v;
    else if (section === "vars" && k === "ADMIN_PUBLIC_URL") out.adminUrl = v;
    else if (section === "vars" && k === "CF_ACCOUNT_ID" && !out.accountId) out.accountId = v;
  }
  return out;
}
