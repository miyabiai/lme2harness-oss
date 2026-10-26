import type { SnapshotStore } from "../snapshot/store.js";
import type { PlanContext } from "./context.js";
import type { SourceSalon } from "../source/types.js";
import { harnessId } from "../harness/ids.js";
import { sourceToHarnessJst, parseSourceDate, toIsoUtc } from "../harness/time.js";
import { courseName, formAnswersText, nonNegative, parseDateBooking, type SourceCourse } from "./bookings.js";

/**
 * エルメ「レッスン予約」→ L Harness の「イベント予約」（events / event_slots / event_bookings）。
 *
 * エルメの形（MCP、2026-10-13 実測）:
 *   get_lesson_calendar_detail: { id, calendar_name, line_name, courses: [{ id, course_name, duration_minutes, amount,
 *     course_image, course_description, visible }], forms: [...], booking_settings: { approve_type, cancel_type, ... } }
 *   get_lesson_calendar_bookings: bookings: [{ id, reception_id, course_id, course_name, booking_date: "2026-10-20 10:00 ~ 11:00",
 *     lmessage_friend_id, line_friend_id, user_name, status: "admin_booked" 等, payment_status, payment_amount, form_answers, created_at }]
 *
 * エルメの MCP は「受付枠」（日時・定員）そのものを返さない。予約に付いている reception_id と日時から
 * 予約が入っている枠だけを作る（定員は空＝上限なし）。予約の無い枠と定員は管理画面で足してもらう。
 *
 * コース 1 つ = イベント 1 つにする（L Harness のイベントは「決まった日時の枠に何人でも」の形で、レッスンと同じ）。
 * 並行運用中に L Harness から新しい予約を受け付けたりリマインドを送ったりしないよう、
 * イベントは非公開で作り、リマインドの予定は作らない（イベントを管理画面で保存し直すと作られる）。
 */
interface SourceLessonDetail {
  id: number;
  calendar_name?: string;
  line_name?: string;
  courses?: SourceCourse[];
  booking_settings?: { approve_type?: string };
  created_at?: string;
}

interface SourceLessonBooking {
  id: number;
  reception_id?: number | null;
  course_id?: number | null;
  booking_date?: string | null;
  lmessage_friend_id?: number | null;
  status?: string | null;
  payment_status?: string | null;
  payment_amount?: number | null;
  form_answers?: Array<{ question?: string; answer?: unknown }> | null;
  created_at?: string | null;
}

type EventBookingStatus = "requested" | "confirmed" | "cancelled" | "attended";

export function lessonBookingStatus(raw: string | null | undefined, startMs: number, nowMs: number): EventBookingStatus | null {
  const st = String(raw ?? "").toLowerCase();
  if (!st) return null;
  if (st.includes("cancel")) return st.includes("request") ? "confirmed" : "cancelled"; // キャンセル申請中はまだ予約が生きている
  if (st.includes("request") || st.includes("pending")) return "requested";
  if (st.includes("book") || st.includes("confirm") || st.includes("approv")) return startMs < nowMs ? "attended" : "confirmed";
  return null;
}

/** エルメのコース ID → 作ったイベント */
type EventByCourse = Map<number, { eventId: string; duration: number }>;

export function mapLessons(store: SnapshotStore, ctx: PlanContext, nowMs = Date.now()): void {
  const calendars = store.readJson<SourceSalon[]>("lesson_calendars.json") ?? [];
  const r = ctx.report("lessons", "レッスン予約");
  r.source = calendars.length;
  if (!calendars.length) return;
  r.level = "partial";
  let noFriend = 0;
  let unknown = 0;
  for (const cal of calendars) {
    const d = (cal.detail ?? {}) as SourceLessonDetail;
    const createdAt = sourceToHarnessJst(d.created_at, ctx.now);
    const courses = addLessonEvents(cal.id, d, createdAt, ctx);
    r.migrated += (d.courses ?? []).length;
    const skipped = addLessonBookings(cal.id, (cal.bookings ?? []) as SourceLessonBooking[], courses, createdAt, ctx, nowMs);
    noFriend += skipped.noFriend;
    unknown += skipped.unknown;
  }
  r.notes.push("コース 1 つを L Harness のイベント 1 つにし、予約が入っている日時の枠と予約を移しました。イベントは非公開で作っています（並行運用中に L Harness で新しい予約を受け付けないため）");
  r.notes.push("エルメは受付枠の一覧と定員を出さないため、予約の無い枠と定員は移せていません。切り替え時に L Harness の管理画面で枠と定員を足してから公開してください");
  r.notes.push("リマインドは二重に届かないよう作っていません。切り替え後に管理画面でイベントを保存し直すと、確定済みの予約にリマインドが作られます");
  if (noFriend) r.notes.push(`LINE の友だちに紐づかない予約 ${noFriend}件は移していません（L Harness の予約は友だち必須）`);
  if (unknown) r.notes.push(`コース・日時・状態のどれかが分からない予約 ${unknown}件は移していません`);
  r.notes.push("決済の状態は予約のメモに残しています（L Harness の予約に決済の項目はありません）");
}

