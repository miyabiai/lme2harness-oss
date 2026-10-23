import { describe, expect, it } from "vitest";
import { buttonsToText, isEventRecord, messageToLogParts } from "../src/mapping/messages.js";
import { conversationHandlingStatus } from "../src/lme/source.js";
import type { LmeMessage } from "../src/lme/types.js";

const base = { sender: "bot" as const, sent_at: "2026-08-13 20:52:58" };

describe("会話ではない記録", () => {
  it("ステップ配信の開始記録（scenario の JSON 文字列）は入れない", () => {
    const m: LmeMessage = { ...base, message_type: "scenario", content: '{"scenario_name":"L1_LINE登録","start_day":null,"start_time":null,"from":"6002"}', source: { type: "scenario", name: null } };
    expect(isEventRecord(m)).toBe(true);
    expect(messageToLogParts(m)).toEqual([]);
  });
  it("stop_scenario / scenario_empty_step は入れない", () => {
    expect(isEventRecord({ ...base, message_type: "stop_scenario", content: '{"scenario_name":"F4","from":"5001"}' })).toBe(true);
    expect(isEventRecord({ ...base, message_type: "scenario_empty_step", content: '{"scenario_name":null,"from":"6002"}' })).toBe(true);
  });
  it("ふつうの文字・JSON っぽい文字は会話として残す", () => {
    expect(isEventRecord({ ...base, message_type: "text", content: "こんにちは {name} さん" })).toBe(false);
    expect(isEventRecord({ ...base, message_type: "text", content: '{"memo":"x"}' })).toBe(false);
    expect(messageToLogParts({ ...base, message_type: "scenario", content: [{ type: "text", content: "本文" }] })).toEqual([{ message_type: "text", content: "本文" }]);
  });
});

describe("ボタン型メッセージ", () => {
  it("タイトル・本文・ボタンの文字を 1 つの文字メッセージにする", () => {
    const content = { type_button: 1, data: [{ title: "ご案内", text: "こちらから{name}さんのご予約へ", buttons: [{ label: "受け取る" }, { label: "あとで" }] }] };
    expect(buttonsToText(content)).toBe("ご案内\nこちらから{{name}}さんのご予約へ\n▶ 受け取る\n▶ あとで");
    const parts = messageToLogParts({ ...base, message_type: "template", content: [{ type: "buttons", content }, { type: "text", content: "続き" }] });
    expect(parts.map((p) => p.message_type)).toEqual(["text", "text"]);
    expect(parts[0].content).toContain("▶ 受け取る");
  });
  it("中身が空なら [ボタン]", () => {
    expect(buttonsToText({ type_button: 1, data: [] })).toBe("[ボタン]");
  });
});

describe("会話一覧の対応ステータス", () => {
  it("MCP の handling_status_id / handling_status_name を読む", () => {
    expect(conversationHandlingStatus({ handling_status_id: 2093980, handling_status_name: "L1_LINE登録" })).toEqual({ id: 2093980, name: "L1_LINE登録" });
  });
  it("公開 API の {id,name} と、無い場合", () => {
    expect(conversationHandlingStatus({ handling_status: { id: 1, name: "対応中" } })).toEqual({ id: 1, name: "対応中" });
    expect(conversationHandlingStatus({ handling_status: null })).toBeNull();
    expect(conversationHandlingStatus({})).toBeNull();
  });
});
