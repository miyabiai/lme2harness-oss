import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import * as log from "../log.js";
import { readJsonFile, sleep } from "../util.js";

/**
 * エルメ公式 MCP サーバー（https://mcp.lmes.jp/mcp）の最小クライアント。
 * - OAuth 2.1: 動的クライアント登録（DCR）＋ PKCE（S256）＋ refresh_token
 * - MCP streamable HTTP: initialize → notifications/initialized → tools/call
 * - 応答は application/json と text/event-stream（SSE）の両方に対応
 * トークンは tokenPath（既定 ./.lme2harness/mcp-token.json、0600）に保存する。
 */

export const MCP_URL = "https://mcp.lmes.jp/mcp";
const DISCOVERY_URL = "https://mcp.lmes.jp/.well-known/oauth-authorization-server";
const REDIRECT_PORT = 8976;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const PROTOCOL_VERSION = "2025-06-18";
const SCOPE = "files:read files:write";

export class McpError extends Error {}
export class NeedsLogin extends McpError {}

interface TokenStore {
  endpoints?: Record<string, string>;
  registration?: { client_id: string } & Record<string, unknown>;
  token?: { access_token: string; refresh_token?: string; expires_at?: number };
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SSE/JSON どちらの本文も JSON-RPC オブジェクトに解釈する。 */
export function parseMcpResponse(contentType: string, body: string): Record<string, unknown> {
  if (contentType.toLowerCase().includes("text/event-stream")) {
    const parsed: Record<string, unknown>[] = [];
    for (const event of body.split("\n\n")) {
      const dataLines = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""));
      if (!dataLines.length) continue;
      try {
        parsed.push(JSON.parse(dataLines.join("\n")));
      } catch {
        /* 無視 */
      }
    }
    const withId = parsed.find((o) => o && typeof o === "object" && "id" in o);
    if (withId) return withId;
    if (parsed.length) return parsed[0];
    throw new McpError("SSE から JSON-RPC 応答を取り出せませんでした");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new McpError("MCP 応答を JSON として解釈できませんでした");
  }
}

/** tools/call の結果からテキスト本文を取り出し、JSON ならパースして返す。 */
export function toolResultData(rpc: Record<string, unknown>): unknown {
  if (rpc.error) throw new McpError(`MCP エラー: ${JSON.stringify(rpc.error)}`);
  const result = rpc.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown } | undefined;
  if (!result) throw new McpError("MCP 応答に result がありません");
  const text = (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  if (result.isError) throw new McpError(`ツール実行エラー: ${text.slice(0, 300)}`);
  if (result.structuredContent !== undefined) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function openBrowser(url: string): void {
  // Windows の start はコマンドプロンプトの命令で、シェル経由だと URL の & で切れて残りが別のコマンドになるので使わない
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* 開けなければ URL を表示するだけ */
  }
}

export interface LoginOptions {
  /** false ならブラウザを自動で開かず、URL を表示するだけ（別のパソコンから開くとき） */
  openBrowser?: boolean;
  /** 承認を待つ時間（ms）。既定 5 分 */
  timeoutMs?: number;
}

/** 127.0.0.1 で OAuth のリダイレクトを 1 回だけ受け、クエリを返す（既定 5 分で打ち切り）。 */
function waitForAuthCallback(authUrl: string, opts: LoginOptions = {}): Promise<Record<string, string>> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  return new Promise<Record<string, string>>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${REDIRECT_PORT}`);
      if (u.pathname !== "/callback") {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // ブラウザが接続を保持したままだと server.close() が終わらず、プロセスが残る（ssh 転送越しで実際に起きた）
      res.setHeader("Connection", "close");
      res.end("<h2>認証完了。このタブは閉じて大丈夫です。</h2>", () => {
        server.close();
        server.closeAllConnections();
      });
      resolve(Object.fromEntries(u.searchParams.entries()));
    });
    server.on("error", reject);
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      log.info(opts.openBrowser === false ? "次の URL をブラウザで開き、エルメにログインして承認してください:" : "ブラウザでエルメにログインして承認してください。開かない場合は次の URL を開いてください:");
      log.info(`  ${authUrl}`);
      log.info(`  （別のパソコンのブラウザで開くときは、そのパソコンで \`ssh -N -L ${REDIRECT_PORT}:127.0.0.1:${REDIRECT_PORT} <このマシン>\` を先に実行してから開いてください）`);
      if (opts.openBrowser !== false) openBrowser(authUrl);
    });
    setTimeout(() => {
      server.close();
      reject(new McpError(`${Math.round(timeoutMs / 60_000)}分以内に承認されませんでした`));
    }, timeoutMs).unref();
  });
}

