import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { cloudflareEnv, loadEnv, requireHarness } from "./shared.js";
import type { Lme2HarnessConfig } from "../config.js";
import { localWranglerCommand, wranglerEnv } from "../d1/wrangler.js";
import { readJsonFile } from "../util.js";
import * as log from "../log.js";

/** 再生成前の旧シークレットを受け付ける時間（エルメの推奨は約2分） */
const PREVIOUS_SECRET_GRACE_MS = 2 * 60 * 1000;

export interface BridgeState {
  path_token_line: string;
  path_token_lmessage: string;
  worker_name: string;
  /** どの移行先向けのブリッジか（別の移行先のつなぎ先で配備し直して、先の転送を壊さないため）。古い版で作った状態には無い */
  target?: string;
  created_at: string;
}

/** ブリッジの Worker 名。同じ Cloudflare アカウントにほかのフォルダから配備したブリッジと重ならないよう、フォルダごとに末尾を変える */
function bridgeWorkerName(): string {
  return `lme2harness-bridge-${randomBytes(4).toString("hex")}`;
}

function bridgeTarget(config: Lme2HarnessConfig): string {
  return `${config.d1_database_id ?? config.d1_database_name ?? "-"}:${(config.harness_url ?? "-").replace(/\/+$/, "")}`;
}

/** 前に配備した wrangler.toml から、その時の移行先（D1・L Harness の URL）を読む */
function previousTarget(previousToml: string | null): string | null {
  if (!previousToml) return null;
  const id = previousToml.match(/^database_id\s*=\s*"([^"]*)"/m)?.[1];
  const url = previousToml.match(/^HARNESS_URL\s*=\s*"([^"]*)"/m)?.[1];
  return id && url ? `${id}:${url.replace(/\/+$/, "")}` : null;
}

/** ブリッジの状態を保存する（本人だけが読める権限で） */
export function saveBridgeState(statePath: string, state: BridgeState): void {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * このフォルダのブリッジの状態（受信パスのトークン・Worker 名）を読み、無ければ作る。
 * 前に作った状態は Worker 名・トークンを変えない（エルメに貼った URL がそのまま使えるように）。
 * 移行先を記録する前の版で作った状態は、前の wrangler.toml の移行先と照らし合わせる。
 * トークンを作り直すときは保存しない（配備が終わってから saveBridgeState で保存する。途中で失敗しても前の URL のまま使えるように）。
 */
export function prepareBridgeState(
  statePath: string,
  config: Lme2HarnessConfig,
  opts: { deploy?: boolean; rotateToken?: boolean; previousToml?: string | null } = {},
): BridgeState {
  let state = readJsonFile<BridgeState>(statePath);
  const target = bridgeTarget(config);
  const recorded = state ? (state.target ?? previousTarget(opts.previousToml ?? null)) : null;
  if (recorded && recorded !== target) {
    throw new Error("このフォルダのブリッジは、別の移行先（L Harness・D1）向けに作ったものです。配備し直すと先の転送が止まるので止めました。別の移行先には別のフォルダで用意してください");
  }
  if (state && opts.rotateToken) {
    if (!opts.deploy) throw new Error("--rotate-token は --deploy と一緒に使ってください（配備した Worker のトークンを入れ替えないと、前の URL が使えたままになります）");
    return { ...state, target, path_token_line: token(), path_token_lmessage: token() };
  }
  if (!state) state = { path_token_line: token(), path_token_lmessage: token(), worker_name: config.bridge_worker_name ?? bridgeWorkerName(), created_at: new Date().toISOString() };
  state.target ??= target;
  saveBridgeState(statePath, state);
  return state;
}

/** 前に配備した wrangler.toml の重複排除（KV）の設定を引き継ぐ（コメントにした設定は引き継がない） */
export function keptKvBlock(previous: string | null): string {
  if (!previous) return "";
  const blocks = [...previous.matchAll(/^\[\[kv_namespaces\]\][^\n]*(?:\n(?!\s*\[)[^\n]*)*/gm)].map((m) => m[0].trim());
  return blocks.length ? `\n${blocks.join("\n\n")}\n` : "";
}

/** ./bridge に置く Worker 一式（同梱の雛形からの相対パス）。wrangler.toml はこのツールが毎回作る */
function templateFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".wrangler" ? [] : templateFiles(full, base);
    return e.name === "wrangler.toml" ? [] : [relative(base, full)];
  });
}

