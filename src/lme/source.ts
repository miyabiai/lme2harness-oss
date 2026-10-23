import { LmeMcpClient, McpError } from "./mcp-client.js";
import { LmePublicApi, LmeApiError } from "./public-api.js";
import * as log from "../log.js";
import { chunked, sleep } from "../util.js";
import type {
  LmeAutoReply,
  LmeBot,
  LmeConversation,
  LmeConversationIndexEntry,
  LmeField,
  LmeFormDetail,
  LmeFormResponse,
  LmeFriendDetail,
  LmeFriendRow,
  LmeFriendTag,
  LmeHandlingStatus,
  LmeMessage,
  LmeRichMenu,
  LmeSalon,
  LmeScenarioDetail,
  LmeScenarioListItem,
  LmeTag,
  LmeTemplateDetail,
  LmeTemplateListItem,
  LmeTrafficSource,
  LmeWelcomeMessage,
} from "./types.js";

/**
 * エルメのデータ取得口を 1 つにまとめる。
 * 優先順: 公式 MCP（bot 単位・まとめ読み・全履歴）＞ 公開 API（API キーだけで動く・直近100件）。
 * どちらか片方だけでも動くが、取れる範囲が変わる（README の対応表参照）。
 */

export interface SourceOptions {
  mcp?: LmeMcpClient;
  api?: LmePublicApi;
  botId?: string;
  /** MCP 呼び出し間の待ち（ms）。サーバーに優しく */
  mcpIntervalMs?: number;
}

interface CalendarListItem {
  id: number;
  calendar_name?: string;
}

interface McpPagination {
  currentPage: number;
  limit: number;
  total: number;
}

/** 会話一覧の 1 人分（確認状態・対応ステータス・最終メッセージ日時） */
export type ConversationIndexEntry = LmeConversationIndexEntry;

/**
 * 会話一覧の対応ステータス。MCP の list_conversations は handling_status ではなく
 * handling_status_id / handling_status_name の 2 列で返す（2026-10 実測）。公開 API は {id,name}。
 */
export function conversationHandlingStatus(r: Record<string, unknown>): LmeHandlingStatus | null {
  const hs = r.handling_status;
  if (hs && typeof hs === "object" && typeof (hs as { name?: unknown }).name === "string") return hs as LmeHandlingStatus;
  const name = typeof hs === "string" ? hs : r.handling_status_name;
  if (typeof name === "string" && name.trim()) return { id: Number(r.handling_status_id ?? 0), name };
  return null;
}

/** MCP の get_conversation_detail の 1 人分 */
interface McpConversation {
  lmessage_friend_id: number;
  line_friend_id?: string;
  total?: number;
  total_pages?: number;
  messages: unknown[];
}

function isFeatureDenied(e: unknown): boolean {
  return e instanceof McpError && /does not have access|権限|feature/i.test(e.message);
}

/** 公開 API の 404（削除済みの友だち等）。飛ばして続ける */
function isNotFound(e: unknown): boolean {
  return e instanceof LmeApiError && e.status === 404;
}

/** MCP の詳細取得 API は配列で返す。それ以外の形なら空とみなす */
function asArray<T>(res: unknown): T[] {
  return Array.isArray(res) ? (res as T[]) : [];
}

export class LmeSource {
  readonly mcp?: LmeMcpClient;
  readonly api?: LmePublicApi;
  readonly botId?: string;
  private readonly mcpIntervalMs: number;
  private lastMcpAt = 0;
  /** 使えなかった MCP 機能（プラン外など） */
  readonly deniedFeatures = new Set<string>();

  constructor(opts: SourceOptions) {
    this.mcp = opts.mcp;
    this.api = opts.api;
    this.botId = opts.botId;
    this.mcpIntervalMs = opts.mcpIntervalMs ?? 150;
    if (!this.mcp && !this.api) throw new Error("エルメの接続手段がありません（MCP ログインか LME_API_KEY のどちらかが必要）");
  }

  get hasMcp(): boolean {
    return Boolean(this.mcp && this.botId);
  }

  get hasApi(): boolean {
    return Boolean(this.api);
  }

