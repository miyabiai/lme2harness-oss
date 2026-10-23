/**
 * lme2harness-bridge
 *
 * エルメ（L Message）の「Webhook転送」2系統を受け取り、L Harness に流す。
 *
 *   POST /lme/line/<PATH_TOKEN_LINE>
 *     LINE公式アカウントデータ転送（LINE Platform の生イベント。署名なし）
 *     → LINE_CHANNEL_SECRET で X-Line-Signature を付け直して L Harness の /webhook へ POST
 *       （L Harness から見ると LINE から直接届いたのと同じになる）
 *
 *   POST /lme/lmessage/<PATH_TOKEN_LMESSAGE>
 *     L Messageデータ転送（tag の付与/解除・friend_info の設定/消去）
 *     → D1 で友だちを引き、L Harness API でタグ付け/解除・メタデータ更新
 *
 * 10秒以内に 2xx を返す（エルメ側の要件）。重い処理は waitUntil で続ける。
 *
 * LINE 転送には署名が付かない（エルメの仕様）。受信パスのトークンが唯一の鍵なので、
 * X-Lme-Timestamp が古いもの（盗み見た通信の使い回し）も受け付けない。
 */

export interface Env {
  DB: D1Database;
  /** L Harness Worker へのサービス連携。同じ Cloudflare アカウント内の Worker を
   *  workers.dev の URL で fetch するとエラー1042で遮断されるため、こちらを優先する */
  HARNESS?: Fetcher;
  DEDUP?: KVNamespace;
  HARNESS_URL: string;
  STRIP_REPLY_TOKEN?: string;
  SYNC_FRIEND_INFO?: string;
  LINE_CHANNEL_SECRET: string;
  HARNESS_API_KEY: string;
  LME_WEBHOOK_SECRET?: string;
  LME_WEBHOOK_SECRET_PREVIOUS?: string;
  /** 旧シークレットを受け付ける期限（エポックミリ秒）。無いか過ぎていれば旧シークレットは使わない */
  LME_WEBHOOK_SECRET_PREVIOUS_UNTIL?: string;
  /** X-Lme-Timestamp と今の時刻のずれの許容（秒）。既定 300。"0" で確認しない */
  MAX_CLOCK_SKEW_SECONDS?: string;
  LME_API_KEY?: string;
  PATH_TOKEN_LINE: string;
  PATH_TOKEN_LMESSAGE: string;
}

const TOKEN_RE = /^[A-Za-z0-9]{32,128}$/;
const TAG_NAME_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 300;

interface LmeEvent {
  lmessage_friend_id?: number;
  line_friend_id?: string;
  type?: string;
  action?: string;
  tag_id?: number;
  field_id?: number;
  value?: unknown;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacSha256Base64(secret: string, body: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, body);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** X-Lme-Timestamp（エポックミリ秒）が今から許容範囲内か。エルメは再送のたびに新しい値を入れる */
export function freshTimestamp(env: Env, header: string | null, now = Date.now()): boolean {
  const skew = Number(env.MAX_CLOCK_SKEW_SECONDS ?? DEFAULT_MAX_CLOCK_SKEW_SECONDS);
  if (Number.isFinite(skew) && skew <= 0) return true;
  const limitMs = (Number.isFinite(skew) ? skew : DEFAULT_MAX_CLOCK_SKEW_SECONDS) * 1000;
  if (!header || !/^\d{10,16}$/.test(header)) return false;
  return Math.abs(now - Number(header)) <= limitMs;
}

/** 今受け付ける L Message 転送の署名シークレット。旧シークレットは期限内だけ */
export function acceptedLmeSecrets(env: Env, now = Date.now()): string[] {
  const secrets: string[] = [];
  if (env.LME_WEBHOOK_SECRET) secrets.push(env.LME_WEBHOOK_SECRET);
  const until = Number(env.LME_WEBHOOK_SECRET_PREVIOUS_UNTIL);
  if (env.LME_WEBHOOK_SECRET_PREVIOUS && Number.isFinite(until) && now < until) secrets.push(env.LME_WEBHOOK_SECRET_PREVIOUS);
  return secrets;
}

async function alreadySeen(env: Env, deliveryId: string | null): Promise<boolean> {
  if (!env.DEDUP || !deliveryId) return false;
  const key = `lme:${deliveryId}`;
  if (await env.DEDUP.get(key)) return true;
  await env.DEDUP.put(key, "1", { expirationTtl: 60 * 60 });
  return false;
}

// ---------- L Harness API ----------
/** L Harness への fetch。サービス連携があればそれを使う（同一アカウントの workers.dev 直叩きは 1042 で落ちる） */
function harnessFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  const url = env.HARNESS_URL.replace(/\/+$/, "") + path;
  return env.HARNESS ? env.HARNESS.fetch(new Request(url, init)) : fetch(url, init);
}

