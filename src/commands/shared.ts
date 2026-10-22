import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig, loadSecrets, type Lme2HarnessConfig, type Secrets } from "../config.js";
import { HarnessApi } from "../harness/api.js";
import type { WranglerD1Options } from "../d1/wrangler.js";
import * as log from "../log.js";

export interface Env {
  config: Lme2HarnessConfig;
  secrets: Secrets;
  harness?: HarnessApi;
}

export function loadEnv(): Env {
  const config = loadConfig();
  const secrets = loadSecrets();
  const harness = config.harness_url && secrets.HARNESS_API_KEY ? new HarnessApi(config.harness_url, secrets.HARNESS_API_KEY) : undefined;
  return { config, secrets, harness };
}

export function requireHarness(env: Env): HarnessApi {
  if (!env.harness) throw new Error("harness_url（lme2harness.config.json）と HARNESS_API_KEY（.env）の両方が必要です");
  return env.harness;
}

/** L Harness 側の対象アカウント ID を決める（指定 → 設定 → API で 1 件なら自動）。 */
export async function resolveLineAccountId(env: Env, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (env.config.harness_line_account_id) return env.config.harness_line_account_id;
  if (!env.harness) throw new Error("harness_line_account_id が未設定です。lme2harness.config.json に書くか、harness_url と HARNESS_API_KEY を設定してください");
  const accounts = await env.harness.lineAccounts();
  const active = accounts.filter((a) => a.isActive !== false);
  if (active.length === 1) {
    log.info(`L Harness のアカウント「${active[0].name}」(${active[0].channelId}) を対象にします`);
    return active[0].id;
  }
  if (!active.length) throw new Error("L Harness に LINE アカウントが登録されていません。先に create-line-harness でセットアップしてください");
  const list = active.map((a) => `  ${a.id}  ${a.name} (${a.channelId})`).join("\n");
  throw new Error(`L Harness に複数のアカウントがあります。--line-account-id で選んでください:\n${list}`);
}

export function d1Options(env: Env, local = false): WranglerD1Options {
  const name = env.config.d1_database_name;
  if (!name) throw new Error("d1_database_name（lme2harness.config.json）が未設定です。create-line-harness が作った D1 の名前を入れてください");
  const cwd = env.config.harness_worker_dir ? resolve(process.cwd(), env.config.harness_worker_dir) : undefined;
  if (cwd && !existsSync(cwd)) throw new Error(`harness_worker_dir が見つかりません: ${cwd}`);
  return { databaseName: name, cwd, remote: !local, env: cloudflareEnv(env.secrets) };
}

/** wrangler に渡す Cloudflare の認証情報（.env にあるものだけ）。無ければ wrangler 自身のログインを使う。 */
export function cloudflareEnv(secrets: Secrets): Record<string, string> {
  const vars: Record<string, string> = {};
  if (secrets.CLOUDFLARE_API_TOKEN) vars.CLOUDFLARE_API_TOKEN = secrets.CLOUDFLARE_API_TOKEN;
  if (secrets.CLOUDFLARE_ACCOUNT_ID) vars.CLOUDFLARE_ACCOUNT_ID = secrets.CLOUDFLARE_ACCOUNT_ID;
  return vars;
}

export function outDir(env: Env): string {
  return resolve(process.cwd(), env.config.out_dir);
}

export function snapshotDir(env: Env): string {
  return resolve(process.cwd(), env.config.snapshot_dir);
}
