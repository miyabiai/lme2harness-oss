import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { SnapshotStore } from "../src/snapshot/store.js";
import { buildPlan } from "../src/mapping/plan.js";
import { renderInsert, type Row } from "../src/sql/render.js";
import { LocalD1 } from "../src/d1/local.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { harnessId } from "../src/harness/ids.js";

/**
 * 移行し直し（並行運用中の再 apply）で、L Harness 側で変わった状態を壊さないこと。
 * 1回目の移行のあと L Harness で手を入れ、同じ計画をもう一度流して確かめる。
 */
const FIXTURE = resolve(__dirname, "fixtures/snapshot");
const SCHEMA = resolve(__dirname, "fixtures/line-harness-bootstrap.sql");
const ACCOUNT = "acc-00000000-0000-4000-8000-000000000001";
const ORDER = ["tags", "templates", "scenarios", "scenario_steps", "forms", "auto_replies", "entry_routes", "friends", "friend_tags", "chats", "messages_log", "friend_scenarios", "form_submissions", "menus", "staff", "staff_menus"];
const TARO = harnessId("friend", 1001);
const FOLLOW_SCENARIO = harnessId("scenario", 301);

function makeDb(): LocalD1 {
  const db = new LocalD1();
  db.loadSchema(SCHEMA);
  db.exec(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('${ACCOUNT}', '1234567890', 'テスト', 'token', 'secret')`);
  return db;
}

function plan(overrides: Partial<typeof DEFAULT_CONFIG.options> = {}, store = new SnapshotStore(FIXTURE)) {
  return buildPlan(store, { lineAccountId: ACCOUNT, options: { ...DEFAULT_CONFIG.options, ...overrides }, now: "2026-10-09T12:00:00.000+09:00" });
}

function applyAll(db: LocalD1, rowsByTable: Map<string, Row[]>, tables = ORDER): void {
  for (const table of tables) db.execStatements((rowsByTable.get(table) ?? []).map(renderInsert));
}

/** このツールが入れた行の id（L Harness の初期データを除く） */
function migratedIds(table: string): string {
  return [...new Set((plan().rowsByTable.get(table) ?? []).map((r) => `'${r.values.id}'`))].join(", ");
}

/** 見本スナップショットの1人分を差し替えた取得結果 */
function storeWith(edit: (friend: Record<string, any>) => void): SnapshotStore {
  const base = new SnapshotStore(FIXTURE);
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "friends") {
        return function* () {
          for (const f of target.friends()) {
            const copy = JSON.parse(JSON.stringify(f));
            if (copy.row.lmessage_friend_id === 1001) edit(copy);
            yield copy;
          }
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("移行し直しても L Harness 側の友だちの情報を残す", () => {
  it("L Harness で足されたメタデータの項目を消さず、エルメの項目は最新にする", () => {
    const db = makeDb();
    const { rowsByTable } = plan();
    applyAll(db, rowsByTable);
    // L Harness のフォーム回答（save_to_metadata）・ブリッジの友だち情報が足される
    db.exec(`UPDATE friends SET metadata = json_set(metadata, '$.form_answer', 'はい', '$.lme_field_5', '東京') WHERE id = '${TARO}'`);
    applyAll(db, plan().rowsByTable);
    const meta = JSON.parse(db.all<{ metadata: string }>(`SELECT metadata FROM friends WHERE id = '${TARO}'`)[0].metadata);
    expect(meta.form_answer).toBe("はい");
    expect(meta.lme_field_5).toBe("東京");
    expect(meta._lme.friend_id).toBe(1001);
    expect(meta.email).toBe("taro@example.com");
    db.close();
  });

  it("エルメ側の元データ（_lme）は今回の取得結果に置き換える（消えた項目・null を残さない）", () => {
    const db = makeDb();
    applyAll(db, plan().rowsByTable);
    db.exec(`UPDATE friends SET metadata = json_set(metadata, '$._lme.old_key', 'stale') WHERE id = '${TARO}'`);
    applyAll(db, plan().rowsByTable);
    const meta = JSON.parse(db.all<{ metadata: string }>(`SELECT metadata FROM friends WHERE id = '${TARO}'`)[0].metadata);
    expect(meta._lme.old_key).toBeUndefined();
    expect("blocked_at" in meta._lme).toBe(true); // null の項目も消えない
    db.close();
  });

  it("追加日は古い方を残す（L Harness の方が古ければ変えない・新しければエルメの日付にする）", () => {
    const db = makeDb();
    applyAll(db, plan().rowsByTable);
    db.exec(`UPDATE friends SET created_at = '2025-12-01T09:00:00.000+09:00', first_followed_at = '2025-12-01T09:00:00.000+09:00' WHERE id = '${TARO}'`);
    applyAll(db, plan().rowsByTable);
    expect(db.all(`SELECT created_at, first_followed_at FROM friends WHERE id = '${TARO}'`)[0]).toEqual({ created_at: "2025-12-01T09:00:00.000+09:00", first_followed_at: "2025-12-01T09:00:00.000+09:00" });
    db.exec(`UPDATE friends SET created_at = '2026-10-01T09:00:00.000+09:00', first_followed_at = '2026-10-01T09:00:00.000+09:00' WHERE id = '${TARO}'`);
    applyAll(db, plan().rowsByTable);
    expect(db.all(`SELECT created_at, first_followed_at FROM friends WHERE id = '${TARO}'`)[0]).toEqual({ created_at: "2026-01-15T10:00:00.000+09:00", first_followed_at: "2026-01-15T10:00:00.000+09:00" });
    db.close();
  });

  it("既にあるチャットの対応状態（未読・対応済み）と人が書いたメモを残し、最終日時を古くしない", () => {
    const db = makeDb();
    applyAll(db, plan().rowsByTable);
    const chatId = harnessId("chat", 1001);
    db.exec(`UPDATE chats SET status = 'resolved', notes = '電話で対応済み', last_message_at = '2026-10-20T10:00:00.000+09:00' WHERE id = '${chatId}'`);
    applyAll(db, plan().rowsByTable);
    expect(db.all(`SELECT status, notes, last_message_at FROM chats WHERE id = '${chatId}'`)[0]).toEqual({ status: "resolved", notes: "電話で対応済み", last_message_at: "2026-10-20T10:00:00.000+09:00" });
    // このツールが書いたメモ（対応ステータス）は最新にする
    db.exec(`UPDATE chats SET notes = '対応ステータス: 古い' WHERE id = '${chatId}'`);
    applyAll(db, plan().rowsByTable);
    expect(db.all<{ notes: string }>(`SELECT notes FROM chats WHERE id = '${chatId}'`)[0].notes).toBe("対応ステータス: 対応中");
    db.close();
  });
});

describe("移行し直しても L Harness で有効にした状態を変えない", () => {
  it("有効にしたシナリオ・あいさつ・自動応答・フォーム・流入経路・メニューを止めない（無効にしたものも戻さない）", () => {
    const db = makeDb();
    applyAll(db, plan().rowsByTable);
    db.exec("UPDATE scenarios SET is_active = 1");
    db.exec("UPDATE auto_replies SET is_active = 1");
    db.exec("UPDATE forms SET is_active = 1");
    db.exec("UPDATE entry_routes SET is_active = 0");
    db.exec("UPDATE menus SET is_active = 0");
    applyAll(db, plan().rowsByTable);
    expect(db.count("scenarios", "is_active = 0")).toBe(0);
    expect(db.count("auto_replies", "is_active = 0")).toBe(0);
    expect(db.count("forms", "is_active = 0")).toBe(0);
    expect(db.count("entry_routes", "is_active = 1")).toBe(0);
    expect(db.count("menus", "is_active = 1")).toBe(0);
    db.close();
  });

  it("有効にしたシナリオは、設定・ステップの中身を書き換えず、ステップも足さない", () => {
    const db = makeDb();
    applyAll(db, plan().rowsByTable);
    db.exec(`UPDATE scenarios SET is_active = 1, name = 'L Harness で直した名前', delivery_mode = 'relative' WHERE id = '${FOLLOW_SCENARIO}'`);
    db.exec(`UPDATE scenario_steps SET message_content = 'L Harness で直した文' WHERE scenario_id = '${FOLLOW_SCENARIO}' AND step_order = 1`);
    const extra = db.all<{ id: string }>(`SELECT id FROM scenario_steps WHERE scenario_id = '${FOLLOW_SCENARIO}' AND step_order = 3`)[0].id;
    db.exec(`DELETE FROM scenario_steps WHERE id = '${extra}'`); // エルメ側で後から足されたステップの代わり
    applyAll(db, plan().rowsByTable);
    expect(db.all(`SELECT name, delivery_mode FROM scenarios WHERE id = '${FOLLOW_SCENARIO}'`)[0]).toEqual({ name: "L Harness で直した名前", delivery_mode: "relative" });
    expect(db.all<{ message_content: string }>(`SELECT message_content FROM scenario_steps WHERE scenario_id = '${FOLLOW_SCENARIO}' AND step_order = 1`)[0].message_content).toBe("L Harness で直した文");
    expect(db.count("scenario_steps", `scenario_id = '${FOLLOW_SCENARIO}'`)).toBe(2);
    db.close();
  });

  it("有効にした自動応答・フォームは、L Harness で直した中身をエルメの内容に戻さない（無効のものは最新にする）", () => {
    const db = makeDb();
    applyAll(db, plan().rowsByTable);
    const [active, inactive] = db.all<{ id: string; response_content: string }>(`SELECT id, response_content FROM auto_replies WHERE id IN (${migratedIds("auto_replies")}) ORDER BY id LIMIT 2`);
    expect(inactive).toBeDefined();
    db.exec(`UPDATE auto_replies SET is_active = 1, response_content = 'L Harness で直した返信' WHERE id = '${active.id}'`);
    db.exec(`UPDATE auto_replies SET response_content = '古い返信' WHERE id = '${inactive.id}'`);
    const form = db.all<{ id: string }>(`SELECT id FROM forms WHERE id IN (${migratedIds("forms")}) LIMIT 1`)[0];
    db.exec(`UPDATE forms SET is_active = 1, name = 'L Harness で直したフォーム' WHERE id = '${form.id}'`);
    applyAll(db, plan().rowsByTable);
    expect(db.all(`SELECT is_active, response_content FROM auto_replies WHERE id = '${active.id}'`)[0]).toEqual({ is_active: 1, response_content: "L Harness で直した返信" });
    expect(db.all(`SELECT response_content FROM auto_replies WHERE id = '${inactive.id}'`)[0]).toEqual({ response_content: inactive.response_content });
    expect(db.all(`SELECT is_active, name FROM forms WHERE id = '${form.id}'`)[0]).toEqual({ is_active: 1, name: "L Harness で直したフォーム" });
    db.close();
  });

  it("「最初から有効にする」設定では、有効な自動応答もエルメの内容で書き換える", () => {
    const db = makeDb();
    applyAll(db, plan({ activate_automations: true }).rowsByTable);
    const row = db.all<{ id: string; response_content: string }>(`SELECT id, response_content FROM auto_replies WHERE is_active = 1 AND id IN (${migratedIds("auto_replies")}) LIMIT 1`)[0];
    db.exec(`UPDATE auto_replies SET response_content = '別の返信' WHERE id = '${row.id}'`);
    applyAll(db, plan({ activate_automations: true }).rowsByTable);
    expect(db.all<{ response_content: string }>(`SELECT response_content FROM auto_replies WHERE id = '${row.id}'`)[0].response_content).toBe(row.response_content);
    db.close();
  });

  it("有効にしたシナリオに新しく入る人は「一時停止」で入れ、自動では送らない", () => {
    const db = makeDb();
    applyAll(db, plan().rowsByTable);
    db.exec(`DELETE FROM friend_scenarios WHERE friend_id = '${TARO}'`);
    db.exec(`UPDATE scenarios SET is_active = 1 WHERE id = '${FOLLOW_SCENARIO}'`);
    applyAll(db, plan().rowsByTable);
    expect(db.all(`SELECT status, next_delivery_at FROM friend_scenarios WHERE friend_id = '${TARO}' AND scenario_id = '${FOLLOW_SCENARIO}'`)[0]).toEqual({ status: "paused", next_delivery_at: null });
    db.close();
  });

  it("止まっているシナリオに入る人は、これまでどおり続きから送れる状態で入れる", () => {
    const db = makeDb();
    applyAll(db, plan().rowsByTable);
    expect(db.all<{ status: string }>(`SELECT status FROM friend_scenarios WHERE friend_id = '${TARO}' AND scenario_id = '${FOLLOW_SCENARIO}'`)[0].status).not.toBe("paused");
    db.close();
  });

  it("「最初から有効にする」設定では、1回目の移行でステップも人もそのまま入る", () => {
    const db = makeDb();
    applyAll(db, plan({ activate_automations: true }).rowsByTable);
    expect(db.count("scenarios", "is_active = 1")).toBe(4);
    expect(db.count("scenario_steps")).toBe(5);
    expect(db.count("friend_scenarios", "status = 'paused'")).toBe(0);
    db.close();
  });

  it("エルメで配信を止めた人は、前回「配信中」で入れていても一時停止にする（L Harness でまだ有効にしていないシナリオ）", () => {
    const db = makeDb();
    applyAll(db, plan().rowsByTable);
    const stopped = storeWith((f) => { f.detail.scenarios[0].status = "stopped"; });
    const { rowsByTable, ctx } = plan({}, stopped);
    applyAll(db, rowsByTable);
    expect(db.all(`SELECT status, next_delivery_at FROM friend_scenarios WHERE friend_id = '${TARO}'`)[0]).toEqual({ status: "paused", next_delivery_at: null });
    expect(ctx.reports.get("friend_scenarios")?.notes.join("\n")).toContain("停止中の人は「一時停止」");
    db.close();
  });
});
