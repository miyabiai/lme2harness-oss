import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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

/**
 * dir に入っている wrangler があればそれを、無ければ版を固定して npx で起動するコマンド。
 * Windows では npx.cmd などをコマンドプロンプト経由でしか起動できず、引数（SQL・URL）が記号で切れたり
 * 別のコマンドとして解釈されたりするので、node で wrangler（無ければ npx）の本体を直接動かす。
 */
export function localWranglerCommand(dir?: string, platform: string = process.platform, nodePath: string = process.execPath): string[] {
  if (platform === "win32") {
    const entry = dir ? join(dir, "node_modules", "wrangler", "bin", "wrangler.js") : null;
    if (entry && existsSync(entry)) return [nodePath, entry];
    const npx = join(dirname(nodePath), "node_modules", "npm", "bin", "npx-cli.js");
    if (existsSync(npx)) return [nodePath, npx, "--yes", `wrangler@${WRANGLER_VERSION}`];
    throw new Error("Windows で wrangler を起動できませんでした（node に同梱の npx が見つかりません）。WSL（Windows 上の Linux）で動かすか、L Harness の apps/worker で npm install してから harness_worker_dir を設定してください");
  }
  const bin = dir ? join(dir, "node_modules", ".bin", "wrangler") : null;
  if (bin && existsSync(bin)) return [bin];
  return ["npx", "--yes", `wrangler@${WRANGLER_VERSION}`];
}

function wranglerCommand(opts: WranglerD1Options): string[] {
  return opts.command ?? localWranglerCommand(opts.cwd);
}

/** wrangler に渡す環境変数。wrangler は既定で出力（照合で読み出した結果を含む）を自分のログフォルダにも書くので止める */
export function wranglerEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...extra, FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" };
}

export async function runWrangler(args: string[], opts: WranglerD1Options): Promise<{ code: number; stdout: string; stderr: string }> {
  const [cmd, ...pre] = wranglerCommand(opts);
  const full = [...pre, ...args];
  // 引数の SQL は出さない（顧客データが入りうる）
  log.debug(`$ ${cmd} ${args.slice(0, 4).join(" ")} …`);
  return new Promise((resolve, reject) => {
    // シェルは通さない（Windows でも localWranglerCommand が node で直接動かす）
    const child = spawn(cmd, full, {
      cwd: opts.cwd ?? process.cwd(),
      env: wranglerEnv(opts.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // 文字コードの区切りで読む（受け取りごとに toString すると、日本語や絵文字が受け取りの切れ目で壊れる）
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** エラー文に出してよい wrangler の出力（末尾だけ。SQL の中身＝顧客データが混ざる行は落とす） */
export function errorTail(stderr: string, stdout = ""): string {
  return `${stderr}\n${stdout}`.split("\n")
    .filter((line) => line.trim() && !/INSERT INTO|SELECT |VALUES \(|UPDATE |DELETE FROM/i.test(line))
    .slice(-8).join("\n").slice(-1500);
}

/** wrangler d1 execute を実行し、失敗なら stderr の末尾付きで投げる。 */
async function d1Execute(extraArgs: string[], opts: WranglerD1Options): Promise<string> {
  const args = ["d1", "execute", opts.databaseName, opts.remote === false ? "--local" : "--remote", ...extraArgs];
  if (opts.configPath) args.push("--config", opts.configPath);
  const r = await runWrangler(args, opts);
  if (r.code !== 0) throw new D1ExecuteError(`wrangler d1 execute が失敗しました (exit ${r.code})\n${errorTail(r.stderr, r.stdout)}`, isTransientD1Error(`${r.stderr}\n${r.stdout}`));
  return r.stdout;
}

/** wrangler d1 execute の失敗。再試行するかは、エラー文に出さない行も含めた出力全体で決める */
class D1ExecuteError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
  }
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
      const transient = e instanceof D1ExecuteError ? e.transient : isTransientD1Error(msg);
      if (attempt >= retries || !transient) throw e;
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