/** コース → events（非公開で作る） */
function addLessonEvents(calendarId: number, d: SourceLessonDetail, createdAt: string, ctx: PlanContext): EventByCourse {
  const requiresApproval = d.booking_settings?.approve_type && d.booking_settings.approve_type !== "auto" ? 1 : 0;
  const courses: EventByCourse = new Map();
  (d.courses ?? []).forEach((c, i) => {
    const eventId = harnessId("event", "lesson", calendarId, c.id);
    const amount = nonNegative(c.amount);
    courses.set(c.id, { eventId, duration: Math.max(5, Number(c.duration_minutes ?? 60) || 60) });
    const desc = [c.course_description?.trim(), amount ? `料金: ${amount.toLocaleString("ja-JP")}円` : ""].filter(Boolean).join("\n\n");
    ctx.add({
      table: "events",
      values: {
        id: eventId,
        line_account_id: ctx.lineAccountId,
        name: courseName(c),
        venue_name: d.line_name ?? d.calendar_name ?? null,
        venue_url: null,
        image_url: c.course_image ?? null,
        description: desc || null,
        max_bookings_per_friend: null,
        requires_approval: requiresApproval,
        cancel_deadline_hours_before: null,
        reminder_day_before_enabled: 1,
        reminder_hours_before: null,
        is_published: 0,
        sort_order: i,
        deleted_at: null,
        created_at: createdAt,
        updated_at: ctx.now,
      },
      update: ["name", "venue_name", "image_url", "description", "requires_approval", "updated_at"],
    });
  });
  return courses;
}

/** 予約 → event_slots（予約がある枠だけ）/ event_bookings。移せなかった件数を返す */
function addLessonBookings(
  calendarId: number,
  bookings: SourceLessonBooking[],
  courses: EventByCourse,
  createdAt: string,
  ctx: PlanContext,
  nowMs: number,
): { noFriend: number; unknown: number } {
  let noFriend = 0;
  let unknown = 0;
  const slots = new Set<string>();
  for (const b of bookings) {
    const course = typeof b.course_id === "number" ? courses.get(b.course_id) : undefined;
    const when = parseDateBooking(b.booking_date);
    if (!b.lmessage_friend_id || !ctx.friendIds.has(b.lmessage_friend_id)) {
      noFriend += 1;
      continue;
    }
    const status = when ? lessonBookingStatus(b.status, when.start, nowMs) : null;
    if (!course || !when || !status) {
      unknown += 1;
      continue;
    }
    const endMs = when.end ?? when.start + course.duration * 60_000;
    const slotKey = b.reception_id ?? `${b.course_id}:${when.start}`;
    const slotId = harnessId("event_slot", "lesson", calendarId, slotKey);
    if (!slots.has(slotId)) {
      slots.add(slotId);
      ctx.add({
        table: "event_slots",
        values: { id: slotId, event_id: course.eventId, starts_at: toIsoUtc(when.start), ends_at: toIsoUtc(endMs), capacity: null, is_active: 1, sort_order: 0, deleted_at: null, created_at: createdAt, updated_at: ctx.now },
        update: ["starts_at", "ends_at", "updated_at"],
      });
    }
    const friendId = ctx.friendId(b.lmessage_friend_id);
    const at = toIsoUtc(parseSourceDate(b.created_at) ?? when.start);
    const answers = formAnswersText(b.form_answers);
    ctx.add({
      table: "event_bookings",
      values: {
        id: harnessId("event_booking", "lesson", calendarId, b.id),
        line_account_id: ctx.lineAccountId,
        event_id: course.eventId,
        slot_id: slotId,
        friend_id: friendId,
        status,
        customer_note: answers || null,
        internal_note: [`L Message から移行（元ID ${b.id}）`, b.payment_status ? `決済: ${b.payment_status}${b.payment_amount ? ` ${b.payment_amount}円` : ""}` : ""].filter(Boolean).join("\n"),
        requested_at: at,
        decided_at: status === "requested" ? null : at,
        decided_by_staff_id: null,
        cancelled_at: status === "cancelled" ? at : null,
        cancelled_by: null,
        identity_key: `solo:${friendId}`,
        created_at: createdAt,
        updated_at: ctx.now,
      },
      update: ["status", "updated_at"],
    });
  }
  return { noFriend, unknown };
}
