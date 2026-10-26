import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_FILE, loadConfig, loadSecrets } from "../config.js";
import { HarnessApi } from "../harness/api.js";
import { LmeMcpClient } from "../lme/mcp-client.js";
import { LmePublicApi } from "../lme/public-api.js";
import { d1Query } from "../d1/wrangler.js";
import { d1Options, loadEnv } from "./shared.js";
import { TOKEN_PATH } from "./login.js";
import * as log from "../log.js";
import type { SourceBot } from "../source/types.js";

/**
 * 移行を始める前の点検。上から順に、つまずきやすい所を1つずつ確かめて
 * ✗ のときは「何をすればいいか」を出す。データは書き換えない。
 */
export interface Check {
  label: string;
  ok: boolean;
  detail?: string;
  hint?: string;
  /** false なら ✗ でも移行は進められる（任意項目） */
  required?: boolean;
}

export async function runDoctor(): Promise<Check[]> {
  const checks: Check[] = [];
  const push = (c: Check) => {
    checks.push(c);
    const mark = c.ok ? "✓" : c.required === false ? "△" : "✗";
    log.info(`${mark} ${c.label}${c.detail ? `: ${c.detail}` : ""}`);
    if (!c.ok && c.hint) log.info(`    → ${c.hint}`);
  };

  const major = Number(process.versions.node.split(".")[0]);
  push({ label: "Node.js", ok: major >= 22, detail: process.versions.node, hint: "Node.js 22 以上を入れてください（https://nodejs.org/）" });

  if (!existsSync(resolve(process.cwd(), CONFIG_FILE))) {
    push({ label: "設定ファイル", ok: false, hint: "このフォルダで `lme2harness init` を実行してください" });
    return finish(checks);
  }
  const config = loadConfig();
  const secrets = loadSecrets();

  // ---- エルメ ----
  const mcp = new LmeMcpClient({ tokenPath: TOKEN_PATH() });
  let mcpOk = false;
  if (!mcp.hasToken()) {
    push({ label: "エルメ（MCP ログイン）", ok: false, required: false, hint: "`lme2harness login` でログインすると、ステップ配信の中身・フォーム・全期間の会話も移せます" });
  } else if (!config.lme_bot_id) {
    push({ label: "エルメ（移行元アカウント）", ok: false, hint: "`lme2harness login` をもう一度実行して移行元を選んでください" });
  } else {
    try {
      const res = await mcp.call<{ bots?: SourceBot[] }>("list_bots", {});
      const bot = (res.bots ?? []).find((b) => b.id === config.lme_bot_id);
      mcpOk = Boolean(bot);
      push({
        label: "エルメ（MCP）",
        ok: mcpOk,
        detail: bot ? `${bot.view_name ?? bot.id}・友だち ${bot.total_friend ?? "?"}人` : `bot_id ${config.lme_bot_id} が見えません`,
        hint: "`lme2harness login` をもう一度実行してください",
      });
    } catch (e) {
      push({ label: "エルメ（MCP）", ok: false, detail: (e as Error).message, hint: "ログインの期限切れなら `lme2harness login` をもう一度" });
    }
  }
  if (secrets.LME_API_KEY) {
    try {
      const api = new LmePublicApi({ apiKey: secrets.LME_API_KEY });
      await api.handlingStatuses();
      push({ label: "エルメ（公開 API キー）", ok: true });
    } catch (e) {
      push({ label: "エルメ（公開 API キー）", ok: false, required: mcpOk ? false : undefined, detail: (e as Error).message, hint: "エルメ管理画面 → 設定 → API設定 で発行し直して .env の LME_API_KEY に貼ってください" });
    }
  } else if (!mcpOk) {
    push({ label: "エルメへの接続", ok: false, hint: "`lme2harness login`（おすすめ）か、.env の LME_API_KEY のどちらかが必要です" });
  }

  // ---- L Harness ----
  if (!config.harness_url) {
    push({ label: "L Harness の URL", ok: false, hint: `${CONFIG_FILE} の harness_url に Worker の URL を入れるか、\`lme2harness init --harness-dir <L Harness のフォルダ>\`` });
  } else if (!secrets.HARNESS_API_KEY) {
    push({ label: "L Harness の API キー", ok: false, hint: ".env の HARNESS_API_KEY に貼ってください（create-line-harness の完了画面に出た API Key）" });
  } else {
    const api = new HarnessApi(config.harness_url, secrets.HARNESS_API_KEY);
    try {
      const accounts = (await api.lineAccounts()).filter((a) => a.isActive !== false);
      const ok = accounts.length >= 1;
      push({
        label: "L Harness",
        ok,
        detail: ok ? accounts.map((a) => a.name).join(" / ") : "LINE アカウントが未登録",
        hint: "create-line-harness のセットアップを最後まで済ませてください",
      });
      if (accounts.length > 1 && !config.harness_line_account_id) {
        push({ label: "L Harness の移行先アカウント", ok: false, hint: `${CONFIG_FILE} の harness_line_account_id に次のどれかを入れてください: ${accounts.map((a) => `${a.id}（${a.name}）`).join(", ")}` });
      }
    } catch (e) {
      const status = (e as { status?: number }).status;
      push({ label: "L Harness", ok: false, detail: (e as Error).message, hint: status === 401 ? "API キーが違います。.env の HARNESS_API_KEY を確認してください" : "harness_url が正しいか、Worker が動いているか確認してください" });
    }
  }

  // ---- D1（wrangler） ----
  if (!config.d1_database_name) {
    push({ label: "D1 データベース", ok: false, hint: `${CONFIG_FILE} の d1_database_name を入れるか、\`lme2harness init --harness-dir <L Harness のフォルダ>\`` });
  } else {
    try {
      const rows = await d1Query("SELECT COUNT(*) AS c FROM friends", d1Options(loadEnv()));
      push({ label: "D1 への書き込み権限（wrangler）", ok: true, detail: `${config.d1_database_name}・今の友だち ${rows[0]?.c ?? "?"}人` });
    } catch (e) {
      const msg = (e as Error).message;
      push({
        label: "D1 への書き込み権限（wrangler）",
        ok: false,
        detail: msg.split("\n")[0],
        hint: /auth|login|Authentication|10000/i.test(msg) ? "`npx wrangler login` で L Harness と同じ Cloudflare アカウントにログインしてください" : "harness_worker_dir（L Harness の apps/worker）と d1_database_name を確認してください",
      });
    }
  }
  return finish(checks);
}

function finish(checks: Check[]): Check[] {
  const ng = checks.filter((c) => !c.ok && c.required !== false);
  log.info("");
  if (ng.length) log.info(`✗ ${ng.length} 件を直してから進んでください`);
  else log.info("準備OKです。`lme2harness migrate` で移行を始められます");
  return checks;
}

export async function runDoctorCli(): Promise<void> {
  const checks = await runDoctor();
  if (checks.some((c) => !c.ok && c.required !== false)) process.exitCode = 1;
}
