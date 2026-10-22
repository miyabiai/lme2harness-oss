import type { LmeSource } from "../lme/source.js";
import type { SnapshotStore } from "./store.js";
import type { LmeBot, LmeFriendRow, SnapshotMeta } from "../lme/types.js";
import * as log from "../log.js";
import { chunked } from "../util.js";

export interface ExtractOptions {
  /** 既に保存済みの友だちは飛ばす（再開） */
  resume: boolean;
  /** 会話履歴を取る */
  messages: boolean;
  /** 会話履歴の開始日（MCP のみ） */
  messagesFrom?: string;
  /** マスタだけ／友だちだけ */
  only?: "masters" | "friends";
  /** 友だち数の上限（テスト用） */
  limitFriends?: number;
}

/**
 * エルメ → スナップショット。
 * 1) マスタ（タグ・項目・ステータス・シナリオ・テンプレ・フォーム・自動応答・あいさつ・リッチメニュー・流入経路・予約・商品）
 * 2) 友だち一覧 → 1人ずつ（詳細＋会話）を friends/<id>.json へ
 */
export async function extractSnapshot(source: LmeSource, store: SnapshotStore, bot: LmeBot, opts: ExtractOptions): Promise<SnapshotMeta> {
  const prev = store.meta();
  const meta: SnapshotMeta = {
    version: 1,
    bot,
    started_at: prev?.started_at && opts.resume ? prev.started_at : new Date().toISOString(),
    sources: { api: source.hasApi, mcp: source.hasMcp },
    notes: [],
  };
  store.writeJson("meta.json", meta);

  if (opts.only !== "friends") {
    await extractMasters(source, store, meta);
  }
  if (opts.only !== "masters") {
    await extractFriends(source, store, meta, opts);
  }
  meta.finished_at = new Date().toISOString();
  for (const f of source.deniedFeatures) meta.notes.push(`契約外のため未取得: ${f}`);
  store.writeJson("meta.json", meta);
  return meta;
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const r = await fn();
    const n = Array.isArray(r) ? `${r.length}件` : "";
    log.info(`  ✓ ${label} ${n}`);
    return r;
  } catch (e) {
    log.warn(`${label} の取得に失敗しました: ${(e as Error).message}`);
    return null;
  }
}

