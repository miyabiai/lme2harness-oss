import { spawn } from "node:child_process";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadDotEnv } from "../config.js";
import { sleep } from "../util.js";
import * as log from "../log.js";

/**
 * 秘密の値（API キー等）を、チャットや端末に書かずに .env へ貼ってもらう。
 * 1. .env を「今回貼るもの」が一番上に来る形に書き直す（貼ってある値はそのまま残す）
 * 2. テキストエディット（Windows はメモ帳）で開く
 * 3. 貼って保存されるまで待ち、形式だけ確かめる（値は表示しない）
 */

interface KeySpec {
  label: string;
  where: string;
  /** 形式がおかしければ理由を返す（値そのものは返さない） */
  check?: (value: string) => string | null;
}

export const KEY_SPECS: Record<string, KeySpec> = {
  HARNESS_API_KEY: {
    label: "L Harness の API キー",
    where: "create-line-harness の完了画面に一度だけ出た「API Key」",
    check: (v) => (/\s/.test(v) ? "途中に空白や改行が入っています" : null),
  },
  LME_API_KEY: {
    label: "エルメの公開 API キー（なくても移行できます）",
    where: "エルメ管理画面 → 設定 → API設定",
    check: (v) => (v.startsWith("lme_live_sk_") ? null : "lme_live_sk_ で始まっていません"),
  },
  LINE_CHANNEL_SECRET: {
    label: "LINE のチャネルシークレット",
    where: "LINE Developers → Messaging API のチャネル → チャネル基本設定 → チャネルシークレット",
    check: (v) => (/^[0-9a-f]{32}$/i.test(v) ? null : "英数字32文字ではありません"),
  },
  LME_WEBHOOK_SECRET: {
    label: "エルメ Webhook転送の署名シークレット",
    where: "エルメ管理画面 → Webhook転送 →「L Messageデータ転送」の署名シークレット",
    check: (v) => (v.startsWith("whsec_") ? null : "whsec_ で始まっていません"),
  },
  LME_WEBHOOK_SECRET_PREVIOUS: {
    label: "（シークレットを再生成したときだけ）前の署名シークレット",
    where: "再生成する前に控えておいた値",
  },
  CLOUDFLARE_API_TOKEN: { label: "（任意）Cloudflare の API トークン", where: "wrangler のログインを使わない場合だけ" },
  CLOUDFLARE_ACCOUNT_ID: { label: "（任意）Cloudflare のアカウント ID", where: "wrangler のログインを使わない場合だけ" },
};

/** 段階ごとに必要な値 */
export const KEY_STAGES: Record<string, string[]> = {
  migrate: ["HARNESS_API_KEY"],
  bridge: ["LINE_CHANNEL_SECRET", "LME_WEBHOOK_SECRET"],
};

/** 今回貼るものを先頭に、ほかの値は下にまとめた .env の本文を作る。既にある値は消さない。 */
export function buildGuidedEnv(existing: Record<string, string>, need: string[]): string {
  const lines: string[] = [
    "# lme2harness の秘密の値。このファイルは人に渡さない・git に入れない。",
    "# 値はチャットに書かず、ここに貼ってください。貼ったら ⌘S（Windows は Ctrl+S）で保存します。",
    "",
    "# ▼ 今回貼るもの（= の右に貼る）▼",
  ];
  const line = (key: string) => `${key}=${existing[key] ?? ""}`;
  for (const key of need) {
    const spec = KEY_SPECS[key];
    if (spec) lines.push(`# ${spec.label} … ${spec.where}`);
    lines.push(line(key), "");
  }
  const rest = [...Object.keys(KEY_SPECS), ...Object.keys(existing)].filter((k, i, all) => !need.includes(k) && all.indexOf(k) === i);
  if (rest.length) {
    lines.push("# ▼ ほかの値（今は触らなくて大丈夫）▼");
    for (const key of rest) {
      const spec = KEY_SPECS[key];
      if (spec) lines.push(`# ${spec.label}`);
      lines.push(line(key));
    }
    lines.push("");
  }
  return lines.join("\n");
}

export interface KeyCheck {
  missing: string[];
  invalid: Array<{ key: string; reason: string }>;
  ok: Array<{ key: string; length: number }>;
}

