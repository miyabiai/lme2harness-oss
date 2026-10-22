import { describe, expect, it } from "vitest";
import { parseLmeDate, toHarnessJst, toIsoUtc, lmeToHarnessJst } from "../src/harness/time.js";
import { convertLmeText, htmlToText } from "../src/mapping/text.js";
import { quote, renderInsert, chunkStatements } from "../src/sql/render.js";
import { harnessId } from "../src/harness/ids.js";
import { messageToLogParts } from "../src/mapping/messages.js";
import { parseDateBooking } from "../src/mapping/bookings.js";

describe("日時", () => {
  it("エルメの JST 文字列を L Harness 形式にする", () => {
    expect(lmeToHarnessJst("2026-10-08 19:28:46")).toBe("2026-10-08T19:28:46.000+09:00");
    expect(lmeToHarnessJst("2026-10-08 19:28:46.0")).toBe("2026-10-08T19:28:46.000+09:00");
    expect(lmeToHarnessJst("2026-07-30T13:00:00+09:00")).toBe("2026-07-30T13:00:00.000+09:00");
    expect(lmeToHarnessJst("2026-10-05")).toBe("2026-10-05T00:00:00.000+09:00");
    expect(lmeToHarnessJst(null, "fallback")).toBe("fallback");
  });
  it("UTC 変換", () => {
    const t = parseLmeDate("2026-10-20 14:00:00")!;
    expect(toIsoUtc(t)).toBe("2026-10-20T05:00:00.000Z");
    expect(toHarnessJst(t)).toBe("2026-10-20T14:00:00.000+09:00");
  });
});

describe("差し込みタグ", () => {
  it("FRIEND_INFO と NAME を {{name}} にし、不明なタグは残す", () => {
    const r = convertLmeText("[FRIEND_INFO_1M6q8jZR7WzR]さん、[NAME]。[UNKNOWN_TAG]");
    expect(r.text).toBe("{{name}}さん、{{name}}。[UNKNOWN_TAG]");
    expect(r.replaced).toBe(2);
    expect(r.unknown).toEqual(["[UNKNOWN_TAG]"]);
  });
  it("HTML を素の文章にする", () => {
    expect(htmlToText("<p><strong>目安</strong></p>\n<p>3〜5分<br>です</p>")).toBe("目安\n\n3〜5分\nです");
  });
});

describe("SQL", () => {
  it("引用とエスケープ", () => {
    expect(quote("a'b")).toBe("'a''b'");
    expect(quote(null)).toBe("NULL");
    expect(quote(true)).toBe("1");
    expect(quote({ a: 1 })).toBe(`'{"a":1}'`);
    expect(quote("x\u0000y")).toBe("'xy'");
  });
  it("INSERT 文", () => {
    const sql = renderInsert({ table: "t", values: { id: "1", a: 2 } });
    expect(sql).toBe("INSERT INTO t (id, a) VALUES ('1', 2) ON CONFLICT(id) DO UPDATE SET a = excluded.a;");
    expect(renderInsert({ table: "t", values: { id: "1" }, update: [] })).toContain("DO NOTHING");
  });
  it("チャンク分割", () => {
    const chunks = chunkStatements(Array.from({ length: 1000 }, (_, i) => `SELECT ${i};`), "x", 400);
    expect(chunks.map((c) => c.statements.length)).toEqual([400, 400, 200]);
    expect(chunks[0].name).toBe("x_001.sql");
  });
  it("ID は決定的", () => {
    expect(harnessId("friend", 1)).toBe(harnessId("friend", 1));
    expect(harnessId("friend", 1)).not.toBe(harnessId("friend", 2));
    expect(harnessId("friend", 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("会話メッセージの変換", () => {
  it("ステップ配信の開始イベントは会話に入れない", () => {
    expect(messageToLogParts({ sender: "bot", message_type: "scenario", content: [{ scenario_name: "F4", start_day: null }], sent_at: "2026-10-08 19:01:01" })).toEqual([]);
  });
  it("複数パーツのテンプレートは分割し、差し込みタグを変換する", () => {
    const parts = messageToLogParts({ sender: "bot", message_type: "template", content: [{ type: "text", content: "[NAME]さん" }, { type: "image", content: "https://x/y.jpg" }], sent_at: "2026-10-08 19:01:01" });
    expect(parts).toEqual([
      { message_type: "text", content: "{{name}}さん" },
      { message_type: "image", content: JSON.stringify({ originalContentUrl: "https://x/y.jpg", previewImageUrl: "https://x/y.jpg" }) },
    ]);
  });
  it("API 形式（data が文字列/オブジェクト）も扱える", () => {
    expect(messageToLogParts({ sender: "friend", message_type: "text", content: "hi", sent_at: "2026-10-08T19:01:01+09:00" })).toEqual([{ message_type: "text", content: "hi" }]);
    expect(messageToLogParts({ sender: "bot", message_type: "pdf", content: { file_name: "a.pdf", url: "https://x/a.pdf" }, sent_at: "2026-10-08T19:01:01+09:00" })).toEqual([{ message_type: "file", content: "[ファイル: a.pdf] https://x/a.pdf" }]);
  });
});

describe("予約日時", () => {
  it("エルメの「日付 開始 ~ 終了」を読む", () => {
    const r = parseDateBooking("2026-10-20 14:00 ~ 15:00")!;
    expect(new Date(r.start).toISOString()).toBe("2026-10-20T05:00:00.000Z");
    expect(new Date(r.end!).toISOString()).toBe("2026-10-20T06:00:00.000Z");
    expect(parseDateBooking("")).toBeNull();
  });
});
