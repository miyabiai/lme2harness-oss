import { describe, expect, it } from "vitest";
import worker, { acceptedLmeSecrets, freshTimestamp, type Env } from "../bridge/src/index.js";
import { createHmac } from "node:crypto";

/** Worker を直接呼ぶ最小テスト。D1/KV は偽物で代用する。 */
function makeEnv(overrides: Partial<Env> = {}): { env: Env; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const friends = new Map<string, string>([["U00000000000000000000000000001001", "friend-1"]]);
  const db = {
    prepare: (sql: string) => ({
      bind: (v: unknown) => ({
        first: async () => {
          if (sql.includes("line_user_id")) return friends.has(String(v)) ? { id: friends.get(String(v)) } : null;
          return null;
        },
      }),
    }),
  } as unknown as D1Database;
  const env: Env = {
    DB: db,
    HARNESS_URL: "https://harness.example",
    LINE_CHANNEL_SECRET: "secret",
    HARNESS_API_KEY: "key",
    LME_WEBHOOK_SECRET: "whsec_a",
    PATH_TOKEN_LINE: "A".repeat(48),
    PATH_TOKEN_LMESSAGE: "B".repeat(48),
    ...overrides,
  };
  return { env, calls };
}

function ctx(): ExecutionContext {
  const tasks: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void tasks.push(p),
    passThroughOnException: () => undefined,
    // テスト側で待てるように
    props: tasks,
  } as unknown as ExecutionContext;
}

/** エルメが付ける送信時刻（エポックミリ秒） */
function ts(offsetMs = 0): string {
  return String(Date.now() + offsetMs);
}

async function flush(c: ExecutionContext): Promise<void> {
  await Promise.all((c as unknown as { props: Promise<unknown>[] }).props);
}