async function harness(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  return harnessFetch(env, path, {
    method,
    headers: { Authorization: `Bearer ${env.HARNESS_API_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function findFriendId(env: Env, lineUserId: string | undefined, lmeFriendId: number | undefined): Promise<string | null> {
  if (lineUserId) {
    const row = await env.DB.prepare("SELECT id FROM friends WHERE line_user_id = ? LIMIT 1").bind(lineUserId).first<{ id: string }>();
    if (row?.id) return row.id;
  }
  if (lmeFriendId !== undefined) {
    // 移行時に metadata._lme.friend_id として保存している
    const row = await env.DB.prepare("SELECT id FROM friends WHERE json_extract(metadata, '$._lme.friend_id') = ? LIMIT 1")
      .bind(lmeFriendId)
      .first<{ id: string }>();
    if (row?.id) return row.id;
  }
  return null;
}

/** エルメ tag_id → L Harness tags.id の解決結果（TAG_NAME_TTL_MS の間使い回す） */
const tagCache = new Map<number, { id: string | null; at: number }>();

async function lmeTagName(env: Env, tagId: number): Promise<string | null> {
  if (!env.LME_API_KEY) return null;
  // 公開 API のタグ一覧は最大 500 件/ページ。タグは多くないので毎回全件を引く（キャッシュ 10 分）
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`https://api.lmes.jp/v1/tags?page=${page}&limit=500`, { headers: { "X-LME-API-KEY": env.LME_API_KEY } });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { tags?: Array<{ id: number; name: string }> }; pagination?: { has_next?: boolean } };
    const hit = json.data?.tags?.find((t) => t.id === tagId);
    if (hit) return hit.name;
    if (!json.pagination?.has_next) break;
  }
  return null;
}

/** エルメ tag_id → L Harness tags.id。エルメ API でタグ名を引き、L Harness の同名タグを使う（無ければ作る）。 */
async function resolveTag(env: Env, tagId: number): Promise<string | null> {
  const cached = tagCache.get(tagId);
  if (cached && Date.now() - cached.at < TAG_NAME_TTL_MS) return cached.id;
  let id: string | null = null;
  const name = await lmeTagName(env, tagId);
  if (name) {
    const res = await harness(env, "GET", "/api/tags");
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<{ id: string; name: string }> | { items?: Array<{ id: string; name: string }> } };
      const list = Array.isArray(json.data) ? json.data : (json.data?.items ?? []);
      id = list.find((t) => t.name === name)?.id ?? null;
      if (!id) {
        const created = await harness(env, "POST", "/api/tags", { name });
        if (created.ok) id = ((await created.json()) as { data?: { id?: string } }).data?.id ?? null;
      }
    }
  }
  tagCache.set(tagId, { id, at: Date.now() });
  return id;
}

