import type { SnapshotStore } from "../snapshot/store.js";
import type { PlanContext } from "./context.js";
import type { SourceSalon } from "../source/types.js";
import { harnessId } from "../harness/ids.js";
import { sourceToHarnessJst, parseSourceDate, toIsoUtc } from "../harness/time.js";

/**
 * エルメ「サロン・面談予約」→ L Harness の予約（menus / staff / staff_menus / staff_shifts / bookings）。
 *
 * エルメの形（MCP get_salon_detail, 2026-10 実測）:
 *   { id, calendar_name, manager_name, use_course, use_staff, setting_time_unit,
 *     menus: [{ menu_name, courses: [{ id, course_name, system_name, duration_minutes, amount, course_description, visible }] }],
 *     staff: [{ id, staff_name, staff_image, staff_description, staff_bill, is_all_course, course_ids }],
 *     forms: [...], booking_settings: { approve_type, ... }, time_free: { before_minutes, after_minutes }, created_at }
 * 予約（get_salon_bookings）は実測後に対応する（bookings[] の形が確定していない間は件数だけ報告）。
 */

/** エルメのコース（サロン予約・レッスン予約で共通の形） */
export interface SourceCourse {
  id: number;
  course_name?: string | null;
  system_name?: string | null;
  duration_minutes?: number | null;
  amount?: number | null;
  course_description?: string | null;
  course_image?: string | null;
  visible?: boolean;
}

interface SourceStaff {
  id: number;
  staff_name?: string | null;
  staff_image?: string | null;
  staff_description?: string | null;
  is_all_course?: boolean;
  course_ids?: number[] | string | null;
}

interface SourceSalonDetail {
  id: number;
  calendar_name?: string;
  manager_name?: string;
  use_course?: boolean;
  use_staff?: boolean;
  setting_time_unit?: number;
  menus?: Array<{ menu_name?: string | null; courses?: SourceCourse[] }>;
  staff?: SourceStaff[];
  booking_settings?: { approve_type?: string };
  time_free?: { before_minutes?: number | null; after_minutes?: number | null };
  shifts?: unknown;
  created_at?: string;
}

interface SourceBooking {
  // MCP get_salon_bookings（2026-10 実測）
  id: number;
  course_id?: number | null;
  course_name?: string | null;
  staff_id?: number | null;
  staff_name?: string | null;
  date_booking?: string | null; // "2026-10-20 14:00 ~ 15:00"
  lmessage_friend_id?: number | null;
  line_friend_id?: string | null;
  user_name?: string | null;
  status?: string | null; // admin_booked / booked / requested / cancel_requested / cancelled ...
  payment_status?: string | null;
  payment_amount?: number | null;
  form_answers?: Array<{ question?: string; answer?: unknown }> | null;
  created_at?: string | null;
}

/** "2026-10-20 14:00 ~ 15:00" → [開始, 終了]（JST） */
export function parseDateBooking(value: string | null | undefined): { start: number; end: number | null } | null {
  if (!value) return null;
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})(?::\d{2})?\s*[~〜-]\s*(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}:\d{2})?/);
  if (!m) {
    const t = parseSourceDate(value);
    return t === null ? null : { start: t, end: null };
  }
  const [, d1, t1, d2, t2] = m;
  const start = parseSourceDate(`${d1} ${t1.padStart(5, "0")}:00`);
  if (start === null) return null;
  const end = t2 ? parseSourceDate(`${d2 ?? d1} ${t2.padStart(5, "0")}:00`) : null;
  return { start, end };
}

/** コースの表示名（管理名 → システム名 → 「コースN」） */
export function courseName(c: SourceCourse): string {
  return (c.course_name ?? c.system_name ?? `コース${c.id}`).trim();
}

/** 金額・時間などを 0 以上の数にする（不正値は 0） */
export function nonNegative(value: unknown): number {
  return Math.max(0, Number(value ?? 0) || 0);
}

/** 予約フォームの回答を「質問: 回答」の行にする */
export function formAnswersText(answers: Array<{ question?: string; answer?: unknown }> | null | undefined): string {
  return (answers ?? []).map((a) => `${a.question ?? ""}: ${a.answer ?? ""}`).join("\n");
}

