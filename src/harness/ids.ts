import { createHash } from "node:crypto";

/**
 * エルメ側の ID から L Harness 側の ID を決定的に作る（UUID v5）。
 * 同じ入力なら何度 plan/apply しても同じ ID になるので、再実行が冪等になる。
 */
const NAMESPACE = "6f1c0a4e-4b1b-5a2d-9c1e-lme2harness0"; // 固定（意味は持たせない）

function uuidV5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/[^0-9a-f]/gi, "").padEnd(32, "0").slice(0, 32), "hex");
  const hash = createHash("sha1").update(Buffer.concat([nsBytes, Buffer.from(name, "utf8")])).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type IdKind =
  | "friend"
  | "tag"
  | "chat"
  | "message"
  | "scenario"
  | "scenario_step"
  | "friend_scenario"
  | "template"
  | "form"
  | "form_submission"
  | "auto_reply"
  | "entry_route"
  | "menu"
  | "staff"
  | "booking"
  | "event"
  | "event_slot"
  | "event_booking"
  | "rich_menu_group"
  | "rich_menu_page"
  | "rich_menu_area";

export function harnessId(kind: IdKind, ...parts: Array<string | number>): string {
  return uuidV5(NAMESPACE, `lme2harness:${kind}:${parts.join(":")}`);
}
