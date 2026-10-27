/**
 * L Harness（line-harness-oss）の REST API クライアント。Bearer API_KEY。
 * 使うのは読み取りと、タグ付け・メタデータ更新など既存エンドポイントだけ。
 * 友だちの新規作成やメッセージ履歴の投入は API に無いので D1 へ直接書く（sql/ 側）。
 */

import { isHttpUrl } from "../util.js";

export class HarnessApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface HarnessLineAccount {
  id: string;
  channelId: string;
  name: string;
  isActive: boolean;
  channelAccessToken?: string;
  channelSecret?: string;
  liffId?: string | null;
}

export interface HarnessTag {
  id: string;
  name: string;
  color?: string;
}

/** API キーを送ってよい URL か（https、または手元で動かす L Harness の http://localhost・127.0.0.1） */
export function isSafeHarnessUrl(value: string): boolean {
  if (!isHttpUrl(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export class HarnessApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!isSafeHarnessUrl(baseUrl)) throw new Error("harness_url は https://… で指定してください（API キーを送るため）");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    let json: { success?: boolean; data?: T; error?: string } = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      /* 本文なし */
    }
    if (!res.ok || json.success === false) {
      throw new HarnessApiError(`L Harness API ${method} ${path} が失敗しました (HTTP ${res.status}${json.error ? `: ${json.error}` : ""})`, res.status);
    }
    return json.data as T;
  }

  /** 個別のメソッドが無いエンドポイント用（リッチメニュー等） */
  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.req<T>(method, path, body);
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async lineAccounts(): Promise<HarnessLineAccount[]> {
    const data = await this.req<HarnessLineAccount[] | { items: HarnessLineAccount[] }>("GET", "/api/line-accounts");
    return Array.isArray(data) ? data : (data?.items ?? []);
  }

  async lineAccount(id: string): Promise<HarnessLineAccount> {
    return this.req<HarnessLineAccount>("GET", `/api/line-accounts/${encodeURIComponent(id)}`);
  }

  async tags(): Promise<HarnessTag[]> {
    const data = await this.req<HarnessTag[] | { items: HarnessTag[] }>("GET", "/api/tags");
    return Array.isArray(data) ? data : (data?.items ?? []);
  }

  async createTag(name: string, color?: string): Promise<HarnessTag> {
    return this.req<HarnessTag>("POST", "/api/tags", { name, color });
  }

  async friend(id: string): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>("GET", `/api/friends/${encodeURIComponent(id)}`);
  }

  async friendCount(lineAccountId?: string): Promise<number> {
    const q = lineAccountId ? `?lineAccountId=${encodeURIComponent(lineAccountId)}` : "";
    const data = await this.req<{ count?: number } | number>("GET", `/api/friends/count${q}`);
    return typeof data === "number" ? data : (data?.count ?? 0);
  }

  async addFriendTag(friendId: string, tagId: string): Promise<void> {
    await this.req("POST", `/api/friends/${encodeURIComponent(friendId)}/tags`, { tagId });
  }

  async removeFriendTag(friendId: string, tagId: string): Promise<void> {
    await this.req("DELETE", `/api/friends/${encodeURIComponent(friendId)}/tags/${encodeURIComponent(tagId)}`);
  }

  async mergeFriendMetadata(friendId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.req("PUT", `/api/friends/${encodeURIComponent(friendId)}/metadata`, metadata);
  }
}