export interface McpClientOptions {
  tokenPath: string;
  fetchImpl?: typeof fetch;
  clientName?: string;
}

export class LmeMcpClient {
  private sessionId: string | null = null;
  private protocolVersion = PROTOCOL_VERSION;
  private rpcId = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly clientName: string;

  constructor(private readonly opts: McpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clientName = opts.clientName ?? "lme2harness";
  }

  // ---------- トークン保存 ----------
  private load(): TokenStore {
    return readJsonFile<TokenStore>(this.opts.tokenPath) ?? {};
  }

  private save(store: TokenStore): void {
    mkdirSync(dirname(this.opts.tokenPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.opts.tokenPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(tmp, this.opts.tokenPath);
    try {
      chmodSync(this.opts.tokenPath, 0o600);
    } catch {
      /* Windows 等 */
    }
  }

  hasToken(): boolean {
    return Boolean(this.load().token?.access_token);
  }

  // ---------- OAuth ----------
  private async endpoints(store: TokenStore): Promise<Record<string, string>> {
    if (!store.endpoints) {
      const res = await this.fetchImpl(DISCOVERY_URL);
      if (!res.ok) throw new McpError(`OAuth ディスカバリに失敗しました (HTTP ${res.status})`);
      store.endpoints = (await res.json()) as Record<string, string>;
    }
    return store.endpoints;
  }

  private async register(store: TokenStore): Promise<{ client_id: string }> {
    const ep = await this.endpoints(store);
    const res = await this.fetchImpl(ep.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: this.clientName,
        redirect_uris: [REDIRECT_URI, `http://localhost:${REDIRECT_PORT}/callback`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      }),
    });
    if (res.status !== 200 && res.status !== 201) throw new McpError(`クライアント登録に失敗しました (HTTP ${res.status})`);
    store.registration = (await res.json()) as { client_id: string };
    return store.registration;
  }

  /** ブラウザでエルメにログインして認可する（初回・再認可）。 */
  async login(opts: LoginOptions = {}): Promise<void> {
    const store = this.load();
    const ep = await this.endpoints(store);
    const reg = store.registration ?? (await this.register(store));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(16));
    const authUrl =
      ep.authorization_endpoint +
      "?" +
      new URLSearchParams({
        response_type: "code",
        client_id: reg.client_id,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: MCP_URL,
      }).toString();