function courseIds(staff: SourceStaff): number[] {
  if (Array.isArray(staff.course_ids)) return staff.course_ids.map(Number).filter(Number.isFinite);
  if (typeof staff.course_ids === "string") return staff.course_ids.split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
  return [];
}

function bookingStatus(b: SourceBooking): "requested" | "confirmed" | "cancelled" | null {
  const st = String(b.status ?? "").toLowerCase();
  if (!st) return null;
  if (st.includes("cancel")) return "cancelled";
  if (st.includes("request") || st.includes("pending")) return "requested";
  if (st.includes("book") || st.includes("confirm") || st.includes("approv") || st.includes("fix")) return "confirmed";
  return null;
}

/** サロン 1 つ分の共通値 */
interface SalonInfo {
  sourceId: number;
  name: string;
  createdAt: string;
  /** 予約後の空き時間（分） */
  bufferAfter: number;
}

/** エルメのコース ID → 作ったメニュー */
type MenuByCourse = Map<number, { id: string; duration: number; price: number }>;

export function mapBookings(store: SnapshotStore, ctx: PlanContext): void {
  const salons = store.readJson<SourceSalon[]>("salons.json") ?? [];
  const r = ctx.report("bookings", "予約（サロン・面談）");
  r.source = salons.length;
  if (!salons.length) return;
  r.level = "partial";
  const nowMs = Date.now();
  for (const s of salons) {
    const d = (s.detail ?? {}) as SourceSalonDetail;
    const salon: SalonInfo = {
      sourceId: s.id,
      name: d.calendar_name ?? s.calendar_name ?? `サロン${s.id}`,
      createdAt: sourceToHarnessJst(d.created_at, ctx.now),
      bufferAfter: Number(d.time_free?.after_minutes ?? 0) || 0,
    };
    const menus = addSalonMenus(d, salon, ctx);
    const staffIds = addSalonStaff(d, salon, menus, ctx);
    const bookings = (s.bookings ?? []) as SourceBooking[];
    const migratedBookings = addSalonBookings(bookings, salon, menus, staffIds, ctx, nowMs);
    r.migrated += 1;
    if (bookings.length) r.notes.push(`「${salon.name}」の予約 ${bookings.length}件中 ${migratedBookings}件を移しました`);
  }
  r.notes.push("コース→メニュー、スタッフ→担当者として作りました。出勤時間（シフト）はエルメから取り出せないため、L Harness の管理画面で受付時間を設定してください");
  r.notes.push("予約フォームの質問・承認/キャンセル時の自動メッセージは移していません（L Harness 側の既定メッセージを使います）");
  r.notes.push("予約のリマインドは、並行運用中にエルメと二重に届かないよう作っていません。切り替え後に必要なら L Harness で設定してください");
}

/** コース → menus */
function addSalonMenus(d: SourceSalonDetail, salon: SalonInfo, ctx: PlanContext): MenuByCourse {
  const menus: MenuByCourse = new Map();
  let sort = 0;
  for (const m of d.menus ?? []) {
    for (const c of m.courses ?? []) {
      const menuId = harnessId("menu", salon.sourceId, c.id);
      const duration = Math.max(5, Number(c.duration_minutes ?? d.setting_time_unit ?? 30) || 30);
      const price = nonNegative(c.amount);
      if (!menus.has(c.id)) menus.set(c.id, { id: menuId, duration, price });
      ctx.add({
        table: "menus",
        values: {
          id: menuId,
          line_account_id: ctx.lineAccountId,
          name: courseName(c),
          category_label: m.menu_name?.trim() || salon.name,
          description: c.course_description ?? null,
          duration_minutes: duration,
          buffer_after_minutes: salon.bufferAfter,
          base_price: price,
          sort_order: sort++,
          is_active: c.visible === false ? 0 : 1,
          deleted_at: null,
          auto_tag_id: null,
          created_at: salon.createdAt,
          updated_at: ctx.now,
        },
        update: ["name", "category_label", "description", "duration_minutes", "buffer_after_minutes", "base_price", "is_active", "updated_at"],
      });
    }
  }
  return menus;
}

