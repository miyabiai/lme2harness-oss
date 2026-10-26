import { join } from "node:path";
import { ensurePrivateDir, writePrivateFile } from "../util.js";
import type { SnapshotStore } from "../snapshot/store.js";
import { PlanContext, type EntityReport } from "./context.js";
import { mapAutoReplies, mapScenarios, mapTags, mapTemplates, mapTrafficSources, mapWelcome, templateTextById } from "./masters.js";
import { mapForms } from "./forms.js";
import { mapFriends } from "./friends.js";
import { mapBookings } from "./bookings.js";
import { mapLessons } from "./lessons.js";
import { chunkStatements, renderInsert, type Row, type SqlChunk } from "../sql/render.js";
import type { SourceRichMenu } from "../source/types.js";

/** テーブルの投入順（外部キーの親 → 子）。 */
const TABLE_ORDER = [
  "tags",
  "templates",
  "scenarios",
  "scenario_steps",
  "forms",
  "auto_replies",
  "entry_routes",
  "friends",
  "friend_tags",
  "chats",
  "messages_log",
  "friend_scenarios",
  "form_submissions",
  "menus",
  "staff",
  "staff_menus",
  "staff_availability_rules",
  "bookings",
  "booking_reminders",
  "events",
  "event_slots",
  "event_bookings",
];

export interface PlanManifest {
  generated_at: string;
  line_account_id: string;
  chunks: Array<{ file: string; table: string; statements: number; bytes: number }>;
  counts: Record<string, number>;
  reports: Record<string, EntityReport>;
  warnings: string[];
}

export interface BuildPlanOptions {
  lineAccountId: string;
  options: PlanContext["options"];
  existingTags?: Map<string, string>;
  now?: string;
}

export function buildPlan(store: SnapshotStore, opts: BuildPlanOptions): { ctx: PlanContext; rowsByTable: Map<string, Row[]> } {
  const ctx = new PlanContext(opts.lineAccountId, opts.options, opts.existingTags ?? new Map(), opts.now);
  mapTags(store, ctx);
  mapTemplates(store, ctx);
  mapScenarios(store, ctx);
  mapWelcome(store, ctx);
  mapAutoReplies(store, ctx, templateTextById(store));
  mapTrafficSources(store, ctx);
  mapFriends(store, ctx);
  mapForms(store, ctx);
  mapBookings(store, ctx);
  mapLessons(store, ctx);
  noteUnmigrated(store, ctx);

  const rowsByTable = new Map<string, Row[]>();
  for (const row of ctx.rows) {
    const list = rowsByTable.get(row.table) ?? [];
    list.push(row);
    rowsByTable.set(row.table, list);
  }
  return { ctx, rowsByTable };
}

function noteUnmigrated(store: SnapshotStore, ctx: PlanContext): void {
  const rich = store.readJson<SourceRichMenu[]>("rich_menus.json") ?? [];
  const r = ctx.report("rich_menus", "リッチメニュー");
  r.source = rich.length;
  r.level = rich.length ? "partial" : "full";
  if (rich.length) {
    r.notes.push("LINE 上のリッチメニューはそのまま表示され続けます。`lme2harness richmenu`（migrate に含む）で L Harness の管理画面に取り込めます（LINE 上の表示は変わりません）");
    r.notes.push("「友だち追加時にこのメニューを出す」等の表示ルールは移せないので、切り替え後に L Harness の自動化で作り直してください。タブ切替を含むメニューは取り込めません（画像 URL と構成は out/rich_menus.json）");
  }
  const products = store.readJson<unknown[]>("products.json") ?? [];
  const pr = ctx.report("products", "商品・決済");
  pr.source = products.length;
  pr.level = products.length ? "none" : "full";
  if (products.length) pr.notes.push("L Harness に商品機能は無いため移していません（購入履歴は友だちのメタデータ _lme.purchase_history に残しています）");
}

/**
 * SQL ファイル名の先頭番号。表ごとに固定（TABLE_ORDER の位置）にする。
 * 連番にすると、再変換で空になった表（例: 既存タグを使い回して tags が 0 行）があるだけで
 * 後ろの全ファイルの名前がずれ、apply が「流し済み」を見分けられず全部流し直してしまう。
 */