/** 必要な値が貼ってあるか・形式が合っているかだけを見る（値は返さない）。 */
export function checkKeys(env: Record<string, string>, need: string[]): KeyCheck {
  const result: KeyCheck = { missing: [], invalid: [], ok: [] };
  for (const key of need) {
    const v = env[key] ?? "";
    if (!v) {
      result.missing.push(key);
      continue;
    }
    const reason = KEY_SPECS[key]?.check?.(v) ?? null;
    if (reason) result.invalid.push({ key, reason });
    else result.ok.push({ key, length: v.length });
  }
  return result;
}

/** テキストエディット（Windows はメモ帳、Linux は既定のエディタ）で開く。待たずに戻る。 */
function openInEditor(path: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", ["-e", path]] : process.platform === "win32" ? ["notepad", [path]] : ["xdg-open", [path]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => log.warn(`エディタを開けませんでした。${path} を手で開いてください`));
    child.unref();
  } catch {
    log.warn(`エディタを開けませんでした。${path} を手で開いてください`);
  }
}

function privatize(path: string): void {
  try {
    chmodSync(path, 0o600); // エディタが保存し直すと権限が戻ることがあるので毎回直す
  } catch {
    /* Windows 等 */
  }
}

export async function runKeys(opts: { names?: string[]; for?: string; wait?: boolean; timeout?: number; editor?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const path = resolve(cwd, ".env");
  let need = opts.names?.length ? opts.names : opts.for ? KEY_STAGES[opts.for] : undefined;
  if (opts.for && !need) throw new Error(`--for は ${Object.keys(KEY_STAGES).join(" / ")} のどれかです`);
  const unknown = (need ?? []).filter((k) => !KEY_SPECS[k]);
  if (unknown.length) throw new Error(`知らない項目です: ${unknown.join(", ")}（使える項目: ${Object.keys(KEY_SPECS).join(", ")}）`);
  const existing = existsSync(path) ? loadDotEnv(cwd) : {};
  // 何も指定がなければ、移行に必要でまだ空のもの
  need = need ?? KEY_STAGES.migrate.filter((k) => !existing[k]);
  if (!need.length) {
    log.info("必要な値はもう .env に貼ってあります");
    return;
  }
  const already = checkKeys(existing, need);
  if (!already.missing.length && !already.invalid.length) {
    log.info(`もう貼ってあります: ${already.ok.map((o) => `${o.key}（${o.length}文字）`).join("、")}`);
    return;
  }

  writeFileSync(path, buildGuidedEnv(existing, need), { mode: 0o600 });
  privatize(path);
  if (opts.editor !== false) openInEditor(path);
  log.info(`${process.platform === "darwin" ? "テキストエディット" : "エディタ"}で .env を開きました。次の値を = の右に貼って保存してください（チャットには貼らない）:`);
  for (const key of need) log.info(`  - ${KEY_SPECS[key].label}（${KEY_SPECS[key].where}）`);
  if (opts.wait === false) return;

  const timeoutMs = (opts.timeout ?? 600) * 1000;
  const started = Date.now();
  let lastMtime = statSync(path).mtimeMs;
  let lastReport = "";
  log.info(`保存されるのを待っています（最大 ${Math.round(timeoutMs / 60000)} 分）…`);
  while (Date.now() - started < timeoutMs) {
    await sleep(1000);
    if (!existsSync(path)) continue;
    const mtime = statSync(path).mtimeMs;
    if (mtime === lastMtime) continue;
    lastMtime = mtime;
    privatize(path);
    const r = checkKeys(loadDotEnv(cwd), need);
    if (!r.missing.length && !r.invalid.length) {
      log.info(`受け取りました: ${r.ok.map((o) => `${o.key}（${o.length}文字）`).join("、")}。エディタは閉じて大丈夫です`);
      return;
    }
    const report = [...r.missing.map((k) => `${KEY_SPECS[k].label} がまだ空です`), ...r.invalid.map((i) => `${KEY_SPECS[i.key].label}: ${i.reason}`)].join(" / ");
    if (report !== lastReport) {
      log.warn(`${report}。貼り直して保存してください`);
      lastReport = report;
    }
  }
  throw new Error("時間内に保存されませんでした。もう一度 `lme2harness keys` を実行してください");
}
