#!/usr/bin/env node
import { Command } from "commander";
import { setVerbose, fail } from "./log.js";
import { runInit } from "./commands/init.js";
import { runLogin } from "./commands/login.js";
import { runExtract } from "./commands/extract.js";
import { runPlan } from "./commands/plan.js";
import { runApply } from "./commands/apply.js";
import { runVerify } from "./commands/verify.js";
import { runEnrich } from "./commands/enrich.js";
import { runBridge } from "./commands/bridge.js";
import { runDoctorCli } from "./commands/doctor.js";
import { runMigrate } from "./commands/migrate.js";
import { runRichMenu } from "./commands/richmenu.js";
import { runKeys } from "./commands/keys.js";
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();
program
  .name("lme2harness")
  .description("L Message（エルメ）から L Harness へ顧客データを移行し、並行運用ブリッジを用意する")
  .version(pkg.version)
  .option("-v, --verbose", "詳細ログ")
  .hook("preAction", (cmd) => setVerbose(Boolean(cmd.opts().verbose)));

program
  .command("init")
  .description("設定ファイル（lme2harness.config.json）と .env の雛形を作る")
  .option("--harness-url <url>", "L Harness Worker の URL")
  .option("--bot-id <id>", "エルメの bot_id（MCP）")
  .option("--harness-dir <path>", "L Harness の導入フォルダ（既定は自動で探す: ./line-harness, ~/.line-harness など）")
  .option("-y, --yes", "質問しない（API キーの入力を飛ばす）")
  .action((o) => runInit(o).catch(onError));

program
  .command("keys [names...]")
  .description("API キーなどの秘密の値を貼るため、.env をテキストエディット（Windows はメモ帳）で開き、保存されるまで待つ（値は表示しない）")
  .option("--for <stage>", "段階で選ぶ: migrate（L Harness の API キー）/ bridge（チャネルシークレット・署名シークレット）")
  .option("--no-wait", "開くだけで待たない")
  .option("--no-editor", "エディタを開かない（.env を書き直して待つだけ）")
  .option("--timeout <sec>", "待つ秒数（既定 600）", (v) => Number(v))
  .action((names: string[], o) => runKeys({ ...o, names }).catch(onError));

program
  .command("login")
  .description("エルメ公式 MCP にブラウザでログインし、移行元の LINE アカウントを設定する")
  .option("--bot-id <id>", "移行元の bot_id（複数あるとき）")
  .action((o) => runLogin(o).catch(onError));

program
  .command("doctor")
  .description("移行の準備ができているか点検する（何も書き換えない）")
  .action(() => runDoctorCli().catch(onError));

program
  .command("migrate")
  .description("点検 → 取り出し → 変換 → 投入 → 照合 → アイコン取得 をまとめて実行する")
  .option("-y, --yes", "投入前の確認を省く")
  .option("--no-enrich", "アイコン・表示名の取得をしない")
  .option("--no-messages", "会話履歴を移さない")
  .option("--no-richmenu", "リッチメニューを取り込まない")
  .option("--no-resume", "取り出し済みのデータを使わず全部取り直す")
  .action((o) => runMigrate(o).catch(onError));

program
  .command("extract")
  .description("エルメから全データをスナップショット（./snapshot）に取り出す。途中で止めても再開できる")
  .option("--no-resume", "保存済みを無視して全件取り直す")
  .option("--no-messages", "会話履歴を取らない")
  .option("--only <what>", "masters または friends だけ")
  .option("--limit <n>", "友だち数の上限（動作確認用）", (v) => Number(v))
  .action((o) => runExtract(o).catch(onError));

program
  .command("plan")
  .description("スナップショットを L Harness の行に変換し、SQL とレポート（./out）を作る")
  .option("--line-account-id <id>", "L Harness 側の line_accounts.id")
  .option("--local-schema <path>", "検証用: L Harness の packages/db/bootstrap.sql を指定するとローカル SQLite で流して検査する")
  .action((o) => runPlan(o).catch(onError));

program
  .command("apply")
  .description("生成した SQL を D1 に流す（wrangler d1 execute --remote）")
  .option("--local", "--remote ではなく --local に流す")
  .option("--dry-run", "実行せず対象ファイルだけ表示")
  .option("--from <n>", "n 番目のチャンクから再開", (v) => Number(v))
  .action((o) => runApply(o).catch(onError));

program
  .command("verify")
  .description("D1 の件数とスナップショットを突き合わせる")
  .option("--local", "ローカル D1 を見る")
  .action((o) => runVerify(o).catch(onError));

program
  .command("enrich")
  .description("LINE プロフィール（アイコン・表示名・ステータス）を L Harness 経由で取り直す")
  .option("--limit <n>", "1回あたりの人数（既定20。有料プランなら増やせる）", (v) => Number(v))
  .action((o) => runEnrich(o).catch(onError));

program
  .command("richmenu")
  .description("エルメのリッチメニューを L Harness の管理画面に取り込む（LINE 上の表示は変えない）")
  .option("--dry-run", "取り込まずに対応だけ表示")
  .action((o) => runRichMenu(o).catch(onError));

program
  .command("bridge")
  .description("並行運用ブリッジ（Cloudflare Worker）の設定値を生成し、エルメ側に貼る URL を表示する")
  .option("--deploy", "wrangler deploy まで実行する")
  .action((o) => runBridge(o).catch(onError));

function onError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  return fail(msg);
}

program.parseAsync(process.argv);
