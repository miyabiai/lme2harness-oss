import * as log from "../log.js";
import { sleep } from "../util.js";

/**
 * エルメ公開 API（https://api.lmes.jp/v1）の読み取り専用クライアント。
 * - 認証: X-LME-API-KEY
 * - 読み取りレート制限: 300 req/分（LOA単位）。安全側で 240/分に抑える。
 * - 429 は Retry-After に従って最大3回、5xx/通信断は 2 回まで再試行。
 */

export const LME_API_BASE = "https://api.lmes.jp/v1";
const KEY_RE = /^lme_live_sk_[0-9a-f]{32}$/;

export class LmeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

class SlidingWindowLimiter {
  private stamps: number[] = [];
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}
  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => t > now - this.windowMs);
      if (this.stamps.length < this.limit) {
        this.stamps.push(now);
        return;
      }
      const wait = this.stamps[0] + this.windowMs - now + 5;
      await sleep(Math.max(wait, 20));
    }
  }
}

export interface LmeApiPagination {
  page: number;
  limit: number;
  total_items: number;
  total_pages: number;
  has_next: boolean;
}

/** /friends の 1 行 */
export interface LmeApiFriendRow {
  added_time: string;
  friendtype: string;
  line_friend_id: string;
  lmessage_friend_id: number;
  line_name: string;
  system_name: string | null;
  email: string | null;
  phone: string | null;
}

type QueryParams = Record<string, string | number | undefined>;

export interface LmeApiOptions {
  apiKey: string;
  readPerMinute?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class LmePublicApi {
  private readonly apiKey: string;
  private readonly limiter: SlidingWindowLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: LmeApiOptions) {
    if (!KEY_RE.test(opts.apiKey)) {
      throw new LmeApiError("LME_API_KEY の形式が不正です（lme_live_sk_ + 32桁の16進数）", null);
    }
    this.apiKey = opts.apiKey;
    this.limiter = new SlidingWindowLimiter(opts.readPerMinute ?? 240);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? LME_API_BASE;
  }

  /** GET して success=true の本文を返す。429 と 5xx/通信断は待って再試行する。 */
  async get<T = Record<string, unknown>>(path: string, params: QueryParams = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    let rateRetries = 0;
    let transientRetries = 0;
    for (;;) {
      await this.limiter.acquire();
      const res = await this.fetchOnce(url);
      if (res && res.status === 200) {
        const body = (await res.json()) as { success?: boolean; data?: T; request_id?: string } & Record<string, unknown>;
        if (body.success === true) return body as unknown as T;
        throw new LmeApiError(`API が success=false を返しました (${body.request_id ?? "request_id 不明"})`, 200, body.request_id);
      }
      const status = res?.status ?? null;
      if (status === 429 && rateRetries < 3) {
        const ra = Number(res?.headers.get("Retry-After") ?? "2");
        rateRetries += 1;
        log.debug(`429: ${ra}秒待って再試行 (${rateRetries}/3)`);
        await sleep(Math.min(60, Math.max(1, ra)) * 1000);
        continue;
      }
      if ((status === null || status >= 500) && transientRetries < 2) {
        transientRetries += 1;
        await sleep([2000, 5000][transientRetries - 1]);
        continue;
      }
      throw await this.failure(res, status);
    }
  }

  /** 1 回だけ GET する。通信断・タイムアウトは null。 */
  private async fetchOnce(url: URL): Promise<Response | null> {
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: { "X-LME-API-KEY": this.apiKey, "User-Agent": "lme2harness/0.1", Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return null;
    }
  }

  /** 再試行しない失敗を LmeApiError にする（本文は request_id だけ拾う）。 */
  private async failure(res: Response | null, status: number | null): Promise<LmeApiError> {
    let requestId: string | undefined;
    try {
      const j = (await res?.json()) as { request_id?: string } | undefined;
      requestId = j?.request_id;
    } catch {
      /* 本文は捨てる（PII/秘密を含み得る） */
    }
    if (status === 401 || status === 403) return new LmeApiError("API キーが無効か期限切れです (401/403)", status, requestId);
    if (status === 404) return new LmeApiError("見つかりません (404)", status, requestId);
    return new LmeApiError(`API 呼び出しに失敗しました (HTTP ${status ?? "通信断"})`, status, requestId);
  }

