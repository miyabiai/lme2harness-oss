import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_FILE, loadConfig, updateConfig } from "../config.js";
import { LmeMcpClient, NeedsLogin } from "../lme/mcp-client.js";
import { ask, interactive } from "../prompt.js";
import * as log from "../log.js";
import type { LmeBot } from "../lme/types.js";

export const TOKEN_PATH = () => resolve(process.cwd(), ".lme2harness", "mcp-token.json");

/**
 * エルメ公式 MCP にブラウザでログインし、移行元の bot を設定ファイルに書く。
 * bot が1つならそれを、複数なら番号で選んでもらう（--bot-id で直接指定も可）。
 */
export async function runLogin(opts: { botId?: string; browser?: boolean; timeout?: number; relogin?: boolean } = {}): Promise<void> {
  const client = new LmeMcpClient({ tokenPath: TOKEN_PATH() });
  // 保存済みのトークンで list_bots が通るなら、ブラウザでのログインは省く（移行元の選び直しだけできる）
  let bots: LmeBot[] | null = null;
  if (client.hasToken() && !opts.relogin) {
    try {
      bots = (await client.call<{ bots?: LmeBot[] }>("list_bots", {})).bots ?? [];
      log.info("保存済みのログインが使えるので、ブラウザでのログインは省きます（やり直すときは --relogin）");
    } catch (e) {
      if (!(e instanceof NeedsLogin)) throw e;
      bots = null;
    }
  }
  if (!bots) {
    await client.login({ openBrowser: opts.browser !== false, timeoutMs: opts.timeout && opts.timeout > 0 ? opts.timeout * 1000 : undefined });
    bots = (await client.call<{ bots?: LmeBot[] }>("list_bots", {})).bots ?? [];
  }
  if (!bots.length) {
    log.warn("このログインで使える LINE アカウント（bot）が見つかりませんでした");
    return;
  }
  log.info("このログインで使える LINE アカウント:");
  bots.forEach((b, i) => log.info(`  ${i + 1}. ${b.view_name ?? ""}  ${b.line_id ?? ""}  友だち ${b.total_friend ?? "?"}人  (bot_id ${b.id})`));

  let chosen: LmeBot | undefined;
  if (opts.botId) {
    chosen = bots.find((b) => b.id === opts.botId);
    if (!chosen) throw new Error(`--bot-id ${opts.botId} はこのログインから見えません`);
  } else if (bots.length === 1) {
    chosen = bots[0];
  } else if (interactive()) {
    const a = await ask(`移行元の番号を選んでください (1-${bots.length}): `);
    chosen = bots[Number(a) - 1];
  }
  if (!chosen) {
    log.info(`移行元が決まっていません。\`lme2harness login --bot-id <bot_id>\` で選んでください（ログインは済んでいるのでブラウザは開きません）`);
    return;
  }
  if (!existsSync(resolve(process.cwd(), CONFIG_FILE))) {
    log.info(`移行元: ${chosen.view_name ?? chosen.id}。${CONFIG_FILE} が無いので書き込みません（先に \`lme2harness init\`）`);
    return;
  }
  const before = loadConfig().lme_bot_id;
  updateConfig({ lme_bot_id: chosen.id });
  log.info(`移行元を「${chosen.view_name ?? chosen.id}」に設定しました${before && before !== chosen.id ? `（前の設定 ${before} から変更）` : ""}`);
  log.info("次は `lme2harness doctor`");
}
