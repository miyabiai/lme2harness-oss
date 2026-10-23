import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILE, ENV_EXAMPLE, loadDotEnv, setDotEnvValue, updateConfig, type Lme2HarnessConfig } from "../config.js";
import { findHarnessInstall } from "../harness/install.js";
import { ask, interactive } from "../prompt.js";
import * as log from "../log.js";

/**
 * 設定ファイルと .env を用意する。
 * L Harness の導入フォルダ（create-line-harness の既定は ~/.line-harness）が見つかれば、
 * Worker URL・D1・wrangler の場所を自動で埋める。人が入れるのは API キーだけにする。
 */
export async function runInit(opts: { harnessUrl?: string; botId?: string; harnessDir?: string; yes?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const configPath = resolve(cwd, CONFIG_FILE);
  const existed = existsSync(configPath);

  const patch: Partial<Lme2HarnessConfig> = {};
  const install = findHarnessInstall(opts.harnessDir);
  if (install) {
    log.info(`L Harness の導入フォルダを見つけました: ${install.dir}${install.version ? `（v${install.version}）` : ""}`);
    if (install.workerUrl) patch.harness_url = install.workerUrl;
    if (install.workerName) patch.harness_worker_name = install.workerName;
    if (install.d1DatabaseName) patch.d1_database_name = install.d1DatabaseName;
    if (install.d1DatabaseId) patch.d1_database_id = install.d1DatabaseId;
    const workerDir = join(install.dir, "apps", "worker");
    if (existsSync(workerDir)) patch.harness_worker_dir = workerDir;
  } else {
    log.warn(
      opts.harnessDir
        ? `${opts.harnessDir} に L Harness の設定（.line-harness-config.json / apps/worker/wrangler.toml）が見つかりません`
        : "L Harness の導入フォルダが見つかりませんでした（~/.line-harness など）。--harness-dir で場所を指定できます",
    );
  }
  if (opts.harnessUrl) patch.harness_url = opts.harnessUrl;
  if (opts.botId) patch.lme_bot_id = opts.botId;

  const cfg = updateConfig(existed ? patch : { lme_bot_id: "", harness_url: "", harness_line_account_id: "", d1_database_name: "", harness_worker_dir: "", ...patch }, cwd);
  log.info(`${CONFIG_FILE} を${existed ? "更新" : "作成"}しました`);
  if (install) {
    log.info(`  harness_url       ${cfg.harness_url || "(未設定)"}`);
    log.info(`  d1_database_name  ${cfg.d1_database_name || "(未設定)"}`);
    log.info(`  harness_worker_dir ${cfg.harness_worker_dir || "(未設定)"}`);
  }

  const envPath = resolve(cwd, ".env");
  if (!existsSync(envPath)) {
    writeFileSync(envPath, ENV_EXAMPLE, { mode: 0o600 });
    log.info(".env を作りました（git には入れないでください）");
  }

  // API キーはセットアップ完了画面に一度だけ出る値。端末なら貼ってもらう（画面には出さない）
  if (!loadDotEnv(cwd).HARNESS_API_KEY && interactive() && !opts.yes) {
    const key = await ask("L Harness の API キーを貼ってください（セットアップ完了画面の「API Key」。Enter で後回し）: ", { secret: true });
    if (key) {
      setDotEnvValue("HARNESS_API_KEY", key, cwd);
      log.info(`  .env に HARNESS_API_KEY を保存しました（${key.length}文字）`);
    }
  }

  const missing: string[] = [];
  if (!cfg.harness_url) missing.push(`${CONFIG_FILE} の harness_url（L Harness Worker の URL）`);
  if (!cfg.d1_database_name) missing.push(`${CONFIG_FILE} の d1_database_name / d1_database_id`);
  if (!loadDotEnv(cwd).HARNESS_API_KEY) missing.push(".env の HARNESS_API_KEY");

  log.info("");
  log.info("次にやること:");
  let n = 1;
  if (missing.length) {
    log.info(`  ${n++}. 未設定の項目を埋める`);
    for (const m of missing) log.info(`       - ${m}`);
    if (!loadDotEnv(cwd).HARNESS_API_KEY) log.info("       （API キーは `lme2harness keys` でテキストエディットが開くので、そこに貼って保存）");
  }
  log.info(`  ${n++}. lme2harness login     … エルメにログイン（bot は自動で設定されます）`);
  log.info(`  ${n++}. lme2harness doctor    … 準備ができているか点検`);
  log.info(`  ${n++}. lme2harness migrate   … 取り出し → 変換 → 投入 → 照合 を一気に`);
}
