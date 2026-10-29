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

/** 渡したキーを覚えるだけの KV */
function memoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) } as unknown as KVNamespace;
}

describe("bridge worker: L Harness へ渡せなかったとき", () => {
  it("LINE 転送: L Harness が失敗を返したら 502 を返し、同じ配信の再送は受け直す", async () => {
    const { env } = makeEnv({ DEDUP: memoryKv() });
    let status = 500;
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("x", { status });
    }) as typeof fetch;
    try {
      const send = () => {
        const c = ctx();
        const req = new Request(`https://bridge.example/lme/line/${env.PATH_TOKEN_LINE}`, { method: "POST", body: JSON.stringify({ events: [{ type: "unfollow" }] }), headers: { "X-Lme-Delivery-Id": "d-retry", "X-Lme-Timestamp": ts() } });
        return worker.fetch(req, env, c).then(async (res) => (await flush(c), res));
      };
      expect((await send()).status).toBe(502);
      status = 200;
      expect((await send()).status).toBe(200);
      expect(calls).toBe(2);
      // 渡せた後の再送は重複として捨てる
      expect(await (await send()).json()).toMatchObject({ duplicate: true });
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("L Message 転送: タグ付けが失敗したら 502 を返す", async () => {
    const { env } = makeEnv({ LME_API_KEY: "lme_live_sk_" + "0".repeat(32) });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://api.lmes.jp/v1/tags")) return Response.json({ data: { tags: [{ id: 101, name: "会員" }] }, pagination: { has_next: false } });
      if (u.endsWith("/api/tags") && (init?.method ?? "GET") === "GET") return Response.json({ data: [{ id: "tag-1", name: "会員" }] });
      return new Response("down", { status: 503 });
    }) as typeof fetch;
    try {
      const c = ctx();
      const req = new Request(`https://bridge.example/lme/lmessage/${env.PATH_TOKEN_LMESSAGE}`, {
        method: "POST",
        headers: { "X-Lme-Signature": "whsec_a", "Content-Type": "application/json", "X-Lme-Timestamp": ts() },
        body: JSON.stringify({ events: [{ lmessage_friend_id: 1001, line_friend_id: "U00000000000000000000000000001001", type: "tag", action: "add", tag_id: 101 }] }),
      });
      const res = await worker.fetch(req, env, c);
      await flush(c);
      expect(res.status).toBe(502);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("bridge worker: エルメのタグ名を引けなかったとき", () => {
  const send = (env: Env, tagId: number, deliveryId: string) => {
    const c = ctx();
    const req = new Request(`https://bridge.example/lme/lmessage/${env.PATH_TOKEN_LMESSAGE}`, {
      method: "POST",
      headers: { "X-Lme-Signature": "whsec_a", "X-Lme-Timestamp": ts(), "X-Lme-Delivery-Id": deliveryId },
      body: JSON.stringify({ events: [{ lmessage_friend_id: 1001, line_friend_id: "U00000000000000000000000000001001", type: "tag", action: "add", tag_id: tagId }] }),
    });
    return worker.fetch(req, env, c).then(async (res) => (await flush(c), res));
  };

  function fakeApis(state: { lmeStatus: number; lmeTags: Array<{ id: number; name: string }>; tagAdds: string[] }): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://api.lmes.jp/v1/tags")) {
        if (state.lmeStatus !== 200) return new Response("busy", { status: state.lmeStatus });
        return Response.json({ success: true, data: { tags: state.lmeTags }, pagination: { has_next: false } });
      }
      if (u.endsWith("/api/tags") && (init?.method ?? "GET") === "GET") return Response.json({ success: true, data: [{ id: "tag-vip", name: "VIP" }, { id: "tag-new", name: "新タグ" }] });
      if (u.endsWith("/tags") && init?.method === "POST") state.tagAdds.push(String(init.body));
      return Response.json({ success: true, data: {} });
    }) as typeof fetch;
  }

  it("エルメのタグ一覧が一時的に失敗したら 502 を返し、再送で付け直す（「無いタグ」として捨てない）", async () => {
    const { env } = makeEnv({ LME_API_KEY: "lme_live_sk_" + "0".repeat(32), DEDUP: memoryKv() });
    const state = { lmeStatus: 503, lmeTags: [{ id: 202, name: "VIP" }], tagAdds: [] as string[] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeApis(state);
    try {
      expect((await send(env, 202, "d-lme-busy")).status).toBe(502);
      expect(state.tagAdds).toHaveLength(0);
      state.lmeStatus = 200;
      expect((await send(env, 202, "d-lme-busy")).status).toBe(200);
      expect(state.tagAdds).toEqual([JSON.stringify({ tagId: "tag-vip" })]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("API キーの誤りなど送り直しても同じ失敗は、再送させずに受け取る（502 を繰り返さない）", async () => {
    const { env } = makeEnv({ LME_API_KEY: "lme_live_sk_" + "0".repeat(32) });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).startsWith("https://api.lmes.jp/v1/tags")) return new Response("unauthorized", { status: 401 });
      return Response.json({ success: true, data: {} });
    }) as typeof fetch;
    try {
      expect((await send(env, 505, "d-auth")).status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("同じ配信の中で見つからなかったタグは引き直さない（一覧の取得で返事の上限時間を使い切らない）", async () => {
    const { env } = makeEnv({ LME_API_KEY: "lme_live_sk_" + "0".repeat(32) });
    let lists = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).startsWith("https://api.lmes.jp/v1/tags")) lists += 1;
      return Response.json({ success: true, data: { tags: [] }, pagination: { has_next: false } });
    }) as typeof fetch;
    try {
      const events = Array.from({ length: 9 }, () => ({ lmessage_friend_id: 1001, line_friend_id: "U00000000000000000000000000001001", type: "tag", action: "add", tag_id: 404 }));
      const c = ctx();
      const req = new Request(`https://bridge.example/lme/lmessage/${env.PATH_TOKEN_LMESSAGE}`, { method: "POST", headers: { "X-Lme-Signature": "whsec_a", "X-Lme-Timestamp": ts() }, body: JSON.stringify({ events }) });
      expect((await worker.fetch(req, env, c)).status).toBe(200);
      await flush(c);
      expect(lists).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("エルメで見つからなかったタグは覚えず、次の出来事で引き直す（作ったばかりのタグ）", async () => {
    const { env } = makeEnv({ LME_API_KEY: "lme_live_sk_" + "0".repeat(32) });
    const state = { lmeStatus: 200, lmeTags: [] as Array<{ id: number; name: string }>, tagAdds: [] as string[] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeApis(state);
    try {
      expect((await send(env, 303, "d-new-1")).status).toBe(200);
      expect(state.tagAdds).toHaveLength(0);
      state.lmeTags = [{ id: 303, name: "新タグ" }];
      expect((await send(env, 303, "d-new-2")).status).toBe(200);
      expect(state.tagAdds).toEqual([JSON.stringify({ tagId: "tag-new" })]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
