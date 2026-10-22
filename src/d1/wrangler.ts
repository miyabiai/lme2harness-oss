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
  /** wrangler の起動コマンド（既定 npx --yes wrangler） */
  command?: string[];
}

/** dir に入っている wrangler があればそれを、無ければ npx で起動するコマンド。 */
export function localWranglerCommand(dir?: string): string[] {
  const bin = dir ? join(dir, "node_modules", ".bin", "wrangler") : null;
  if (bin && existsSync(bin)) return [bin];
  return ["npx", "--yes", "wrangler"];
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

export async function d1ExecuteFile(file: string, opts: WranglerD1Options): Promise<void> {
  await d1Execute(["--file", file, "--yes"], opts);
}

export async function d1Query(sql: string, opts: WranglerD1Options): Promise<Array<Record<string, unknown>>> {
  const stdout = await d1Execute(["--command", sql, "--json"], opts);
  // 出力は [{results:[...], success:true, meta:{...}}]
  const start = stdout.indexOf("[");
  const json = JSON.parse(stdout.slice(start)) as Array<{ results?: Array<Record<string, unknown>> }>;
  return json[0]?.results ?? [];
}