    const callback = await waitForAuthCallback(authUrl, opts);
    if (callback.state !== state) throw new McpError("state が一致しません。やり直してください");
    if (callback.error) throw new McpError(`認可エラー: ${callback.error}`);
    const tokenRes = await this.postToken(ep, {
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: REDIRECT_URI,
      client_id: reg.client_id,
      code_verifier: verifier,
    });
    if (!tokenRes.ok) throw new McpError(`トークン交換に失敗しました (HTTP ${tokenRes.status})`);
    this.storeToken(store, (await tokenRes.json()) as Record<string, unknown>);
    log.info(`ログイン成功。トークン保存先: ${this.opts.tokenPath}`);
  }

  /** トークンエンドポイントへ form で POST する（resource は常に MCP_URL）。 */
  private postToken(ep: Record<string, string>, params: Record<string, string>): Promise<Response> {
    return this.fetchImpl(ep.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, resource: MCP_URL }).toString(),
    });
  }

  private storeToken(store: TokenStore, tok: Record<string, unknown>): void {
    const t = store.token ?? { access_token: "" };
    t.access_token = String(tok.access_token);
    if (tok.refresh_token) t.refresh_token = String(tok.refresh_token);
    if (tok.expires_in) t.expires_at = Date.now() / 1000 + Number(tok.expires_in);
    store.token = t;
    this.save(store);
  }

  private async refresh(store: TokenStore): Promise<void> {
    const t = store.token;
    if (!t?.refresh_token || !store.registration) throw new NeedsLogin("refresh_token がありません。`lme2harness login` を実行してください");
    const ep = await this.endpoints(store);
    const res = await this.postToken(ep, {
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: store.registration.client_id,
    });
    if (!res.ok) throw new NeedsLogin(`トークン更新に失敗しました (HTTP ${res.status})。\`lme2harness login\` で再認可してください`);
    this.storeToken(store, (await res.json()) as Record<string, unknown>);
  }

  private async accessToken(forceRefresh = false): Promise<string> {
    const store = this.load();
    const tok = store.token;
    if (!tok?.access_token) throw new NeedsLogin("未ログインです。`lme2harness login` を実行してください");
    const expired = tok.expires_at !== undefined && Date.now() / 1000 > tok.expires_at - 60;
    if (forceRefresh || expired) {
      await this.refresh(store);
      return store.token!.access_token;
    }
    return tok.access_token;
  }

  // ---------- MCP ----------
  private async postRpc(payload: Record<string, unknown>, token: string): Promise<{ status: number; contentType: string; body: string; headers: Headers }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
      headers["MCP-Protocol-Version"] = this.protocolVersion;
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(MCP_URL, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000) });
        const body = await res.text();
        return { status: res.status, contentType: res.headers.get("content-type") ?? "", body, headers: res.headers };
      } catch (e) {
        lastErr = e;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw new McpError(`MCP への接続に失敗しました: ${String(lastErr)}`);
  }

  private async initialize(token: string): Promise<void> {
    this.sessionId = null;
    const r = await this.postRpc(
      {
        jsonrpc: "2.0",
        id: ++this.rpcId,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: this.clientName, version: "0.1" } },
      },
      token,
    );
    if (r.status === 401) throw new NeedsLogin("MCP の認証が拒否されました (401)。`lme2harness login` で再認可してください");
    if (r.status >= 400) throw new McpError(`initialize に失敗しました (HTTP ${r.status})`);
    const rpc = parseMcpResponse(r.contentType, r.body);
    if (rpc.error) throw new McpError(`initialize エラー: ${JSON.stringify(rpc.error)}`);
    this.sessionId = r.headers.get("mcp-session-id");
    const pv = (rpc.result as { protocolVersion?: string } | undefined)?.protocolVersion;
    if (pv) this.protocolVersion = pv;
    await this.postRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, token);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    let token = await this.accessToken();
    if (!this.sessionId) await this.initialize(token);
    const payload = { jsonrpc: "2.0", id: ++this.rpcId, method, params };
    let r = await this.postRpc(payload, token);
    if (r.status === 401 || r.status === 404) {
      token = await this.accessToken(r.status === 401);
      await this.initialize(token);
      payload.id = ++this.rpcId;
      r = await this.postRpc(payload, token);
    }
    if (r.status >= 400) throw new McpError(`${method} に失敗しました (HTTP ${r.status})`);
    return parseMcpResponse(r.contentType, r.body);
  }

  async listTools(): Promise<string[]> {
    const rpc = await this.request("tools/list", {});
    const tools = (rpc.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
    return tools.map((t) => t.name);
  }

  async call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    log.debug(`MCP ${name} ${JSON.stringify(args).slice(0, 120)}`);
    const rpc = await this.request("tools/call", { name, arguments: args });
    return toolResultData(rpc) as T;
  }
}