/**
 * 同梱の Worker 一式を ./bridge に入れる。前の版で入れたものと中身が違うファイルは、
 * 控え（backupDir）に移してから新しくする（直した Worker が、配備し直したときに届くように）。
 * 新しくしたファイル（前から有ったもの）の一覧を返す。
 */
export function syncBridgeTemplate(src: string, bridgeDir: string, backupDir: string): string[] {
  const updated: string[] = [];
  for (const rel of templateFiles(src)) {
    const from = join(src, rel);
    const to = join(bridgeDir, rel);
    const next = readFileSync(from);
    if (existsSync(to)) {
      const current = readFileSync(to);
      if (current.equals(next)) continue;
      mkdirSync(dirname(join(backupDir, rel)), { recursive: true });
      writeFileSync(join(backupDir, rel), current);
      updated.push(rel);
    }
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, next);
  }
  return updated;
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
    // シェルは通さない（Windows でも localWranglerCommand が node で直接動かす）
    const child = spawn(cmd, args, { cwd, stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"], env: wranglerEnv(env) });
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
 * 3. 受信パスのトークンを作って .lme2harness/bridge.json に保存（--rotate-token で作り直す）
 * 4. --deploy なら wrangler deploy ＋ secret 登録
 * 5. エルメ「Webhook転送」画面に貼る URL を表示
 */
export async function runBridge(opts: { deploy?: boolean; rotateToken?: boolean }): Promise<void> {
  const env = loadEnv();
  const cwd = process.cwd();
  const bridgeDir = join(cwd, "bridge");
  const src = packagedBridgeDir();
  if (!existsSync(join(src, "src", "index.ts"))) throw new Error(`ブリッジの雛形が見つかりません: ${src}`);
  if (!env.config.harness_url) throw new Error("harness_url（lme2harness.config.json）が未設定です");
  if (!env.config.d1_database_id) throw new Error("d1_database_id（lme2harness.config.json）が未設定です。L Harness の apps/worker/wrangler.toml の database_id を入れてください");

  const tomlPath = join(bridgeDir, "wrangler.toml");
  const previousToml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : null;
  const statePath = join(cwd, ".lme2harness", "bridge.json");
  const state = prepareBridgeState(statePath, env.config, { ...opts, previousToml });
  if (opts.rotateToken) log.info("受信パスのトークンを作り直します。配備が終わると前の URL は使えなくなります");
  // 設定・移行先を確かめてから ./bridge を書き換える
  const fresh = !existsSync(join(bridgeDir, "src", "index.ts"));
  const backupDir = join(cwd, ".lme2harness", "bridge-backup", new Date().toISOString().replace(/[:.]/g, "-"));
  const updated = syncBridgeTemplate(src, bridgeDir, backupDir);
  if (fresh) log.info("./bridge に Worker の雛形をコピーしました");
  else if (updated.length) {
    log.info(`./bridge の Worker を、このツールの版に合わせて新しくしました（${updated.join("・")}）。前のものは ${relative(cwd, backupDir)} に控えています`);
    if (!opts.deploy) log.info("配備中の Worker を新しくするには `lme2harness bridge --deploy` を実行してください");
  }
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
  writeFileSync(tomlPath, toml + keptKvBlock(previousToml));

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
      // 作り直したトークンは、Worker に登録し始める直前に保存する（途中で止まっても、次の --deploy で同じトークンを登録し終えられるように）
      if (opts.rotateToken && k === "PATH_TOKEN_LINE") saveBridgeState(statePath, state);
      log.info(`  secret ${k}`);
      try {
        await run(wr[0], [...wr.slice(1), "secret", "put", k], bridgeDir, v, cfEnv);
      } catch (e) {
        if (opts.rotateToken && k.startsWith("PATH_TOKEN_")) {
          throw new Error(`${(e as Error).message}\nトークンの入れ替えが途中で止まりました。新しいトークンは保存してあるので、\`lme2harness bridge --deploy\`（--rotate-token なし）をもう一度実行して登録し終えてから、表示される URL をエルメに貼り直してください`);
        }
        throw e;
      }
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
