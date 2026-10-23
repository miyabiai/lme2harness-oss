import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as log from "../log.js";

/**
 * wrangler d1 execute のラッパー。
 * - cwd は L Harness の apps/worker（wrangler.toml がある場所）か、--config で渡す
 * - 認証は wrangler 自身（OAuth ログイン or CLOUDFLARE_API_TOKEN 環境変数）に任せる
 */
export interface WranglerD1Options {
  databaseName: string;
  cwd?: string;
  /** wrangler.toml のパス（cwd に無い場合） */
  configPath?: string;
  /** --remote（既定）/ --local */
  remote?: boolean;
  env?: Record<string, string>;
  /** wrangler の起動コマンド（既定 npx --yes wrangler@WRANGLER_VERSION） */
  command?: string[];
}

/** npx で取ってくる wrangler の版。最新版をその場で取らないよう固定する（bridge/package.json と揃える） */
export const WRANGLER_VERSION = "4.150.0";

/** dir に入っている wrangler があればそれを、無ければ版を固定して npx で起動するコマンド。 */
export function localWranglerCommand(dir?: string): string[] {
  const bin = dir ? join(dir, "node_modules", ".bin", "wrangler") : null;
  if (bin && existsSync(bin)) return [bin];
  return ["npx", "--yes", `wrangler@${WRANGLER_VERSION}`];
}

function wranglerCommand(opts: WranglerD1Options): string[] {
  return opts.command ?? localWranglerCommand(opts.cwd);
}

export async function runWrangler(args: string[], opts: WranglerD1Options): Promise<{ code: number; stdout: string; stderr: string }> {
  const [cmd, ...pre] = wranglerCommand(opts);
  const full = [...pre, ...args];
  log.debug(`$ ${cmd} ${full.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, full, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}), FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** wrangler d1 execute を実行し、失敗なら stderr の末尾付きで投げる。 */
async function d1Execute(extraArgs: string[], opts: WranglerD1Options): Promise<string> {
  const args = ["d1", "execute", opts.databaseName, opts.remote === false ? "--local" : "--remote", ...extraArgs];
  if (opts.configPath) args.push("--config", opts.configPath);
  const r = await runWrangler(args, opts);
  if (r.code !== 0) throw new Error(`wrangler d1 execute が失敗しました (exit ${r.code})\n${r.stderr.slice(-2000)}`);
  return r.stdout;
}

/** Cloudflare 側の一時的な失敗（アップロード失敗・内部エラー・5xx）か。再試行で通ることが多い */
export function isTransientD1Error(message: string): boolean {
  return /Please retry|InternalError|internal error|<Code>5\d\d<\/Code>|HTTP 5\d\d|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|Network connection lost|network error|ENOTFOUND|EAI_AGAIN/i.test(message);
}

/** 1 ファイルを流す。一時的な失敗は少し待って最大 3 回まで再試行する（大量のファイル投入で実際に 1 回起きた）。 */
export async function d1ExecuteFile(file: string, opts: WranglerD1Options, retries = 3, waitMs = [5_000, 15_000, 30_000]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await d1Execute(["--file", file, "--yes"], opts);
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt >= retries || !isTransientD1Error(msg)) throw e;
      const wait = waitMs[Math.min(attempt, waitMs.length - 1)];
      log.warn(`D1 の一時的な失敗なので ${Math.round(wait / 1000)} 秒待って再試行します (${attempt + 1}/${retries}): ${msg.split("\n").find((l) => /ERROR|Error|error/.test(l))?.trim().slice(0, 160) ?? msg.split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export async function d1Query(sql: string, opts: WranglerD1Options): Promise<Array<Record<string, unknown>>> {
  const stdout = await d1Execute(["--command", sql, "--json"], opts);
  // 出力は [{results:[...], success:true, meta:{...}}]
  const start = stdout.indexOf("[");
  const json = JSON.parse(stdout.slice(start)) as Array<{ results?: Array<Record<string, unknown>> }>;
  return json[0]?.results ?? [];
}
