import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { SnapshotStore } from "../src/snapshot/store.js";
import { buildPlan, writePlan } from "../src/mapping/plan.js";
import { renderInsert } from "../src/sql/render.js";
import { LocalD1 } from "../src/d1/local.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const FIXTURE = resolve(__dirname, "fixtures/snapshot");
const SCHEMA = resolve(__dirname, "fixtures/line-harness-bootstrap.sql");
const ACCOUNT = "acc-00000000-0000-4000-8000-000000000001";

function makeDb(): LocalD1 {
  const db = new LocalD1();
  db.loadSchema(SCHEMA);
  db.exec(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('${ACCOUNT}', '1234567890', 'テスト', 'token', 'secret')`,
  );
  return db;
}

function plan(overrides: Partial<typeof DEFAULT_CONFIG.options> = {}, existingTags = new Map<string, string>()) {
  const store = new SnapshotStore(FIXTURE);
  return buildPlan(store, { lineAccountId: ACCOUNT, options: { ...DEFAULT_CONFIG.options, ...overrides }, existingTags, now: "2026-10-09T12:00:00.000+09:00" });
}

describe("plan → D1 へ流せる SQL になる", () => {
  it("見本スナップショットの全行が制約違反なく入る", () => {
    const { ctx, rowsByTable } = plan();
    const db = makeDb();
    db.exec("PRAGMA foreign_keys = ON");
    const order = ["tags", "templates", "scenarios", "scenario_steps", "forms", "auto_replies", "entry_routes", "friends", "friend_tags", "chats", "messages_log", "friend_scenarios", "form_submissions"];
    for (const table of order) {
      const rows = rowsByTable.get(table) ?? [];
      db.execStatements(rows.map(renderInsert));
    }
    expect(db.count("friends")).toBe(2);
    expect(db.count("friends", "is_following = 1")).toBe(1);
    expect(db.count("friends", `line_account_id = '${ACCOUNT}'`)).toBe(2);
    expect(db.count("tags")).toBe(3 + 2); // エルメ3 + 対応ステータス2
    expect(db.count("friend_tags")).toBe(3 + 1); // 太郎2 + 花子1 + 太郎の対応ステータス
    expect(db.count("chats")).toBe(2);
    expect(db.count("chats", "status = 'unread'")).toBe(1);
    expect(db.count("messages_log")).toBe(5);
    expect(db.count("messages_log", "direction = 'incoming'")).toBe(3);
    expect(db.count("scenarios")).toBe(2 + 2); // シナリオ2 + あいさつ2（add_new, unblock）
    expect(db.count("scenario_steps")).toBe(3 + 2); // step1:1, step2:2(text+image), step3:タグのみ→0, あいさつ2
    expect(db.count("friend_scenarios")).toBe(2);
    expect(db.count("templates")).toBe(3); // group→2分割 + 画像1
    expect(db.count("forms")).toBe(1);
    expect(db.count("form_submissions")).toBe(1);
    expect(db.count("auto_replies")).toBe(4); // ルール1=キーワード2件 + ルール2（テンプレ→text）1件 + 組み込み1件（マイル）
    expect(db.count("entry_routes")).toBe(1);
    expect(ctx.reports.get("friends")?.migrated).toBe(2);
    // 2回流しても増えない（冪等）
    for (const table of order) db.execStatements((rowsByTable.get(table) ?? []).map(renderInsert));
    expect(db.count("friends")).toBe(2);
    expect(db.count("messages_log")).toBe(5);
    expect(db.count("friend_tags")).toBe(4);
    db.close();
  });

  it("友だちのメタデータは正しい JSON で、エルメの情報を持つ", () => {
    const { rowsByTable } = plan();
    const db = makeDb();
    for (const t of ["tags", "friends"]) db.execStatements((rowsByTable.get(t) ?? []).map(renderInsert));
    const rows = db.all<{ metadata: string; display_name: string; created_at: string }>("SELECT metadata, display_name, created_at FROM friends WHERE line_user_id = 'U00000000000000000000000000001001'");
    const meta = JSON.parse(rows[0].metadata);
    expect(rows[0].display_name).toBe("太郎");
    expect(rows[0].created_at).toBe("2026-01-15T10:00:00.000+09:00");
    expect(meta.email).toBe("taro@example.com");
    expect(meta["性別"]).toBe("男性");
    expect(meta.handling_status).toBe("対応中");
    expect(meta._lme.friend_id).toBe(1001);
    expect(meta._lme.scenarios[0].status).toBe("following");
    db.close();
  });

  it("会話履歴の種類ごとの content 形式", () => {
    const { rowsByTable } = plan();
    const db = makeDb();
    for (const t of ["friends", "messages_log"]) db.execStatements((rowsByTable.get(t) ?? []).map(renderInsert));
    const rows = db.all<{ direction: string; message_type: string; content: string; source: string; created_at: string }>(
      "SELECT direction, message_type, content, source, created_at FROM messages_log ORDER BY created_at",
    );
    expect(rows[0]).toMatchObject({ direction: "outgoing", message_type: "text", content: "友だち追加ありがとうございます！", source: "automation" });
    expect(rows[1]).toMatchObject({ direction: "incoming", message_type: "text", content: "こんにちは", source: "user" });
    expect(rows[2]).toMatchObject({ direction: "outgoing", source: "manual" });
    expect(JSON.parse(rows[3].content)).toEqual({ originalContentUrl: "https://example.com/photo.jpg", previewImageUrl: "https://example.com/photo.jpg" });
    expect(rows[4]).toMatchObject({ message_type: "sticker", content: "[スタンプ]" });
    db.close();
  });

  it("ステップ配信は absolute_time で日付と時刻を持ち、差し込みタグは {{name}} になる", () => {
    const { rowsByTable } = plan();
    const db = makeDb();
    for (const t of ["tags", "scenarios", "scenario_steps"]) db.execStatements((rowsByTable.get(t) ?? []).map(renderInsert));
    const sc = db.all<{ delivery_mode: string; is_active: number; trigger_type: string }>("SELECT delivery_mode, is_active, trigger_type FROM scenarios WHERE name = '友だち追加後フォロー'")[0];
    expect(sc).toEqual({ delivery_mode: "absolute_time", is_active: 0, trigger_type: "manual" });
    const steps = db.all<{ step_order: number; offset_days: number; delivery_time: string; message_type: string; message_content: string; on_reach_tag_id: string | null }>(
      "SELECT s.step_order, s.offset_days, s.delivery_time, s.message_type, s.message_content, s.on_reach_tag_id FROM scenario_steps s JOIN scenarios c ON c.id = s.scenario_id WHERE c.name = '友だち追加後フォロー' ORDER BY step_order",
    );
    expect(steps.map((s) => s.step_order)).toEqual([1, 2, 3]);
    expect(steps[0].message_content).toBe("{{name}}さん、登録ありがとうございます！");
    expect(steps[0].on_reach_tag_id).not.toBeNull();
    expect(steps[1]).toMatchObject({ offset_days: 1, delivery_time: "12:30", message_type: "text" });
    expect(steps[2]).toMatchObject({ offset_days: 1, delivery_time: "12:30", message_type: "image" });
    const welcome = db.all<{ trigger_type: string }>("SELECT trigger_type FROM scenarios WHERE name LIKE 'あいさつ（友だち追加時）'")[0];
    expect(welcome.trigger_type).toBe("friend_add");
    db.close();
  });

  it("フォームは L Harness の fields 形式になり、回答は友だちに紐づく", () => {
    const { rowsByTable } = plan();
    const db = makeDb();
    for (const t of ["tags", "forms", "friends", "form_submissions"]) db.execStatements((rowsByTable.get(t) ?? []).map(renderInsert));
    const form = db.all<{ name: string; fields: string; on_submit_message_content: string; submit_count: number; on_submit_tag_id: string }>("SELECT name, fields, on_submit_message_content, submit_count, on_submit_tag_id FROM forms")[0];
    expect(form.name).toBe("ご意見アンケート");
    const fields = JSON.parse(form.fields) as Array<{ name: string; type: string; options?: string[]; required?: boolean }>;
    expect(fields.map((f) => f.type)).toEqual(["email", "text", "select", "date", "textarea"]);
    expect(fields[2].options).toEqual(["男性", "女性"]);
    expect(fields[0].required).toBe(true);
    expect(form.on_submit_message_content).toBe("ご回答ありがとうございました");
    expect(form.submit_count).toBe(1);
    expect(form.on_submit_tag_id).not.toBeNull();
    const sub = db.all<{ data: string; friend_id: string }>("SELECT data, friend_id FROM form_submissions")[0];
    expect(JSON.parse(sub.data)).toMatchObject({ お名前: "山田", 性別: "男性", 生年月日: "1990-01-02", ご意見: "良いです" });
    expect(sub.friend_id).not.toBeNull();
    db.close();
  });

  it("既存タグを名前で再利用し、同名衝突で落ちない", () => {
    const db = makeDb();
    db.exec("INSERT INTO tags (id, name) VALUES ('existing-1', '会員')");
    const { rowsByTable, ctx } = plan({}, new Map([["会員", "existing-1"]]));
    for (const t of ["tags", "friends", "friend_tags"]) db.execStatements((rowsByTable.get(t) ?? []).map(renderInsert));
    expect(ctx.tagIds.get(101)).toBe("existing-1");
    expect(db.count("tags", "name = '会員'")).toBe(1);
    expect(db.count("friend_tags", "tag_id = 'existing-1'")).toBe(1);
    db.close();
  });

  it("writePlan は SQL チャンクとレポートを出す", () => {
    const store = new SnapshotStore(FIXTURE);
    const { ctx, rowsByTable } = plan();
    const out = mkdtempSync(resolve(tmpdir(), "lme2harness-"));
    const manifest = writePlan(out, ctx, rowsByTable, store);
    expect(manifest.chunks.length).toBeGreaterThan(5);
    expect(manifest.chunks[0].table).toBe("tags");
    expect(manifest.counts.friends).toBe(2);
    expect(manifest.counts.forms).toBe(1); // 回答数の更新行を二重に数えない
    expect(Object.keys(manifest.reports)).toContain("rich_menus");
  });
});

describe("サロン予約の変換", () => {
  it("コース→メニュー、スタッフ→担当者、予約→bookings（UTC）になる", () => {
    const { rowsByTable } = plan();
    const db = makeDb();
    for (const t of ["tags", "friends", "menus", "staff", "staff_menus", "bookings", "booking_reminders"]) db.execStatements((rowsByTable.get(t) ?? []).map(renderInsert));
    expect(db.count("menus")).toBe(2);
    expect(db.count("menus", "is_active = 1")).toBe(1);
    expect(db.count("staff")).toBe(2);
    expect(db.count("staff_menus")).toBe(1 + 2); // 運営者=1コース、佐藤=全コース
    const menu = db.all<{ duration_minutes: number; buffer_after_minutes: number; base_price: number }>("SELECT duration_minutes, buffer_after_minutes, base_price FROM menus WHERE name = '移行デモコース（60分）'")[0];
    expect(menu).toEqual({ duration_minutes: 60, buffer_after_minutes: 15, base_price: 5000 });
    const bookings = db.all<{ starts_at: string; ends_at: string; block_ends_at: string; status: string; price_at_booking: number }>("SELECT starts_at, ends_at, block_ends_at, status, price_at_booking FROM bookings ORDER BY starts_at");
    expect(bookings).toHaveLength(2); // 友だちに紐づかない 900003 は除外
    expect(bookings[0]).toMatchObject({ starts_at: "2026-01-20T01:00:00.000Z", status: "completed" });
    expect(bookings[1]).toMatchObject({ starts_at: "2099-10-20T05:00:00.000Z", ends_at: "2099-10-20T06:00:00.000Z", block_ends_at: "2099-10-20T06:15:00.000Z", status: "confirmed", price_at_booking: 5000 });
    expect(db.count("booking_reminders")).toBe(0); // 並行運用中にエルメと二重に届かないよう作らない
    db.close();
  });
});

describe("レッスン予約の変換", () => {
  it("コース→イベント、予約のある日時→枠、予約→イベント予約（非公開・UTC）になる", () => {
    const { rowsByTable, ctx } = plan();
    const db = makeDb();
    for (const t of ["tags", "friends", "events", "event_slots", "event_bookings"]) db.execStatements((rowsByTable.get(t) ?? []).map(renderInsert));
    expect(db.count("events")).toBe(1);
    expect(db.count("events", "is_published = 0")).toBe(1);
    expect(db.count("event_slots")).toBe(2); // 予約の入った枠 2 つ（同じ枠の予約はまとめる）
    expect(db.count("event_slots", "starts_at = '2030-10-20T01:00:00.000Z' AND capacity IS NULL")).toBe(1);
    expect(db.count("event_bookings")).toBe(3); // 友だちに紐づかない 1 件は除く
    expect(db.count("event_bookings", "status = 'confirmed'")).toBe(1);
    expect(db.count("event_bookings", "status = 'cancelled'")).toBe(1);
    expect(db.count("event_bookings", "status = 'attended'")).toBe(1); // 過去の確定予約
    expect(db.count("event_booking_reminders")).toBe(0);
    expect(ctx.reports.get("lessons")?.notes.join("\n")).toContain("友だちに紐づかない予約 1件");
  });
});