// ---------- 経路 A: LINE 生イベントの付け直し転送 ----------
async function forwardLineEvents(env: Env, rawBody: ArrayBuffer): Promise<void> {
  let body = rawBody;
  if ((env.STRIP_REPLY_TOKEN ?? "1") !== "0") {
    try {
      const json = JSON.parse(new TextDecoder().decode(rawBody)) as { events?: Array<Record<string, unknown>> };
      for (const ev of json.events ?? []) delete ev.replyToken;
      body = new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;
    } catch {
      /* JSON でなければそのまま */
    }
  }
  const signature = await hmacSha256Base64(env.LINE_CHANNEL_SECRET, body);
  const res = await harnessFetch(env, "/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Line-Signature": signature, "X-Lme2harness-Bridge": "1" },
    body,
  });
  if (!res.ok) console.warn(`L Harness /webhook が ${res.status} を返しました`);
  else console.log(`L Harness /webhook へ転送しました (${res.status})`);
}

// ---------- 経路 B: タグ・友だち情報の反映 ----------
async function applyLmeEvents(env: Env, events: LmeEvent[]): Promise<void> {
  for (const ev of events) {
    try {
      const friendId = await findFriendId(env, ev.line_friend_id || undefined, ev.lmessage_friend_id);
      if (!friendId) {
        console.warn(`友だちが見つかりません（L Harness 未登録）: lme=${ev.lmessage_friend_id ?? "?"}`);
        continue;
      }
      if (ev.type === "tag" && typeof ev.tag_id === "number") {
        const tagId = await resolveTag(env, ev.tag_id);
        if (!tagId) {
          console.warn(`タグを解決できません: lme tag_id=${ev.tag_id}（LME_API_KEY が無いと名前を引けません）`);
          continue;
        }
        if (ev.action === "add") await harness(env, "POST", `/api/friends/${friendId}/tags`, { tagId });
        else if (ev.action === "remove") await harness(env, "DELETE", `/api/friends/${friendId}/tags/${tagId}`);
      } else if (ev.type === "friend_info" && typeof ev.field_id === "number" && (env.SYNC_FRIEND_INFO ?? "1") !== "0") {
        const key = `lme_field_${ev.field_id}`;
        const value = ev.action === "clear" ? null : (ev.value ?? null);
        await harness(env, "PUT", `/api/friends/${friendId}/metadata`, { [key]: value });
      }
    } catch (e) {
      console.warn(`イベント処理に失敗: ${(e as Error).message}`);
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json(200, { ok: true });
    if (request.method !== "POST") return new Response("not found", { status: 404 });

    const m = url.pathname.match(/^\/lme\/(line|lmessage)\/([A-Za-z0-9]+)$/);
    if (!m) return new Response("not found", { status: 404 });
    const [, channel, token] = m;
    const expected = channel === "line" ? env.PATH_TOKEN_LINE : env.PATH_TOKEN_LMESSAGE;
    if (!expected || !TOKEN_RE.test(expected) || !timingSafeEqual(token, expected)) return new Response("not found", { status: 404 });
    if (!freshTimestamp(env, request.headers.get("X-Lme-Timestamp"))) return json(401, { ok: false, error: "X-Lme-Timestamp が無いか古すぎます" });

    const deliveryId = request.headers.get("X-Lme-Delivery-Id");
    if (await alreadySeen(env, deliveryId)) return json(200, { ok: true, duplicate: true });

    if (channel === "lmessage") {
      const sig = request.headers.get("X-Lme-Signature") ?? "";
      if (!env.LME_WEBHOOK_SECRET) return json(503, { ok: false, error: "LME_WEBHOOK_SECRET 未設定" });
      const secrets = acceptedLmeSecrets(env);
      if (!secrets.some((s) => timingSafeEqual(sig, s))) return json(401, { ok: false, error: "署名不一致" });
      let payload: { events?: LmeEvent[] };
      try {
        payload = (await request.json()) as { events?: LmeEvent[] };
      } catch {
        return json(400, { ok: false, error: "JSON ではありません" });
      }
      const events = Array.isArray(payload.events) ? payload.events : [];
      if (events.length > 1000) return json(413, { ok: false });
      ctx.waitUntil(applyLmeEvents(env, events));
      return json(200, { ok: true, accepted: events.length });
    }

    const raw = await request.arrayBuffer();
    if (raw.byteLength > 2_000_000) return json(413, { ok: false });
    ctx.waitUntil(forwardLineEvents(env, raw));
    return json(200, { ok: true });
  },
};
