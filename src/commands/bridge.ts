import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { cloudflareEnv, loadEnv, requireHarness } from "./shared.js";
import { localWranglerCommand } from "../d1/wrangler.js";
import { readJsonFile } from "../util.js";
import * as log from "../log.js";

/** 再生成前の旧シークレットを受け付ける時間（エルメの推奨は約2分） */
const PREVIOUS_SECRET_GRACE_MS = 2 * 60 * 1000;

interface BridgeState {
  path_token_line: string;
  path_token_lmessage: string;
  worker_name: string;
  created_at: string;
}

function token(): string {
  // 48 文字の英数字（推測されない受信パス）
  return randomBytes(36).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 48).padEnd(48, "x");
}

function packagedBridgeDir(): string {
  // dist/commands/bridge.js → ../../bridge
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bridge");
}

async function run(cmd: string, args: string[], cwd: string, input?: string, env?: Record<string, string>): Promise<void> {
  await new Promise<void>((resolveP, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"], env: { ...process.env, ...(env ?? {}) }, shell: process.platform === "win32" });
    if (input !== undefined) {
      child.stdin!.write(input);
      child.stdin!.end();
    }
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolveP() : reject(new Error(`${cmd} ${args.join(" ")} が失敗しました (exit ${code})`))));
  });
}

/**
 * 並行運用ブリッジ:
 * 1. ./bridge に Worker 一式をコピー（初回）
 * 2. wrangler.toml を生成（HARNESS_URL・D1 database_id）
 * 3. 受信パスのトークンを作って .lme2harness/bridge.json に保存
 * 4. --deploy なら wrangler deploy ＋ secret 登録
 * 5. エルメ「Webhook転送」画面に貼る URL を表示
 */