describe("bridge worker", () => {
  it("LINE 転送: 署名を付け直して L Harness /webhook へ送る（replyToken は外す）", async () => {
    const { env } = makeEnv();
    const seen: Array<{ url: string; sig: string | null; body: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as ArrayBuffer);
      seen.push({ url: String(url), sig: (init?.headers as Record<string, string>)["X-Line-Signature"] ?? null, body });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const payload = JSON.stringify({ destination: "Uxxx", events: [{ type: "message", replyToken: "r", source: { userId: "U1" }, message: { type: "text", text: "hi" } }] });
      const req = new Request(`https://bridge.example/lme/line/${env.PATH_TOKEN_LINE}`, { method: "POST", body: payload, headers: { "Content-Type": "application/json", "X-Lme-Delivery-Id": "d1", "X-Lme-Timestamp": ts() } });
      const c = ctx();
      const res = await worker.fetch(req, env, c);
      expect(res.status).toBe(200);
      await flush(c);
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe("https://harness.example/webhook");
      const forwarded = JSON.parse(seen[0].body);
      expect(forwarded.events[0].replyToken).toBeUndefined();
      const expected = createHmac("sha256", "secret").update(seen[0].body).digest("base64");
      expect(seen[0].sig).toBe(expected);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("パストークンが違えば 404、L Message 転送の署名が違えば 401", async () => {
    const { env } = makeEnv();
    const bad = await worker.fetch(new Request("https://bridge.example/lme/line/" + "C".repeat(48), { method: "POST", body: "{}" }), env, ctx());
    expect(bad.status).toBe(404);
    const unsigned = await worker.fetch(
      new Request(`https://bridge.example/lme/lmessage/${env.PATH_TOKEN_LMESSAGE}`, { method: "POST", body: JSON.stringify({ events: [] }), headers: { "X-Lme-Signature": "whsec_wrong", "X-Lme-Timestamp": ts() } }),
      env,
      ctx(),
    );
    expect(unsigned.status).toBe(401);
  });

  it("L Message 転送: タグ付与を L Harness API に流す", async () => {
    const { env } = makeEnv({ LME_API_KEY: "lme_live_sk_" + "0".repeat(32) });
    const seen: Array<{ url: string; method: string; body?: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      seen.push({ url: u, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
      if (u.startsWith("https://api.lmes.jp/v1/tags")) return Response.json({ success: true, data: { tags: [{ id: 101, name: "会員" }] }, pagination: { has_next: false } });
      if (u.endsWith("/api/tags") && (init?.method ?? "GET") === "GET") return Response.json({ success: true, data: [{ id: "tag-1", name: "会員" }] });
      return Response.json({ success: true, data: {} });
    }) as typeof fetch;
    try {
      const req = new Request(`https://bridge.example/lme/lmessage/${env.PATH_TOKEN_LMESSAGE}`, {
        method: "POST",
        headers: { "X-Lme-Signature": "whsec_a", "Content-Type": "application/json", "X-Lme-Timestamp": ts() },
        body: JSON.stringify({ events: [{ lmessage_friend_id: 1001, line_friend_id: "U00000000000000000000000000001001", type: "tag", action: "add", tag_id: 101 }, { lmessage_friend_id: 1001, line_friend_id: "U00000000000000000000000000001001", type: "friend_info", action: "set", field_id: -1, value: "山田" }] }),
      });
      const c = ctx();
      const res = await worker.fetch(req, env, c);
      expect(res.status).toBe(200);
      await flush(c);
      const tagAdd = seen.find((s) => s.url === "https://harness.example/api/friends/friend-1/tags" && s.method === "POST");
      expect(tagAdd?.body).toBe(JSON.stringify({ tagId: "tag-1" }));
      const meta = seen.find((s) => s.url === "https://harness.example/api/friends/friend-1/metadata" && s.method === "PUT");
      expect(meta?.body).toBe(JSON.stringify({ "lme_field_-1": "山田" }));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("X-Lme-Timestamp が無い・古い・未来すぎるものは 401 で断り、L Harness に流さない", async () => {
    const { env } = makeEnv();
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const body = JSON.stringify({ events: [{ type: "unfollow", source: { userId: "U1" } }] });
      for (const headers of [{}, { "X-Lme-Timestamp": ts(-10 * 60 * 1000) }, { "X-Lme-Timestamp": ts(10 * 60 * 1000) }, { "X-Lme-Timestamp": "abc" }] as Array<Record<string, string>>) {
        const c = ctx();
        const res = await worker.fetch(new Request(`https://bridge.example/lme/line/${env.PATH_TOKEN_LINE}`, { method: "POST", body, headers }), env, c);
        expect(res.status).toBe(401);
        await flush(c);
      }
      expect(seen).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("許容秒数は MAX_CLOCK_SKEW_SECONDS で変えられ、0 なら時刻を確かめない", () => {
    const now = 1_800_000_000_000;
    expect(freshTimestamp(makeEnv().env, String(now - 299_000), now)).toBe(true);
    expect(freshTimestamp(makeEnv().env, String(now - 301_000), now)).toBe(false);
    expect(freshTimestamp(makeEnv({ MAX_CLOCK_SKEW_SECONDS: "60" }).env, String(now - 61_000), now)).toBe(false);
    expect(freshTimestamp(makeEnv({ MAX_CLOCK_SKEW_SECONDS: "0" }).env, null, now)).toBe(true);
  });

  it("旧シークレットは LME_WEBHOOK_SECRET_PREVIOUS_UNTIL までだけ受け付ける", async () => {
    const now = 1_800_000_000_000;
    expect(acceptedLmeSecrets(makeEnv({ LME_WEBHOOK_SECRET_PREVIOUS: "whsec_old" }).env, now)).toEqual(["whsec_a"]);
    expect(acceptedLmeSecrets(makeEnv({ LME_WEBHOOK_SECRET_PREVIOUS: "whsec_old", LME_WEBHOOK_SECRET_PREVIOUS_UNTIL: String(now + 1) }).env, now)).toEqual(["whsec_a", "whsec_old"]);
    expect(acceptedLmeSecrets(makeEnv({ LME_WEBHOOK_SECRET_PREVIOUS: "whsec_old", LME_WEBHOOK_SECRET_PREVIOUS_UNTIL: String(now) }).env, now)).toEqual(["whsec_a"]);

    const send = (env: Env) =>
      worker.fetch(
        new Request(`https://bridge.example/lme/lmessage/${env.PATH_TOKEN_LMESSAGE}`, { method: "POST", body: JSON.stringify({ events: [] }), headers: { "X-Lme-Signature": "whsec_old", "X-Lme-Timestamp": ts() } }),
        env,
        ctx(),
      );
    expect((await send(makeEnv({ LME_WEBHOOK_SECRET_PREVIOUS: "whsec_old", LME_WEBHOOK_SECRET_PREVIOUS_UNTIL: String(Date.now() + 60_000) }).env)).status).toBe(200);
    expect((await send(makeEnv({ LME_WEBHOOK_SECRET_PREVIOUS: "whsec_old", LME_WEBHOOK_SECRET_PREVIOUS_UNTIL: String(Date.now() - 1) }).env)).status).toBe(401);
    expect((await send(makeEnv({ LME_WEBHOOK_SECRET_PREVIOUS: "whsec_old" }).env)).status).toBe(401);
  });
});
