import { describe, expect, it } from "vitest";
import type { ScenarioStepsInfo } from "../src/mapping/context.js";
import type { SourceMessage } from "../src/source/types.js";
import { nextDeliveryAt, partMatches, restoreProgress } from "../src/mapping/scenario-progress.js";
import { parseSourceDate, toHarnessJst } from "../src/harness/time.js";

const NAME = "シナリオA";
const text = (s: string) => ({ message_type: "text", message_content: s });
const timing = (d: number, t: string) => ({ delay_minutes: 0, offset_days: d, offset_minutes: null, delivery_time: t });

// 1通目と4通目が同じ本文（実データにあった形）
const INFO: ScenarioStepsInfo = {
  name: NAME,
  deliveryMode: "absolute_time",
  steps: [
    { sourceStepId: 1, orderNumber: 1, lastOrder: 1, parts: [text("ご登録ありがとうございます。会員ページはこちらからどうぞ。")], timing: timing(0, "00:00") },
    { sourceStepId: 2, orderNumber: 2, lastOrder: 2, parts: [text("[NAME]さん、おはようございます。今日は大切なお知らせがあります。ぜひ最後まで読んでください。")], timing: timing(1, "07:30") },
    { sourceStepId: 3, orderNumber: 3, lastOrder: 3, parts: [text("今日が締め切りです。迷っている方はこの機会にどうぞ。")], timing: timing(3, "18:00") },
    { sourceStepId: 4, orderNumber: 4, lastOrder: 4, parts: [text("ご登録ありがとうございます。会員ページはこちらからどうぞ。")], timing: timing(5, "21:00") },
  ],
};

const send = (at: string, body: string): SourceMessage => ({ sender: "bot", message_type: "scenario", content: [{ type: "text", content: body }], source: { type: "scenario", name: NAME }, sent_at: at });
const start = (at: string): SourceMessage => ({ sender: "bot", message_type: "scenario", content: JSON.stringify({ scenario_name: NAME, start_day: null, start_time: null, from: "1001" }), source: { type: "scenario", name: null }, sent_at: at });

describe("ステップ配信の進行状態の復元", () => {
  it("差し込みが名前に置き換わっていても同じ本文とみなす", () => {
    expect(partMatches(text("[NAME]さん、おはようございます。今日は大切なお知らせがあります。"), { message_type: "text", content: "花子さん、おはようございます。今日は大切なお知らせがあります。" })).toBe(true);
    expect(partMatches(text("今日が締め切りです。"), { message_type: "text", content: "まったく別のメッセージです。" })).toBe(false);
  });

  it("同じ本文の1通目と4通目を順番で区別する", () => {
    const msgs = [
      start("2026-06-01 10:00:00"),
      send("2026-06-01 10:00:05", INFO.steps[0].parts[0].message_content),
      send("2026-06-02 07:30:00", "太郎さん、おはようございます。今日は大切なお知らせがあります。ぜひ最後まで読んでください。"),
      send("2026-06-04 18:00:00", INFO.steps[2].parts[0].message_content),
      send("2026-06-06 21:00:00", INFO.steps[3].parts[0].message_content),
    ];
    expect(restoreProgress(INFO, msgs, parseSourceDate("2026-06-01 10:00:00"))).toMatchObject({ lastIndex: 3, matched: 4 });
  });

  it("途中の人は最後に届いたステップと、その時刻を返す", () => {
    const msgs = [start("2026-06-01 10:00:00"), send("2026-06-01 10:00:05", INFO.steps[0].parts[0].message_content)];
    const p = restoreProgress(INFO, msgs, parseSourceDate("2026-06-01 10:00:00"))!;
    expect(p.lastIndex).toBe(0);
    // 次（2通目）は開始日の翌日 07:30
    const next = nextDeliveryAt(INFO, INFO.steps[1], parseSourceDate("2026-06-01 10:00:00")!, p.lastAt);
    expect(toHarnessJst(next)).toBe("2026-06-02T07:30:00.000+09:00");
  });

  it("開始の記録があり送信が無ければ「まだ0通」", () => {
    expect(restoreProgress(INFO, [start("2026-06-01 10:00:00")], parseSourceDate("2026-06-01 10:00:00"))).toMatchObject({ lastIndex: -1 });
  });

  it("履歴が開始時点まで無ければ「分からない」", () => {
    const later: SourceMessage = { sender: "friend", message_type: "text", content: "こんにちは", sent_at: "2026-07-01 12:00:00" };
    expect(restoreProgress(INFO, [later], parseSourceDate("2026-01-01 10:00:00"))).toBeNull();
  });

  it("別のシナリオの送信は数えない", () => {
    const other: SourceMessage = { ...send("2026-06-01 10:00:05", INFO.steps[0].parts[0].message_content), source: { type: "scenario", name: "別シナリオ" } };
    expect(restoreProgress(INFO, [start("2026-06-01 10:00:00"), other], parseSourceDate("2026-06-01 10:00:00"))).toMatchObject({ lastIndex: -1 });
  });

  it("経過時間型は、前回の送信時刻 + 待ち時間", () => {
    const rel: ScenarioStepsInfo = { ...INFO, deliveryMode: "relative", steps: INFO.steps.map((s) => ({ ...s, timing: { delay_minutes: 60, offset_days: null, offset_minutes: null, delivery_time: null } })) };
    const at = parseSourceDate("2026-06-01 10:00:00")!;
    expect(toHarnessJst(nextDeliveryAt(rel, rel.steps[1], at, at + 5 * 60_000))).toBe("2026-06-01T11:05:00.000+09:00");
  });
});