export function chunkPrefix(table: string): string {
  const i = TABLE_ORDER.indexOf(table);
  return String(i >= 0 ? i + 1 : 90 + ((hashTable(table) % 9))).padStart(2, "0");
}

function hashTable(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

export function writePlan(outDir: string, ctx: PlanContext, rowsByTable: Map<string, Row[]>, store: SnapshotStore): PlanManifest {
  // 生成物には顧客の名前・会話・回答が入るので、本人だけが読めるようにする
  ensurePrivateDir(outDir);
  ensurePrivateDir(join(outDir, "sql"));
  const chunks: PlanManifest["chunks"] = [];
  const counts: Record<string, number> = {};
  const tables = [...TABLE_ORDER, ...Array.from(rowsByTable.keys()).filter((t) => !TABLE_ORDER.includes(t))];
  for (const table of tables) {
    const rows = rowsByTable.get(table);
    if (!rows?.length) continue;
    // 同じ行への追記更新（例: フォームの回答数）を二重に数えない
    counts[table] = new Set(rows.map((r) => JSON.stringify((r.conflict ?? ["id"]).map((c) => r.values[c])))).size;
    const statements = rows.map(renderInsert);
    const sqlChunks: SqlChunk[] = chunkStatements(statements, `${chunkPrefix(table)}_${table}`);
    for (const c of sqlChunks) {
      const file = join("sql", c.name);
      writePrivateFile(join(outDir, file), c.statements.join("\n") + "\n");
      chunks.push({ file, table, statements: c.statements.length, bytes: c.bytes });
    }
  }
  // 手動対応用の書き出し
  const rich = store.readJson<unknown>("rich_menus.json");
  if (rich) writePrivateFile(join(outDir, "rich_menus.json"), JSON.stringify(rich, null, 2));
  const salons = store.readJson<unknown>("salons.json");
  const lessons = store.readJson<unknown>("lesson_calendars.json");
  if (salons || lessons) writePrivateFile(join(outDir, "bookings.json"), JSON.stringify({ salons, lessons }, null, 2));

  const manifest: PlanManifest = {
    generated_at: ctx.now,
    line_account_id: ctx.lineAccountId,
    chunks,
    counts,
    reports: Object.fromEntries(ctx.reports),
    warnings: ctx.warnings,
  };
  writePrivateFile(join(outDir, "plan.json"), JSON.stringify(manifest, null, 2));
  writePrivateFile(join(outDir, "report.md"), renderReport(manifest));
  return manifest;
}

const LEVEL_LABEL: Record<EntityReport["level"], string> = { full: "○ 移行", partial: "△ 一部", none: "× 対象外", manual: "手動" };

export function renderReport(m: PlanManifest): string {
  const lines: string[] = [];
  lines.push("# 移行レポート（lme2harness plan）", "");
  lines.push(`生成: ${m.generated_at} / 対象 L Harness アカウント: ${m.line_account_id}`, "");
  lines.push("## 対応表", "");
  lines.push("| 項目 | エルメ側 | L Harness へ | 判定 |", "|---|---:|---:|---|");
  for (const r of Object.values(m.reports)) {
    const level = r.source === 0 ? "―" : LEVEL_LABEL[r.level];
    lines.push(`| ${r.label} | ${r.source} | ${r.migrated}${r.skipped ? `（除外 ${r.skipped}）` : ""} | ${level} |`);
  }
  lines.push("", "## 注意点", "");
  for (const r of Object.values(m.reports)) {
    if (!r.notes.length) continue;
    lines.push(`### ${r.label}`);
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  if (m.warnings.length) {
    lines.push("## 警告", "");
    for (const w of m.warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  lines.push("## 生成した SQL", "");
  lines.push("| ファイル | テーブル | 文数 |", "|---|---|---:|");
  for (const c of m.chunks) lines.push(`| ${c.file} | ${c.table} | ${c.statements} |`);
  lines.push("", "`lme2harness apply` で上から順に D1 へ流します。何度流しても同じ結果になります。", "");
  return lines.join("\n");
}
