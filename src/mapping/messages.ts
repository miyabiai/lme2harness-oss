import type { SourceMessage } from "../source/types.js";
import { convertSourceText } from "./text.js";
import { isHttpUrl } from "../util.js";

/**
 * エルメの 1 メッセージ → L Harness messages_log の (message_type, content) の列。
 * エルメの template（複数パーツ）は複数行に分ける。
 */
export interface LogPart {
  message_type: string;
  content: string;
}

const LABELS: Record<string, string> = {
  image: "[画像]",
  video: "[動画]",
  audio: "[音声]",
  file: "[ファイル]",
  pdf: "[PDF]",
  location: "[位置情報]",
  sticker: "[スタンプ]",
};

/** ステップ配信の開始・停止などの「出来事の記録」の種類（会話ではない） */
const EVENT_TYPES = new Set(["stop_scenario", "start_scenario", "scenario_empty_step", "event"]);

/**
 * 会話ではない記録か。エルメは「ステップ配信を開始した／停止した／空のステップ」を
 * message_type=scenario（中身は {"scenario_name":…,"from":…} の JSON 文字列）や
 * stop_scenario / scenario_empty_step として会話履歴に混ぜて返す（2026-10 実測）。
 */
export function isEventRecord(m: SourceMessage): boolean {
  const type = (m.message_type || "").toLowerCase();
  if (EVENT_TYPES.has(type)) return true;
  if (typeof m.content === "string" && m.content.startsWith("{")) {
    try {
      const j = JSON.parse(m.content) as Record<string, unknown>;
      return Boolean(j && typeof j === "object" && "scenario_name" in j);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * エルメのボタン型（カード）メッセージ → 文字。
 * 形: {type_button, data:[{title?, text?, buttons:[{label}]}]}（2026-10 実測）
 */
export function buttonsToText(content: unknown): string {
  const cards = ((content as { data?: unknown[] } | null)?.data ?? (Array.isArray(content) ? content : [])) as Array<Record<string, unknown>>;
  const blocks: string[] = [];
  for (const card of cards) {
    if (!card || typeof card !== "object") continue;
    const lines: string[] = [];
    for (const key of ["title", "text"]) {
      const v = card[key];
      if (typeof v === "string" && v.trim()) lines.push(convertSourceText(v).text);
    }
    const labels = (Array.isArray(card.buttons) ? card.buttons : [])
      .map((b) => (b && typeof b === "object" ? (b as { label?: unknown }).label : null))
      .filter((l): l is string => typeof l === "string" && l.trim().length > 0);
    if (labels.length) lines.push(labels.map((l) => `▶ ${l}`).join("\n"));
    if (lines.length) blocks.push(lines.join("\n"));
  }
  return blocks.length ? blocks.join("\n――\n") : "[ボタン]";
}

/** LINE の画像メッセージの中身（原寸・プレビューとも同じ URL）。 */
export function imageMessageContent(url: string): string {
  return JSON.stringify({ originalContentUrl: url, previewImageUrl: url });
}

function partFromTyped(type: string, content: unknown): LogPart | null {
  const t = (type || "text").toLowerCase();
  if (t === "text") {
    if (typeof content !== "string") return content == null ? null : { message_type: "text", content: JSON.stringify(content) };
    return { message_type: "text", content: convertSourceText(content).text };
  }
  if (t === "image") {
    if (typeof content === "string" && isHttpUrl(content)) return { message_type: "image", content: imageMessageContent(content) };
    const url = (content as { url?: string } | null)?.url;
    return url ? { message_type: "image", content: imageMessageContent(url) } : { message_type: "image", content: "[画像]" };
  }
  if (t === "sticker") {
    const c = (content ?? {}) as { packageId?: string | number; stickerId?: string | number };
    if (c.packageId && c.stickerId) {
      return {
        message_type: "sticker",
        content: JSON.stringify({ type: "sticker", packageId: String(c.packageId), stickerId: String(c.stickerId), fallback: "[スタンプ]" }),
      };
    }
    return { message_type: "sticker", content: "[スタンプ]" };
  }
  if (t === "flex") {
    return { message_type: "flex", content: typeof content === "string" ? content : JSON.stringify(content ?? {}) };
  }
  if (t === "buttons" || t === "button" || t === "card") {
    return { message_type: "text", content: buttonsToText(content) };
  }
  if (t === "pdf" || t === "file") {
    const c = (content ?? {}) as { url?: string; file_name_original?: string; file_name?: string };
    const name = c.file_name_original ?? c.file_name;
    const url = typeof content === "string" ? content : c.url;
    return { message_type: "file", content: `[ファイル${name ? `: ${name}` : ""}]${url ? ` ${url}` : ""}` };
  }
  if (t === "location") {
    const c = (content ?? {}) as { address?: string; title?: string; latitude?: number; longitude?: number };
    const bits = [c.title, c.address, c.latitude !== undefined ? `${c.latitude},${c.longitude}` : ""].filter(Boolean).join(" ");
    return { message_type: "location", content: `[位置情報]${bits ? ` ${bits}` : ""}` };
  }
  const label = LABELS[t] ?? `[${t}]`;
  if (typeof content === "string" && content) return { message_type: t, content: isHttpUrl(content) ? `${label} ${content}` : content };
  if (content && typeof content === "object") {
    const url = (content as { url?: string }).url;
    return { message_type: t, content: url ? `${label} ${url}` : `${label} ${JSON.stringify(content).slice(0, 500)}` };
  }
  return { message_type: t, content: label };
}

export function messageToLogParts(m: SourceMessage): LogPart[] {
  if (isEventRecord(m)) return [];
  const type = (m.message_type || "text").toLowerCase();
  const content = m.content;
  // エルメの template / scenario / broadcast / action は [{type, content}] の配列
  if (Array.isArray(content)) {
    const items = content as Array<{ type?: string; content?: unknown }>;
    // 「ステップ配信を開始した」等のイベント記録（type/content を持たない）は会話ではないので入れない
    if (!items.some((p) => p && typeof p === "object" && ("type" in p || "content" in p))) return [];
    const parts: LogPart[] = [];
    for (const p of items) {
      const part = partFromTyped(p?.type ?? "text", p?.content);
      if (part) parts.push(part);
    }
    return parts;
  }
  if (["template", "scenario", "broadcast", "action", "event"].includes(type)) {
    if (content == null) return [];
    if (typeof content === "string") return [{ message_type: "text", content: convertSourceText(content).text }];
    return [{ message_type: "text", content: JSON.stringify(content).slice(0, 2000) }];
  }
  const part = partFromTyped(type, content);
  return part ? [part] : [];
}

/** エルメの送信元情報 → messages_log.source。未対応判定は source='manual' を「人の返信」とみなす。 */
export function outgoingSource(m: SourceMessage): string {
  const src = (m.source ?? {}) as { type?: string | null; name?: string | null };
  const t = (src.type ?? "").toLowerCase();
  if (t.includes("scenario") || t.includes("step")) return "scenario";
  if (t.includes("broadcast") || t.includes("schedule")) return "broadcast";
  if (t.includes("auto") || t.includes("reply")) return "auto_reply";
  if (t === "template" && !m.sender_name) return "automation";
  return "manual";
}
