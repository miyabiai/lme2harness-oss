import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonFile } from "./util.js";

/**
 * 設定は 2 種類:
 * - lme2harness.config.json: 秘密でない設定（bot_id、出力先、対象アカウント、オプション）
 * - .env: 秘密（LME_API_KEY、HARNESS_API_KEY など）。チャットやログに値を出さない。
 */

export interface Lme2HarnessConfig {
  /** エルメの bot_id（MCP の list_bots で取得するハッシュ）。公開APIのみの場合は省略可 */
  lme_bot_id?: string;
  /** スナップショットの保存先 */
  snapshot_dir: string;
  /** 生成 SQL・レポートの出力先 */
  out_dir: string;
  /** L Harness Worker の URL（https://xxx.workers.dev） */
  harness_url?: string;
  /** L Harness 側の line_accounts.id（省略時は API から自動選択／対話） */
  harness_line_account_id?: string;
  /** D1 データベース名（wrangler d1 execute に渡す） */
  d1_database_name?: string;
  /** D1 データベース ID（ブリッジ Worker の wrangler.toml に書く） */
  d1_database_id?: string;
  /** L Harness Worker の名前（サービス連携に使う。省略時は harness_url のホスト名の先頭） */
  harness_worker_name?: string;
  /** ブリッジ Worker の名前（既定 lme2harness-bridge） */
  bridge_worker_name?: string;
  /** L Harness をクローンした apps/worker ディレクトリ（wrangler.toml がある場所）。wrangler 実行時の cwd */
  harness_worker_dir?: string;
  /** 移行オプション */
  options: {
    /** 会話履歴を取り込む */
    messages: boolean;
    /** 会話履歴の開始日（MCP 利用時のみ有効。省略で全期間） */
    messages_from?: string;
    /** 対応ステータスをタグとしても作る（"対応:名前"） */
    handling_status_as_tag: boolean;
    /** 友だち情報をメタデータのトップレベルにも展開する */
    friend_info_top_level: boolean;
    /** シナリオ・自動応答を有効状態で作る（既定 false＝並行運用中の二重送信を防ぐ） */
    activate_automations: boolean;
    /** エルメのタグ名と同名の既存タグがある場合に再利用する */
    reuse_existing_tags: boolean;
    /** ブロック中の友だちも取り込む */
    include_blocked: boolean;
  };
}

export const DEFAULT_CONFIG: Lme2HarnessConfig = {
  snapshot_dir: "./snapshot",
  out_dir: "./out",
  options: {
    messages: true,
    handling_status_as_tag: true,
    friend_info_top_level: true,
    activate_automations: false,
    reuse_existing_tags: true,
    include_blocked: true,
  },
};

export const CONFIG_FILE = "lme2harness.config.json";

export function loadConfig(cwd = process.cwd()): Lme2HarnessConfig {
  const raw = readJsonFile<Partial<Lme2HarnessConfig>>(resolve(cwd, CONFIG_FILE));
  if (!raw) {
    throw new Error(`${CONFIG_FILE} がありません。先に \`lme2harness init\` を実行してください`);
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    options: { ...DEFAULT_CONFIG.options, ...(raw.options ?? {}) },
  };
}

/** 設定ファイルの一部の項目だけ書き換える（無ければ既定値から作る）。 */
export function updateConfig(patch: Partial<Lme2HarnessConfig>, cwd = process.cwd()): Lme2HarnessConfig {
  const path = resolve(cwd, CONFIG_FILE);
  const raw = readJsonFile<Partial<Lme2HarnessConfig>>(path) ?? { ...DEFAULT_CONFIG };
  const next = { ...raw, ...patch, options: { ...DEFAULT_CONFIG.options, ...(raw.options ?? {}), ...(patch.options ?? {}) } } as Lme2HarnessConfig;
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** .env の1項目だけ書き換える（他の行・コメントはそのまま。無ければ末尾に足す）。 */
export function setDotEnvValue(key: string, value: string, cwd = process.cwd(), file = ".env"): void {
  const path = resolve(cwd, file);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  let hit = false;
  const out = lines.map((line) => {
    if (line.trim().startsWith("#")) return line;
    const i = line.indexOf("=");
    if (i > 0 && line.slice(0, i).trim() === key) {
      hit = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!hit) {
    if (out.length && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${value}`, "");
  }
  writeFileSync(path, out.join("\n"), { mode: 0o600 });
}

/** .env を source せずに読む（KEY=value、# コメント、引用符は外す）。 */
export function loadDotEnv(cwd = process.cwd(), file = ".env"): Record<string, string> {
  const path = resolve(cwd, file);
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export interface Secrets {
  LME_API_KEY?: string;
  HARNESS_API_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  LINE_CHANNEL_SECRET?: string;
  LME_WEBHOOK_SECRET?: string;
  LME_WEBHOOK_SECRET_PREVIOUS?: string;
}

export function loadSecrets(cwd = process.cwd()): Secrets {
  const env = { ...loadDotEnv(cwd), ...process.env } as Record<string, string | undefined>;
  return {
    LME_API_KEY: env.LME_API_KEY,
    HARNESS_API_KEY: env.HARNESS_API_KEY,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    LINE_CHANNEL_SECRET: env.LINE_CHANNEL_SECRET,
    LME_WEBHOOK_SECRET: env.LME_WEBHOOK_SECRET,
    LME_WEBHOOK_SECRET_PREVIOUS: env.LME_WEBHOOK_SECRET_PREVIOUS,
  };
}

export const ENV_EXAMPLE = `# lme2harness の秘密情報。値を貼るだけ。このファイルは git に入れない。
# エルメ 公開APIキー（管理画面 → 設定 → API設定 で発行）。lme_live_sk_ で始まる
LME_API_KEY=
# L Harness の API キー（create-line-harness 実行時に設定した API_KEY）
HARNESS_API_KEY=
# 並行運用ブリッジ用（bridge --deploy で使う）
# LINE Messaging API のチャネルシークレット（L Harness の管理APIは伏せて返すためここに貼る）
LINE_CHANNEL_SECRET=
# エルメ「Webhook転送」画面の署名シークレット（whsec_ で始まる）
LME_WEBHOOK_SECRET=
# （シークレットを再生成したときだけ）前のシークレット。bridge --deploy 後の2分だけ受け付ける。済んだら消す
LME_WEBHOOK_SECRET_PREVIOUS=
# （任意）wrangler のログインを使わず D1 に書き込む場合のみ
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
`;