/** スタッフ → staff / staff_menus（個人タイプでも「運営者」が 1 人いる）。作った staff.id の並びを返す */
function addSalonStaff(d: SourceSalonDetail, salon: SalonInfo, menus: MenuByCourse, ctx: PlanContext): string[] {
  const staffList = d.staff?.length ? d.staff : [{ id: 0, staff_name: d.manager_name ?? "担当", is_all_course: true }];
  const staffIds: string[] = [];
  staffList.forEach((st, i) => {
    const staffId = harnessId("staff", salon.sourceId, st.id);
    staffIds.push(staffId);
    const name = (st.staff_name ?? `スタッフ${st.id}`).trim();
    ctx.add({
      table: "staff",
      values: {
        id: staffId,
        line_account_id: ctx.lineAccountId,
        name,
        display_name: name,
        role: null,
        profile_image_url: st.staff_image ?? null,
        bio: st.staff_description ?? null,
        sort_order: i,
        is_designation_optional: d.use_staff ? 0 : 1,
        is_active: 1,
        deleted_at: null,
        created_at: salon.createdAt,
        updated_at: ctx.now,
      },
      update: ["name", "display_name", "profile_image_url", "bio", "updated_at"],
    });
    const offered = st.is_all_course || !courseIds(st).length ? Array.from(menus.keys()) : courseIds(st);
    for (const cid of offered) {
      const menu = menus.get(cid);
      if (!menu) continue;
      ctx.add({
        table: "staff_menus",
        values: { staff_id: staffId, menu_id: menu.id, is_offered: 1, override_duration_minutes: null, override_price: null },
        conflict: ["staff_id", "menu_id"],
        update: ["is_offered"],
      });
    }
  });
  return staffIds;
}

/** 予約 → bookings。移した件数を返す */
function addSalonBookings(bookings: SourceBooking[], salon: SalonInfo, menus: MenuByCourse, staffIds: string[], ctx: PlanContext, nowMs: number): number {
  let migrated = 0;
  let noFriend = 0;
  for (const b of bookings) {
    const friendId = b.lmessage_friend_id && ctx.friendIds.has(b.lmessage_friend_id) ? ctx.friendId(b.lmessage_friend_id) : null;
    const menu = typeof b.course_id === "number" ? menus.get(b.course_id) : undefined;
    const staffId = typeof b.staff_id === "number" ? harnessId("staff", salon.sourceId, b.staff_id) : staffIds[0];
    const when = parseDateBooking(b.date_booking);
    const status = bookingStatus(b);
    if (!friendId) {
      noFriend += 1;
      continue;
    }
    if (!menu || !when || !status || !staffId) {
      ctx.note("bookings", "予約（サロン・面談）", "コース・日時・状態のどれかが分からない予約は移していません");
      continue;
    }
    const startMs = when.start;
    const endMs = when.end ?? startMs + menu.duration * 60_000;
    // 過去の確定予約は「完了」にする（期限切れ処理や通知の対象にしない）
    const finalStatus = status === "confirmed" && startMs < nowMs ? "completed" : status;
    const requestedAt = toIsoUtc(parseSourceDate(b.created_at) ?? startMs);
    const answers = formAnswersText(b.form_answers);
    ctx.add({
      table: "bookings",
      values: {
        id: harnessId("booking", salon.sourceId, b.id),
        line_account_id: ctx.lineAccountId,
        friend_id: friendId,
        staff_id: staffId,
        menu_id: menu.id,
        starts_at: toIsoUtc(startMs),
        ends_at: toIsoUtc(endMs),
        block_ends_at: toIsoUtc(endMs + salon.bufferAfter * 60_000),
        status: finalStatus,
        customer_note: answers || null,
        internal_note: [`L Message から移行（元ID ${b.id}）`, b.payment_status ? `決済: ${b.payment_status}` : ""].filter(Boolean).join("\n"),
        price_at_booking: nonNegative(b.payment_amount ?? menu.price),
        requested_at: requestedAt,
        decided_at: finalStatus === "requested" ? null : requestedAt,
        decided_by_staff_id: null,
        created_at: salon.createdAt,
        updated_at: ctx.now,
      },
      update: ["status", "updated_at"],
    });
    migrated += 1;
  }
  if (noFriend) ctx.note("bookings", "予約（サロン・面談）", `LINE の友だちに紐づかない予約（管理画面で手入力したお客様など）${noFriend}件は移していません（L Harness の予約は友だち必須）`);
  return migrated;
}