  /** 一般的な pagination 形式のエンドポイントを全ページ読む。 */
  private async pages<T>(path: string, field: string, params: QueryParams = {}, maxPages = 500): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (;;) {
      const res = await this.get<{ data: Record<string, T[]>; pagination?: LmeApiPagination }>(path, { ...params, page, limit: 500 });
      const rows = res.data?.[field];
      if (!Array.isArray(rows)) throw new LmeApiError(`応答に data.${field} がありません`, 200);
      items.push(...rows);
      const p = res.pagination;
      if (!p || !p.has_next) return items;
      page += 1;
      if (page > maxPages) throw new LmeApiError("ページ数が上限を超えました", 200);
    }
  }

  async tags(): Promise<Array<{ id: number; name: string; friend_count: number }>> {
    return this.pages("/tags", "tags");
  }

  async friendInfoFields(): Promise<Array<{ field_id: number; title: string; field_type: string; options: Array<{ option_id: number; label: string }> | null }>> {
    return this.pages("/friend-info-fields", "fields");
  }

  async scenarios(): Promise<Array<{ scenario_id: number; name: string; followers_count: number; completed_count: number; dropped_count: number }>> {
    return this.pages("/scenarios", "scenarios");
  }

  async templates(): Promise<Array<{ template_id: number; name: string }>> {
    return this.pages("/templates", "templates");
  }

  async handlingStatuses(): Promise<Array<{ id: number; name: string }>> {
    const res = await this.get<{ data: Array<{ id: number; name: string }> }>("/handling-statuses");
    return Array.isArray(res.data) ? res.data : [];
  }

  async conversations(filters: QueryParams = {}): Promise<
    Array<{
      lmessage_friend_id: number;
      line_friend_id: string;
      line_name: string;
      system_name: string | null;
      last_message: string;
      last_message_date: string;
      confirm_status: string;
      handling_status: { id: number; name: string } | null;
    }>
  > {
    return this.pages("/conversations", "conversations", { display_status: "all", ...filters });
  }

  /** /friends は data.total_pages 方式（pagination 封筒ではない）。 */
  async friends(filters: QueryParams = {}, onPage?: (page: number, totalPages: number) => void): Promise<LmeApiFriendRow[]> {
    const all: LmeApiFriendRow[] = [];
    let page = 1;
    for (;;) {
      const res = await this.get<{ data: { total_items: number; total_pages: number; friend_detail: LmeApiFriendRow[] } }>("/friends", {
        ...filters,
        page,
        limit: 500,
      });
      const rows = res.data?.friend_detail;
      const total = res.data?.total_pages ?? 0;
      if (!Array.isArray(rows)) throw new LmeApiError("応答に data.friend_detail がありません", 200);
      all.push(...rows);
      onPage?.(page, total);
      if (page >= total) return all;
      page += 1;
      if (page > 2000) throw new LmeApiError("友だち一覧のページ数が上限を超えました", 200);
    }
  }

  async friendDetail(lmessageFriendId: number): Promise<{
    lmessage_friend_id: number;
    line_friend_id: string;
    line_name: string | null;
    system_name: string | null;
    email: string | null;
    phone: string | null;
    tags: Array<{ id: number; name: string }>;
    friend_info: Array<{ id: number; type: string; name: string; value: unknown }>;
    scenarios: Array<{ id: number; name: string; status: string }>;
  }> {
    const res = await this.get<{ data: { friend: never } }>("/friends/detail", { lmessage_friend_id: lmessageFriendId });
    const friend = (res.data as unknown as { friend?: unknown })?.friend;
    if (!friend || typeof friend !== "object") throw new LmeApiError("応答に data.friend がありません", 200);
    return friend as never;
  }

  async conversationDetail(lmessageFriendId: number): Promise<{
    lmessage_friend_id: number;
    messages: Array<{ delivery_date: string; sender: string; message_type: string; data: unknown }>;
    handling_status: { id: number; name: string } | null;
    display_status: string;
    block_status: string;
    favorite: string;
  }> {
    const res = await this.get<{ data: never }>("/conversations/detail", { lmessage_friend_id: lmessageFriendId });
    const data = res.data as unknown as { messages?: unknown };
    if (!data || !Array.isArray(data.messages)) throw new LmeApiError("応答に data.messages がありません", 200);
    return data as never;
  }
}