  private async callMcp<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    if (!this.mcp || !this.botId) throw new Error("MCP が設定されていません");
    const wait = this.lastMcpAt + this.mcpIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastMcpAt = Date.now();
    return this.mcp.call<T>(tool, { bot_id: this.botId, ...args });
  }

  /**
   * MCP の {items, pagination:{currentPage,limit,total}} 形式を全ページ読む。
   * pagination.total は「全体の件数」ではなく「そのページの件数」を返すツールがある
   * （get_form_responses で実測: 4,575 件の回答がどのページでも total=100）ので、
   * 総数は当てにせず「limit に満たないページが来るまで」読む。
   */
  private async mcpPages<T>(tool: string, field: string, args: Record<string, unknown> = {}, limit = 100): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (;;) {
      const res = await this.callMcp<Record<string, unknown>>(tool, { ...args, page, limit });
      const rows = res[field];
      if (!Array.isArray(rows)) throw new McpError(`${tool} の応答に ${field} がありません`);
      items.push(...(rows as T[]));
      const p = res.pagination as McpPagination | undefined;
      const pageLimit = typeof p?.limit === "number" && p.limit > 0 ? p.limit : limit;
      if (rows.length < pageLimit) return items;
      page += 1;
      if (page > 10_000) throw new McpError(`${tool} のページ数が上限を超えました`);
    }
  }

  /** ID を 50 件ずつまとめて詳細取得する（idsArg に CSV で渡す）。 */
  private async mcpDetails<T>(tool: string, idsArg: string, ids: number[], pick: (res: unknown) => T[] = asArray): Promise<T[]> {
    const out: T[] = [];
    for (const chunk of chunked(ids, 50)) {
      const res = await this.callMcp<unknown>(tool, { [idsArg]: chunk.join(",") });
      out.push(...pick(res));
    }
    return out;
  }

  /** MCP 機能が使えないプランの場合は空配列を返し、deniedFeatures に記録する。 */
  private async optionalMcp<T>(feature: string, fn: () => Promise<T>, empty: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isFeatureDenied(e)) {
        this.deniedFeatures.add(feature);
        log.warn(`${feature} はこのエルメ契約では使えないため飛ばします`);
        return empty;
      }
      throw e;
    }
  }

  // ---------- bot ----------
  async listBots(): Promise<LmeBot[]> {
    if (!this.mcp) return [];
    const res = await this.mcp.call<{ bots: LmeBot[] }>("list_bots", {});
    return res.bots ?? [];
  }

  // ---------- マスタ ----------
  async tags(): Promise<LmeTag[]> {
    if (this.hasMcp) {
      const rows = await this.mcpPages<{ id: number; name: string; count_user_tag?: number; created_at?: string }>("list_tags", "tags");
      return rows.map((r) => ({ id: r.id, name: r.name, friend_count: r.count_user_tag, created_at: r.created_at ?? null }));
    }
    return (await this.api!.tags()).map((r) => ({ id: r.id, name: r.name, friend_count: r.friend_count }));
  }

  async fields(): Promise<LmeField[]> {
    if (this.hasMcp) {
      const rows = await this.mcpPages<{ id: number; title: string; type_data: string; options?: unknown }>("list_friend_info_fields", "fields");
      return rows.map((r) => ({ id: r.id, title: r.title, type: r.type_data, options: Array.isArray(r.options) ? (r.options as never) : null }));
    }
    return (await this.api!.friendInfoFields()).map((r) => ({ id: r.field_id, title: r.title, type: r.field_type, options: r.options }));
  }

  async handlingStatuses(): Promise<LmeHandlingStatus[]> {
    if (this.hasMcp) return this.mcpPages<LmeHandlingStatus>("list_handling_statuses", "handling_statuses");
    return this.api!.handlingStatuses();
  }

  async scenarios(): Promise<LmeScenarioListItem[]> {
    if (this.hasMcp) return this.mcpPages<LmeScenarioListItem>("list_scenarios", "scenarios");
    return (await this.api!.scenarios()).map((r) => ({ id: r.scenario_id, name: r.name, count_follow: r.followers_count }));
  }

  /** ステップの中身は MCP でしか取れない。 */
  async scenarioDetails(ids: number[]): Promise<LmeScenarioDetail[]> {
    if (!this.hasMcp || ids.length === 0) return [];
    return this.mcpDetails<LmeScenarioDetail>("get_scenario_detail", "scenario_ids", ids, (res) =>
      Array.isArray(res) ? res : ((res as { scenarios?: LmeScenarioDetail[] }).scenarios ?? []),
    );
  }

  async templates(): Promise<LmeTemplateListItem[]> {
    if (this.hasMcp) {
      const cats = await this.mcpPages<{ category_id: number; category_name: string; templates: Array<{ id: number; name: string; type: string; content?: string }> }>(
        "list_templates",
        "categories",
      );
      const out: LmeTemplateListItem[] = [];
      for (const c of cats) {
        for (const t of c.templates ?? []) {
          out.push({ id: t.id, name: t.name, type: t.type, category_id: c.category_id, category_name: c.category_name, content: t.content });
        }
      }
      return out;
    }
    return (await this.api!.templates()).map((r) => ({ id: r.template_id, name: r.name, type: "unknown", category_id: 0, category_name: "" }));
  }

  /** group テンプレートは子を展開して children に入れる。 */
  async templateDetail(id: number, depth = 0): Promise<LmeTemplateDetail | null> {
    if (!this.hasMcp) return null;
    const res = await this.callMcp<LmeTemplateDetail>("get_template_detail", { template_id: id });
    if (!res || typeof res !== "object") return null;
    if (res.type === "group" && typeof res.content === "string" && depth < 2) {
      const childIds = res.content
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      const children: LmeTemplateDetail[] = [];
      for (const cid of childIds) {
        const child = await this.templateDetail(cid, depth + 1);
        if (child) children.push(child);
      }
      res.children = children;
    }
    return res;
  }

  async forms(): Promise<LmeFormDetail[]> {
    if (!this.hasMcp) return [];
    const list = await this.mcpPages<{ id: number }>("list_forms", "forms");
    return this.mcpDetails<LmeFormDetail>("get_form_detail", "form_ids", list.map((f) => f.id));
  }

  async formResponses(formId: number): Promise<LmeFormResponse[]> {
    if (!this.hasMcp) return [];
    return this.mcpPages<LmeFormResponse>("get_form_responses", "responses", { form_id: formId });
  }

  async autoReplies(): Promise<LmeAutoReply[]> {
    if (!this.hasMcp) return [];
    const list = await this.mcpPages<{ id: number }>("list_autoreply", "auto_replies");
    return this.mcpDetails<LmeAutoReply>("get_autoreply_detail", "auto_reply_ids", list.map((f) => f.id));
  }

  async welcomeMessages(): Promise<LmeWelcomeMessage[]> {
    if (!this.hasMcp) return [];
    const out: LmeWelcomeMessage[] = [];
    for (const type of ["add_new", "add_old", "unblock"] as const) {
      try {
        const res = await this.callMcp<{ data?: { message?: string | null; detailAction?: unknown[]; actions?: unknown[] } }>("get_welcome_message", { type });
        const data = res?.data ?? (res as never);
        out.push({
          type,
          message: (data as { message?: string | null })?.message ?? null,
          actions: ((data as { detailAction?: unknown[]; actions?: unknown[] })?.detailAction ?? (data as { actions?: unknown[] })?.actions ?? []) as never,
          raw: res,
        });
      } catch (e) {
        log.warn(`あいさつメッセージ(${type})を取得できませんでした: ${(e as Error).message}`);
      }
    }
    return out;
  }

  async richMenus(): Promise<LmeRichMenu[]> {
    if (!this.hasMcp) return [];
    const list = await this.mcpPages<LmeRichMenu>("list_richmenus", "richmenus");
    if (list.length === 0) return [];
    const details = new Map<number, unknown>();
    for (const chunk of chunked(list.map((r) => r.id), 50)) {
      try {
        const res = await this.callMcp<unknown>("get_richmenu_detail", { richmenu_ids: chunk.join(",") });
        for (const d of asArray<{ id: number }>(res)) details.set(d.id, d);
      } catch (e) {
        log.warn(`リッチメニュー詳細の取得に失敗しました: ${(e as Error).message}`);
      }
    }
    return list.map((r) => ({ ...r, detail: details.get(r.id) }));
  }

  async trafficSources(): Promise<LmeTrafficSource[]> {
    if (!this.hasMcp) return [];
    return this.mcpPages<LmeTrafficSource>("list_traffic_sources", "traffic_sources");
  }

  async salons(): Promise<LmeSalon[]> {
    if (!this.hasMcp) return [];
    return this.optionalMcp(
      "サロン予約",
      async () => {
        const res = await this.callMcp<{ salons?: CalendarListItem[] }>("list_salons", {});
        return this.calendarsWithBookings(res.salons ?? [], { detailTool: "get_salon_detail", idsArg: "salon_ids", bookingsTool: "get_salon_bookings", idArg: "salon_id" });
      },
      [],
    );
  }

  async lessonCalendars(): Promise<LmeSalon[]> {
    if (!this.hasMcp) return [];
    return this.optionalMcp(
      "レッスン予約",
      async () => {
        const res = await this.callMcp<{ calendars?: CalendarListItem[]; lesson_calendars?: CalendarListItem[] }>("list_lesson_calendars", {});
        return this.calendarsWithBookings(res.calendars ?? res.lesson_calendars ?? [], {
          detailTool: "get_lesson_calendar_detail",
          idsArg: "calendar_ids",
          bookingsTool: "get_lesson_calendar_bookings",
          idArg: "calendar_id",
        });
      },
      [],
    );
  }

  /** 予約カレンダー（サロン・レッスン）ごとに詳細と予約一覧を取る。 */
  private async calendarsWithBookings(
    list: CalendarListItem[],
    tools: { detailTool: string; idsArg: string; bookingsTool: string; idArg: string },
  ): Promise<LmeSalon[]> {
    const out: LmeSalon[] = [];
    for (const s of list) {
      const detailRes = await this.callMcp<unknown[]>(tools.detailTool, { [tools.idsArg]: String(s.id) });
      const bookings = await this.mcpPages<unknown>(tools.bookingsTool, "bookings", { [tools.idArg]: s.id });
      out.push({ id: s.id, calendar_name: s.calendar_name, detail: Array.isArray(detailRes) ? detailRes[0] : detailRes, bookings });
    }
    return out;
  }

  async products(): Promise<unknown[]> {
    if (!this.hasMcp) return [];
    return this.optionalMcp("商品", () => this.mcpPages<unknown>("list_products", "products"), []);
  }

  // ---------- 友だち ----------
  async friendRows(onProgress?: (done: number, total: number) => void): Promise<LmeFriendRow[]> {
    if (this.hasMcp) {
      const rows: LmeFriendRow[] = [];
      let page = 1;
      for (;;) {
        const res = await this.callMcp<{ total: number; total_pages: number; friends: LmeFriendRow[] }>("list_friends", { page, limit: 100 });
        rows.push(...(res.friends ?? []));
        onProgress?.(rows.length, res.total ?? rows.length);
        if (!res.friends?.length || page >= (res.total_pages ?? 1)) return rows;
        page += 1;
      }
    }
    const rows = await this.api!.friends({}, (p, t) => onProgress?.(p * 500, t * 500));
    return rows.map((r) => ({
      lmessage_friend_id: r.lmessage_friend_id,
      line_friend_id: r.line_friend_id,
      line_name: r.line_name,
      system_name: r.system_name,
      email: r.email,
      phone: r.phone,
      added_time: r.added_time,
    }));
  }

  /** 友だち詳細をまとめて取る（MCP は 100 件/回、API は 1 件/回）。 */
  async friendDetails(ids: number[]): Promise<Map<number, LmeFriendDetail>> {
    return this.hasMcp ? this.friendDetailsViaMcp(ids) : this.friendDetailsViaApi(ids);
  }

  private async friendDetailsViaMcp(ids: number[]): Promise<Map<number, LmeFriendDetail>> {
    const out = new Map<number, LmeFriendDetail>();
    for (const chunk of chunked(ids, 100)) {
      const res = await this.callMcp<unknown>("get_friend_detail", { lmessage_friend_ids: chunk.join(",") });
      for (const d of asArray<LmeFriendDetail>(res)) {
        out.set(d.lmessage_friend_id, {
          ...d,
          tags: (d.tags ?? []).map(normalizeMcpFriendTag),
          friend_info: d.friend_info ?? [],
          scenarios: d.scenarios ?? [],
        });
      }
    }
    return out;
  }

  private async friendDetailsViaApi(ids: number[]): Promise<Map<number, LmeFriendDetail>> {
    const out = new Map<number, LmeFriendDetail>();
    for (const id of ids) {
      try {
        const d = await this.api!.friendDetail(id);
        out.set(id, {
          lmessage_friend_id: d.lmessage_friend_id,
          line_friend_id: d.line_friend_id,
          line_name: d.line_name,
          system_name: d.system_name,
          email: d.email,
          phone: d.phone,
          tags: (d.tags ?? []).map((t) => ({ tag_id: t.id, tag_name: t.name })),
          friend_info: (d.friend_info ?? []).map((f) => ({ id: f.id, name: f.name, type: f.type, value: f.value })),
          scenarios: d.scenarios ?? [],
        });
      } catch (e) {
        if (isNotFound(e)) continue;
        throw e;
      }
    }
    return out;
  }

  /** 会話履歴。MCP は全期間（from 指定可）、API は直近100件。 */
  async conversations(ids: number[], from?: string): Promise<Map<number, LmeConversation>> {
    return this.hasMcp ? this.conversationsViaMcp(ids, from ?? "2000-01-01") : this.conversationsViaApi(ids);
  }

  /** 20 人ずつ 1 ページ目をまとめて取り、2 ページ目以降は 1 人ずつ追いかける。 */
  private async conversationsViaMcp(ids: number[], fromDate: string): Promise<Map<number, LmeConversation>> {
    const out = new Map<number, LmeConversation>();
    for (const chunk of chunked(ids, 20)) {
      const res = await this.callMcp<unknown>("get_conversation_detail", { lmessage_friend_ids: chunk.join(","), page: 1, limit: 100, from_date: fromDate });
      for (const c of asArray<McpConversation>(res)) {
        const msgs = [...(c.messages ?? [])];
        const complete = await this.appendConversationPages(c, fromDate, msgs);
        out.set(c.lmessage_friend_id, {
          lmessage_friend_id: c.lmessage_friend_id,
          line_friend_id: c.line_friend_id,
          messages: msgs.map(normalizeMcpMessage),
          complete,
        });
      }
    }
    return out;
  }

  /** 1 人分の会話の 2 ページ目以降を msgs に足す。途中で取れなくなったら false。 */
  private async appendConversationPages(c: McpConversation, fromDate: string, msgs: unknown[]): Promise<boolean> {
    const totalPages = c.total_pages ?? 1;
    for (let p = 2; p <= totalPages; p++) {
      const more = await this.callMcp<unknown>("get_conversation_detail", {
        lmessage_friend_ids: String(c.lmessage_friend_id),
        page: p,
        limit: 100,
        from_date: fromDate,
      });
      const first = asArray<{ messages: unknown[] }>(more)[0];
      if (!first) return false;
      msgs.push(...(first.messages ?? []));
    }
    return true;
  }

  private async conversationsViaApi(ids: number[]): Promise<Map<number, LmeConversation>> {
    const out = new Map<number, LmeConversation>();
    for (const id of ids) {
      try {
        const d = await this.api!.conversationDetail(id);
        out.set(id, {
          lmessage_friend_id: id,
          handling_status: d.handling_status ?? null,
          display_status: d.display_status,
          block_status: d.block_status,
          favorite: d.favorite,
          messages: (d.messages ?? []).map((m) => ({
            sender: m.sender === "friend" ? "friend" : "bot",
            message_type: m.message_type,
            content: m.data,
            sent_at: m.delivery_date,
          })),
          complete: (d.messages ?? []).length < 100,
        });
      } catch (e) {
        if (isNotFound(e)) continue;
        throw e;
      }
    }
    return out;
  }

  /** API の会話一覧（確認状態・対応ステータス・最終メッセージ日時）。MCP でも list_conversations で同等を取る。 */
  async conversationIndex(): Promise<Map<number, ConversationIndexEntry>> {
    const out = new Map<number, ConversationIndexEntry>();
    if (this.hasMcp) {
      for (const hide of [undefined, 1]) {
        const rows = await this.mcpPages<Record<string, unknown>>("list_conversations", "conversations", hide === undefined ? {} : { conversation_hide: hide });
        for (const r of rows) {
          const id = Number(r.lmessage_friend_id);
          if (!Number.isFinite(id)) continue;
          const confirm = r.confirm_status;
          out.set(id, {
            confirm_status: typeof confirm === "string" ? confirm : typeof confirm === "number" ? (confirm > 0 ? "unread" : "read") : null,
            handling_status: conversationHandlingStatus(r),
            last_message_date: (r.last_message_date as string | null) ?? (r.last_time_message as string | null) ?? null,
          });
        }
      }
      return out;
    }
    for (const r of await this.api!.conversations()) {
      out.set(r.lmessage_friend_id, { confirm_status: r.confirm_status ?? null, handling_status: r.handling_status ?? null, last_message_date: r.last_message_date ?? null });
    }
    return out;
  }
}

/** MCP の友だちのタグは {tag_id, tag_name} と {id, name} の 2 形がある */
function normalizeMcpFriendTag(t: LmeFriendTag): LmeFriendTag {
  const raw = t as { tag_id?: number; id?: number; tag_name?: string; name?: string; added_at?: string | null };
  return { tag_id: raw.tag_id ?? raw.id!, tag_name: raw.tag_name ?? raw.name, added_at: raw.added_at ?? null };
}

function normalizeMcpMessage(raw: unknown): LmeMessage {
  const m = (raw ?? {}) as Record<string, unknown>;
  const senderType = String(m.sender_type ?? m.sender ?? "").toLowerCase();
  const isBot = ["bot", "admin", "system", "line_oa", "oa", "staff"].includes(senderType);
  return {
    message_id: typeof m.message_id === "number" ? m.message_id : undefined,
    sender: isBot ? "bot" : "friend",
    sender_name: (m.sender_name as string | null) ?? null,
    message_type: String(m.message_type ?? "text"),
    content: m.content ?? m.data ?? null,
    source: m.source,
    sent_at: String(m.sent_at ?? m.delivery_date ?? ""),
  };
}

