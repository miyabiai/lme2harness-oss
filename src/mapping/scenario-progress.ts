import type { LmeMessage } from "../lme/types.js";
import type { MigratedStep, ScenarioStepsInfo } from "./context.js";
import { messageToLogParts } from "./messages.js";
import { JST_OFFSET_MS, parseLmeDate } from "../harness/time.js";
import { isHttpUrl } from "../util.js";

/**
 * ステップ配信の「どこまで送ったか」を会話履歴から復元する。
 *
 * エルメは進行状態（何通目か）を出さないが、会話履歴にはステップで送った本文が
 * `message_type=scenario`・`source.type=scenario`・`source.name=シナリオ名` で残っている。
 * これを移したステップの中身と順番どおりに突き合わせ、最後に届いたステップを決める。
 *
 * - 同じ本文のステップ（1通目と4通目が同じ等）があるので、照合は「前回の位置から先」だけを見る
 * - 差し込み（名前など）は置き換わって届くので、テンプレートの文字が順番どおりに 9 割含まれるかで判定する
 * - 会話履歴の保存期間（エルメは半年ほど）より前に始まった人は「分からない」を返す
 */
export interface ProgressResult {
  /** 最後に届いたステップの位置（steps の添字）。-1 = まだ1通も届いていない */
  lastIndex: number;
  /** 最後に届いた日時（epoch ms） */
  lastAt: number | null;
  /** 何通分の送信記録を照合できたか */
  matched: number;
}

const VAR_RE = /\{\{[^}]*\}\}|\[[A-Z_]{3,}[A-Za-z0-9_]*\]/g;

function norm(s: string): string {
  return s.replace(/\s+/g, "");
}

/** ステップの中身 1 つと、届いたメッセージ 1 つが同じものか */
export function partMatches(step: { message_type: string; message_content: string }, sent: { message_type: string; content: string }): boolean {
  if (step.message_type === "text") {
    if (sent.message_type !== "text") return false;
    const tpl = norm(step.message_content.replace(VAR_RE, ""));
    const body = norm(sent.content);
    if (!tpl.length) return false;
    // 差し込み（名前など）や書式の違いがあっても、テンプレートの文字の 9 割以上が順番どおり含まれていれば同じとみなす
    if (body.length > tpl.length * 2 + 100) return false;
    return lcsLength(tpl, body) / tpl.length >= 0.9;
  }
  if (step.message_type === "image") {
    return sent.message_type === "image" && urlOf(step.message_content) !== null && urlOf(step.message_content) === urlOf(sent.content);
  }
  // Flex 等は中身の比較が難しいので種類だけ（単独では決め手にしない）
  return false;
}

/** 最長共通部分列の長さ（文字単位）。長文は先頭 2000 文字で打ち切る */
export function lcsLength(a: string, b: string): number {
  const x = a.slice(0, 2000);
  const y = b.slice(0, 2000);
  let prev = new Uint16Array(y.length + 1);
  let cur = new Uint16Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[y.length];
}

function urlOf(json: string): string | null {
  try {
    return (JSON.parse(json) as { originalContentUrl?: string }).originalContentUrl ?? null;
  } catch {
    return isHttpUrl(json) ? json : null;
  }
}

function stepMatches(step: MigratedStep, parts: Array<{ message_type: string; content: string }>): boolean {
  return step.parts.some((sp) => parts.some((p) => partMatches(sp, p)));
}

/** シナリオの送信記録か（開始・停止のイベント記録は除く） */
function isStepSend(m: LmeMessage, scenarioName: string): boolean {
  if (m.sender !== "bot") return false;
  const src = (m.source ?? {}) as { type?: string | null; name?: string | null };
  const isScenario = (m.message_type ?? "").toLowerCase() === "scenario" || (src.type ?? "").toLowerCase().includes("scenario");
  if (!isScenario) return false;
  if (src.name && src.name !== scenarioName) return false;
  return Array.isArray(m.content);
}

/** 「このシナリオを開始した」という記録か（中身は JSON 文字列で scenario_name を持つ） */
export function isStartEvent(m: LmeMessage, scenarioName: string): boolean {
  if (typeof m.content !== "string" || !m.content.startsWith("{")) return false;
  try {
    const j = JSON.parse(m.content) as { scenario_name?: string; start_day?: unknown };
    return j.scenario_name === scenarioName && "start_day" in j;
  } catch {
    return false;
  }
}

export function restoreProgress(info: ScenarioStepsInfo, messages: LmeMessage[], startedAtMs: number | null): ProgressResult | null {
  const sends = messages
    .filter((m) => isStepSend(m, info.name))
    .map((m) => ({ at: parseLmeDate(m.sent_at), parts: messageToLogParts(m) }))
    .filter((m) => m.at !== null && (startedAtMs === null || m.at >= startedAtMs - 60_000))
    .sort((a, b) => a.at! - b.at!);

  let last = -1;
  let lastAt: number | null = null;
  let matched = 0;
  for (const s of sends) {
    // 次のステップから先を優先して探し、無ければ同じステップの続き（1ステップ複数メッセージ）とみなす
    const order = [...Array.from({ length: info.steps.length - (last + 1) }, (_, k) => last + 1 + k), ...(last >= 0 ? [last] : [])];
    for (const i of order) {
      if (stepMatches(info.steps[i], s.parts)) {
        last = i;
        lastAt = s.at;
        matched += 1;
        break;
      }
    }
  }
  if (last >= 0) return { lastIndex: last, lastAt, matched };

  // 1通も見つからないとき、履歴が開始時点までさかのぼれているなら「まだ0通」と言える
  const covered =
    messages.some((m) => isStartEvent(m, info.name)) ||
    (startedAtMs !== null && messages.some((m) => {
      const t = parseLmeDate(m.sent_at);
      return t !== null && t <= startedAtMs;
    }));
  return covered ? { lastIndex: -1, lastAt: null, matched: 0 } : null;
}

/**
 * 次のステップを送る予定時刻（epoch ms）。L Harness の computeNextDeliveryAt と同じ考え方。
 * - absolute_time: 開始日（JST）の offset_days 日後の delivery_time
 * - relative: 前のステップを送った時刻 + delay_minutes（まだ0通なら開始時刻から）
 * 過去になっても丸めない（L Harness は過去の予定を次の定期処理ですぐ送る）。
 */
export function nextDeliveryAt(info: ScenarioStepsInfo, next: MigratedStep, startedAtMs: number, lastAt: number | null): number {
  if (info.deliveryMode === "absolute_time") {
    const startJst = new Date(startedAtMs + JST_OFFSET_MS);
    const [h, m] = (next.timing.delivery_time ?? "00:00").split(":").map(Number);
    const target = Date.UTC(startJst.getUTCFullYear(), startJst.getUTCMonth(), startJst.getUTCDate() + (next.timing.offset_days ?? 0), h, m, 0, 0) - JST_OFFSET_MS;
    return target;
  }
  return (lastAt ?? startedAtMs) + (next.timing.delay_minutes ?? 0) * 60_000;
}
