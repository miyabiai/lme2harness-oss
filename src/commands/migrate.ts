import { runDoctor } from "./doctor.js";
import { runExtract } from "./extract.js";
import { runPlan } from "./plan.js";
import { runApply } from "./apply.js";
import { runVerify } from "./verify.js";
import { runEnrich } from "./enrich.js";
import { runRichMenu } from "./richmenu.js";
import { confirm, interactive } from "../prompt.js";
import * as log from "../log.js";

/**
 * 点検 → 取り出し → 変換 → （確認）→ 投入 → 照合 → リッチメニュー取り込み → アイコン取得 を順に流す。
 * 各段は個別コマンドと同じ処理で、途中で止まっても同じコマンドで続きから再開できる。
 */
export async function runMigrate(opts: { yes?: boolean; enrich: boolean; messages: boolean; resume: boolean; richmenu: boolean; parallel?: number }): Promise<void> {
  step("1/7 点検");
  const checks = await runDoctor();
  if (checks.some((c) => !c.ok && c.required !== false)) throw new Error("点検で ✗ があります。上の → の案内どおり直してから、もう一度 `lme2harness migrate`");

  step("2/7 エルメから取り出し");
  await runExtract({ resume: opts.resume, messages: opts.messages });

  step("3/7 L Harness の形に変換");
  await runPlan({});

  step("4/7 L Harness へ投入");
  if (!opts.yes) {
    if (!interactive()) throw new Error("確認なしで書き込むには --yes を付けてください（out/report.md を読んでから）");
    log.info("out/report.md に「何が移るか・移らないか」が書いてあります。");
    log.info("シナリオ・自動応答・フォームは停止状態で入るので、エルメと二重に送られることはありません。");
    if (!(await confirm("L Harness の D1 に書き込みますか？"))) {
      log.info("中止しました。続きは `lme2harness apply` → `lme2harness verify` で再開できます");
      return;
    }
  }
  await runApply({ parallel: opts.parallel });

  step("5/7 照合");
  await runVerify({});

  if (opts.richmenu) {
    step("6/7 リッチメニューの取り込み");
    try {
      await runRichMenu({});
    } catch (e) {
      log.warn(`リッチメニューは取り込めませんでした（あとで \`lme2harness richmenu\` で再実行できます）: ${(e as Error).message}`);
    }
  }

  if (opts.enrich) {
    step("7/7 アイコン・表示名を LINE から取得");
    await runEnrich({});
  }

  log.info("");
  log.info("移行が終わりました。L Harness の管理画面で友だち・タグ・会話を確かめてください。");
  log.info("切り替えまでエルメと並行運用するなら、次は `lme2harness bridge --deploy`（README「並行運用ブリッジ」）");
}

function step(title: string): void {
  log.info("");
  log.info(`━━ ${title} ━━`);
}