export async function runBridge(opts: { deploy?: boolean }): Promise<void> {
  const env = loadEnv();
  const cwd = process.cwd();
  const bridgeDir = join(cwd, "bridge");
  if (!existsSync(join(bridgeDir, "src", "index.ts"))) {
    const src = packagedBridgeDir();
    if (!existsSync(join(src, "src", "index.ts"))) throw new Error(`ブリッジの雛形が見つかりません: ${src}`);
    mkdirSync(bridgeDir, { recursive: true });
    cpSync(src, bridgeDir, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes(".wrangler") && !p.endsWith("wrangler.toml") });
    log.info("./bridge に Worker の雛形をコピーしました");
  }
  const statePath = join(cwd, ".lme2harness", "bridge.json");
  let state = readJsonFile<BridgeState>(statePath);
  if (!state) {
    state = { path_token_line: token(), path_token_lmessage: token(), worker_name: env.config.bridge_worker_name ?? "lme2harness-bridge", created_at: new Date().toISOString() };
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  if (!env.config.harness_url) throw new Error("harness_url（lme2harness.config.json）が未設定です");
  if (!env.config.d1_database_id) throw new Error("d1_database_id（lme2harness.config.json）が未設定です。L Harness の apps/worker/wrangler.toml の database_id を入れてください");

  const harnessWorker = env.config.harness_worker_name ?? new URL(env.config.harness_url).hostname.split(".")[0];
  const toml = `# lme2harness bridge（自動生成。直したいときは lme2harness bridge を再実行）
name = "${state.worker_name}"
main = "src/index.ts"
compatibility_date = "2025-01-01"
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "${env.config.d1_database_name ?? "line-harness"}"
database_id = "${env.config.d1_database_id}"

# L Harness へのサービス連携（同じアカウントの Worker を workers.dev の URL で呼ぶとエラー1042で遮断されるため）
[[services]]
binding = "HARNESS"
service = "${harnessWorker}"

[vars]
HARNESS_URL = "${env.config.harness_url}"
STRIP_REPLY_TOKEN = "1"
SYNC_FRIEND_INFO = "1"
MAX_CLOCK_SKEW_SECONDS = "300"
`;
  writeFileSync(join(bridgeDir, "wrangler.toml"), toml);

  if (opts.deploy) {
    requireHarness(env);
    const channelSecret = env.secrets.LINE_CHANNEL_SECRET;
    if (!channelSecret) throw new Error("LINE_CHANNEL_SECRET（.env）が空です。`lme2harness keys --for bridge` でテキストエディットを開き、LINE Developers の Messaging API チャネルのシークレットを貼ってください");
    const extra = env.secrets.LME_WEBHOOK_SECRET ?? "";
    if (!extra) log.warn("LME_WEBHOOK_SECRET（.env）が空です。エルメの「Webhook転送」画面のシークレットを貼ってから再実行すると L Message 転送も受けられます");
    const cfEnv = cloudflareEnv(env.secrets);
    const wr = localWranglerCommand(bridgeDir);
    log.info("wrangler deploy 中…");
    await run(wr[0], [...wr.slice(1), "deploy"], bridgeDir, undefined, cfEnv);
    const secrets: Record<string, string | undefined> = {
      LINE_CHANNEL_SECRET: channelSecret,
      HARNESS_API_KEY: env.secrets.HARNESS_API_KEY,
      LME_WEBHOOK_SECRET: extra || undefined,
      LME_API_KEY: env.secrets.LME_API_KEY,
      PATH_TOKEN_LINE: state.path_token_line,
      PATH_TOKEN_LMESSAGE: state.path_token_lmessage,
    };
    for (const [k, v] of Object.entries(secrets)) {
      if (!v) continue;
      log.info(`  secret ${k}`);
      await run(wr[0], [...wr.slice(1), "secret", "put", k], bridgeDir, v, cfEnv);
    }
    // シークレットを再生成した直後は、エルメが最大約1分は旧シークレットで送ってくる。
    // 旧シークレットは「新しいシークレットを登録した時刻＋2分」だけ受け付ける
    const previous = env.secrets.LME_WEBHOOK_SECRET_PREVIOUS;
    if (previous && extra) {
      log.info("  secret LME_WEBHOOK_SECRET_PREVIOUS（2分だけ有効）");
      await run(wr[0], [...wr.slice(1), "secret", "put", "LME_WEBHOOK_SECRET_PREVIOUS"], bridgeDir, previous, cfEnv);
      await run(wr[0], [...wr.slice(1), "secret", "put", "LME_WEBHOOK_SECRET_PREVIOUS_UNTIL"], bridgeDir, String(Date.now() + PREVIOUS_SECRET_GRACE_MS), cfEnv);
      log.info("  旧シークレットは2分後に自動で断るようになります。.env の LME_WEBHOOK_SECRET_PREVIOUS は消してください");
    }
  }

  let sub = "<あなたのサブドメイン>";
  if (env.secrets.CLOUDFLARE_API_TOKEN && env.secrets.CLOUDFLARE_ACCOUNT_ID) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.secrets.CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`, {
        headers: { Authorization: `Bearer ${env.secrets.CLOUDFLARE_API_TOKEN}` },
      });
      const j = (await r.json()) as { result?: { subdomain?: string } };
      if (j.result?.subdomain) sub = j.result.subdomain;
    } catch {
      /* 取れなければ置き換え文字のまま */
    }
  }
  const base = `https://${state.worker_name}.${sub}.workers.dev`;
  const lineUrl = `${base}/lme/line/${state.path_token_line}`;
  const lmessageUrl = `${base}/lme/lmessage/${state.path_token_lmessage}`;
  const urlsPath = join(cwd, ".lme2harness", "bridge-urls.txt");
  writeFileSync(urlsPath, `LINE公式アカウントデータ転送: ${lineUrl}\nL Messageデータ転送: ${lmessageUrl}\n`, { mode: 0o600 });
  log.info("");
  log.info(`エルメの「Webhook転送」画面に貼る URL（${urlsPath} にも保存しました）:`);
  log.info(`  LINE公式アカウントデータ転送: ${lineUrl}`);
  log.info(`  L Messageデータ転送:         ${lmessageUrl}`);
  log.info("");
  log.info("注意: 有効化から約1分は反映されません。L Message 転送はシークレットを .env の LME_WEBHOOK_SECRET に貼ってから `lme2harness bridge --deploy` を再実行してください");
}