async function extractMasters(source: LmeSource, store: SnapshotStore, meta: SnapshotMeta): Promise<void> {
  log.info("マスタを取得します");
  const tags = await step("タグ", () => source.tags());
  if (tags) store.writeJson("tags.json", tags);
  const fields = await step("友だち情報項目", () => source.fields());
  if (fields) store.writeJson("fields.json", fields);
  const statuses = await step("対応ステータス", () => source.handlingStatuses());
  if (statuses) store.writeJson("handling_statuses.json", statuses);

  const scenarios = await step("ステップ配信一覧", () => source.scenarios());
  if (scenarios) {
    store.writeJson("scenarios.json", scenarios);
    if (source.hasMcp) {
      const details = await step("ステップ配信の中身", () => source.scenarioDetails(scenarios.map((s) => s.id)));
      if (details) store.writeJson("scenario_details.json", details);
    } else {
      meta.notes.push("ステップ配信の中身は MCP でのみ取得できます（公開APIは一覧のみ）");
    }
  }

  const templates = await step("テンプレート一覧", () => source.templates());
  if (templates) {
    store.writeJson("templates.json", templates);
    if (source.hasMcp) {
      const details: unknown[] = [];
      for (const t of templates) {
        const d = await source.templateDetail(t.id).catch((e: Error) => {
          log.warn(`テンプレート ${t.id} の詳細取得に失敗: ${e.message}`);
          return null;
        });
        if (d) details.push({ ...d, name: d.name ?? t.name, category_name: t.category_name });
      }
      store.writeJson("template_details.json", details);
      log.info(`  ✓ テンプレートの中身 ${details.length}件`);
    } else {
      meta.notes.push("テンプレートの中身は MCP でのみ取得できます（公開APIは一覧のみ）");
    }
  }

  if (source.hasMcp) {
    const forms = await step("フォーム", () => source.forms());
    if (forms) {
      store.writeJson("forms.json", forms);
      for (const f of forms) {
        const responses = await step(`フォーム「${f.name}」の回答`, () => source.formResponses(f.id));
        if (responses) store.writeJson(`form_responses/${f.id}.json`, responses);
      }
    }
    const autoReplies = await step("自動応答", () => source.autoReplies());
    if (autoReplies) store.writeJson("auto_replies.json", autoReplies);
    const welcome = await step("あいさつメッセージ", () => source.welcomeMessages());
    if (welcome) store.writeJson("welcome_messages.json", welcome);
    const richMenus = await step("リッチメニュー", () => source.richMenus());
    if (richMenus) store.writeJson("rich_menus.json", richMenus);
    const traffic = await step("流入経路", () => source.trafficSources());
    if (traffic) store.writeJson("traffic_sources.json", traffic);
    const salons = await step("サロン予約", () => source.salons());
    if (salons) store.writeJson("salons.json", salons);
    const lessons = await step("レッスン予約", () => source.lessonCalendars());
    if (lessons) store.writeJson("lesson_calendars.json", lessons);
    const products = await step("商品", () => source.products());
    if (products) store.writeJson("products.json", products);
  } else {
    meta.notes.push("フォーム・自動応答・あいさつ・リッチメニュー・流入経路・予約・商品は MCP でのみ取得できます");
  }
}

async function extractFriends(source: LmeSource, store: SnapshotStore, meta: SnapshotMeta, opts: ExtractOptions): Promise<void> {
  log.info("友だち一覧を取得します");
  let rows = store.readJson<LmeFriendRow[]>("friends/index.json");
  if (!rows || !opts.resume) {
    rows = await source.friendRows((done, total) => {
      if (done % 1000 === 0 || done >= total) log.debug(`一覧 ${Math.min(done, total)}/${total}`);
    });
    store.writeJson("friends/index.json", rows);
  }
  if (opts.limitFriends) rows = rows.slice(0, opts.limitFriends);
  meta.friend_total = rows.length;
  log.info(`  ✓ 友だち ${rows.length}人`);

  const convIndex = await step("会話一覧（確認状態・対応ステータス）", () => source.conversationIndex());
  if (convIndex) store.writeJson("conversation_index.json", Object.fromEntries(convIndex));

  const pending = rows.filter((r) => !(opts.resume && store.hasFriend(r.lmessage_friend_id)));
  log.info(`友だちの詳細${opts.messages ? "と会話履歴" : ""}を取得します（残り ${pending.length}人）`);
  const batch = source.hasMcp ? 100 : 20;
  let done = rows.length - pending.length;
  for (const chunk of chunked(pending, batch)) {
    const ids = chunk.map((r) => r.lmessage_friend_id);
    const details = await source.friendDetails(ids);
    const convs = opts.messages ? await source.conversations(ids, opts.messagesFrom) : new Map();
    const fetchedAt = new Date().toISOString();
    for (const row of chunk) {
      const detail = details.get(row.lmessage_friend_id) ?? null;
      const conv = convs.get(row.lmessage_friend_id) ?? null;
      const idx = convIndex?.get(row.lmessage_friend_id);
      if (conv && idx) {
        conv.confirm_status = conv.confirm_status ?? idx.confirm_status;
        conv.handling_status = conv.handling_status ?? idx.handling_status;
        conv.last_message_date = conv.last_message_date ?? idx.last_message_date;
      }
      store.writeFriend({ row, detail, conversation: conv, fetched_at: fetchedAt });
    }
    done += chunk.length;
    log.info(`  … ${done}/${rows.length}`);
  }
}
