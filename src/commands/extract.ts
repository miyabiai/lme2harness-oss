import { resolve } from "node:path";
import { loadConfig, loadSecrets, type Lme2HarnessConfig } from "../config.js";
import { LmeMcpClient } from "../lme/mcp-client.js";
import { LmePublicApi } from "../lme/public-api.js";
import { LmeSource } from "../lme/source.js";
import { SnapshotStore } from "../snapshot/store.js";
import { extractSnapshot } from "../snapshot/extract.js";
import { TOKEN_PATH } from "./login.js";
import * as log from "../log.js";
import type { LmeBot } from "../lme/types.js";

export async function buildSource(): Promise<{ source: LmeSource; bot: LmeBot; config: Lme2HarnessConfig }> {
  const config = loadConfig();
  const secrets = loadSecrets();
  const mcp = new LmeMcpClient({ tokenPath: TOKEN_PATH() });
  const hasMcp = mcp.hasToken() && Boolean(config.lme_bot_id);
  const api = secrets.LME_API_KEY ? new LmePublicApi({ apiKey: secrets.LME_API_KEY }) : undefined;
  if (!hasMcp && !api) {
    throw new Error("エルメへの接続手段がありません。`lme2harness login`（MCP）か .env の LME_API_KEY のどちらかを用意してください");
  }
  const source = new LmeSource({ mcp: hasMcp ? mcp : undefined, api, botId: hasMcp ? config.lme_bot_id : undefined });
  let bot: LmeBot = { id: config.lme_bot_id ?? "" };
  if (hasMcp) {
    const bots = await source.listBots();
    const hit = bots.find((b) => b.id === config.lme_bot_id);
    if (!hit) throw new Error(`lme_bot_id "${config.lme_bot_id}" はこの MCP ログインから見えません。\`lme2harness login\` の一覧を確認してください`);
    bot = hit;
  }
  log.info(`接続: MCP=${hasMcp ? "あり" : "なし"} / 公開API=${api ? "あり" : "なし"}${bot.view_name ? ` / bot=${bot.view_name}` : ""}`);
  return { source, bot, config };
}

export async function runExtract(opts: { resume: boolean; messages: boolean; only?: "masters" | "friends"; limit?: number }): Promise<void> {
  const { source, bot, config } = await buildSource();
  const store = new SnapshotStore(resolve(process.cwd(), config.snapshot_dir));
  const meta = await extractSnapshot(source, store, bot, {
    resume: opts.resume,
    messages: opts.messages && config.options.messages,
    messagesFrom: config.options.messages_from,
    only: opts.only,
    limitFriends: opts.limit,
  });
  log.info("");
  log.info(`取り出し完了: 友だち ${store.friendCount()}人 → ${config.snapshot_dir}`);
  for (const n of meta.notes) log.info(`  注: ${n}`);
  log.info("次は `lme2harness plan`");
}
