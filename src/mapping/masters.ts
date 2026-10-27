import type { SnapshotStore } from "../snapshot/store.js";
import type { MigratedStep, PlanContext, ScenarioStepsInfo } from "./context.js";
import type {
  SourceAction,
  SourceAutoReply,
  SourceField,
  SourceHandlingStatus,
  SourceScenarioDetail,
  SourceScenarioListItem,
  SourceScenarioStep,
  SourceTag,
  SourceTemplateDetail,
  SourceTrafficSource,
  SourceWelcomeMessage,
} from "../source/types.js";
import { quote, type Row, type SqlValue } from "../sql/render.js";
import { harnessId } from "../harness/ids.js";
import { sourceToHarnessJst } from "../harness/time.js";
import { convertSourceText } from "./text.js";
import { imageMessageContent } from "./messages.js";
import { isHttpUrl } from "../util.js";

/** アクション配列から tag 付与のタグ ID を取り出す。 */
export function tagIdsFromActions(actions: SourceAction[] | undefined): number[] {
  const out: number[] = [];
  for (const a of actions ?? []) {
    if (a.type !== "tag") continue;
    const data = a.data as { ids?: Array<string | number>; action?: number } | undefined;
    if (data?.action !== undefined && Number(data.action) !== 1) continue; // 1=付与、他=解除
    for (const id of data?.ids ?? []) {
      const n = Number(id);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

export function textFromActions(actions: SourceAction[] | undefined): string | null {
  for (const a of actions ?? []) {
    if (a.type === "text" && typeof a.content === "string" && a.content.trim()) return a.content;
  }
  return null;
}

/** エルメのタグ ID の並びの先頭を L Harness の tags.id にする（移していなければ null）。 */
export function firstMappedTagId(ctx: PlanContext, sourceTagIds: number[]): string | null {
  return sourceTagIds.length ? (ctx.tagIds.get(sourceTagIds[0]) ?? null) : null;
}

// ---------- タグ ----------
export function mapTags(store: SnapshotStore, ctx: PlanContext): void {
  const tags = store.readJson<SourceTag[]>("tags.json") ?? [];
  const r = ctx.report("tags", "タグ");
  r.source = tags.length;
  const usedNames = new Set<string>(ctx.existingTags.keys());
  for (const t of tags) {
    let name = (t.name ?? "").trim() || `タグ${t.id}`;
    const existing = ctx.existingTags.get(name);
    if (existing && ctx.options.reuse_existing_tags) {
      ctx.tagIds.set(t.id, existing);
      ctx.note("tags", "タグ", "同名の既存タグがあるものは再利用しました");
      continue;
    }
    if (usedNames.has(name) && !existing) {
      // エルメ内の重複名
      let i = 2;
      while (usedNames.has(`${name} (${i})`)) i++;
      name = `${name} (${i})`;
      ctx.note("tags", "タグ", "同名のタグが複数あったため「(2)」を付けて区別しました");
    }
    usedNames.add(name);
    const id = harnessId("tag", t.id);
    ctx.tagIds.set(t.id, id);
    ctx.add({
      table: "tags",
      values: { id, name, color: "#3B82F6", created_at: sourceToHarnessJst(t.created_at, ctx.now) },
      conflict: ["id"],
      update: ["name"],
    });
    r.migrated += 1;
  }
  if (ctx.options.handling_status_as_tag) mapHandlingStatusTags(store, ctx);
  const fields = store.readJson<SourceField[]>("fields.json") ?? [];
  for (const f of fields) ctx.fieldTitles.set(f.id, f.title);
}

/** 対応ステータスをタグとしても持つ（「対応:◯◯」）。 */
function mapHandlingStatusTags(store: SnapshotStore, ctx: PlanContext): void {
  const statuses = store.readJson<SourceHandlingStatus[]>("handling_statuses.json") ?? [];
  const hr = ctx.report("handling_statuses", "対応ステータス");
  hr.source = statuses.length;
  hr.level = statuses.length ? "partial" : "full";
  for (const s of statuses) {
    const name = `対応:${s.name}`;
    let id = ctx.existingTags.get(name);
    if (!id) {
      id = harnessId("tag", "handling_status", s.id);
      ctx.add({ table: "tags", values: { id, name, color: "#F59E0B", created_at: ctx.now }, conflict: ["id"], update: ["name"] });
    }
    ctx.handlingStatusTagIds.set(s.name, id);
    hr.migrated += 1;
  }
  if (statuses.length) hr.notes.push("L Harness に対応ステータス機能は無いため、「対応:◯◯」タグとメタデータで表現しました");
}

// ---------- テンプレート ----------
interface TemplatePart {
  message_type: "text" | "image" | "flex" | "carousel";
  message_content: string;
}

function urlFromMedia(t: SourceTemplateDetail): string | null {
  const data = (t.data ?? {}) as { message_media?: { url?: string; original_url?: string; image_url?: string; preview_url?: string } };
  const m = data.message_media ?? {};
  const url = m.url ?? m.original_url ?? m.image_url ?? (typeof t.content === "string" && isHttpUrl(t.content) ? t.content : null);
  return url ?? null;
}

/** 文字テンプレートの本文（data.message_text か content）。無ければ空文字。 */
function templateText(t: SourceTemplateDetail): string {
  const data = (t.data ?? {}) as { message_text?: { content?: string } };
  return (data.message_text?.content ?? (typeof t.content === "string" ? t.content : "")) as string;
}

/** テンプレート ID → 最初の文字メッセージの本文（自動応答の返信に使う。group は最初の文字の子）。 */
export function templateTextById(store: SnapshotStore): Map<number, string> {
  const out = new Map<number, string>();
  for (const t of store.readJson<SourceTemplateDetail[]>("template_details.json") ?? []) {
    const first = t.type === "group" ? t.children?.find((c) => c.type === "text") : t.type === "text" ? t : undefined;
    const text = first ? templateText(first) : "";
    if (text) out.set(t.id, text);
  }
  return out;
}

/** 単体テンプレート（group の子を含む）→ L Harness の templates 1 行分。 */
export function templateToPart(t: SourceTemplateDetail, ctx: PlanContext): TemplatePart | null {
  const type = (t.type ?? "text").toLowerCase();
  const data = (t.data ?? {}) as Record<string, unknown>;
  if (type === "text") {
    const text = templateText(t);
    if (!text.trim()) return null;
    const conv = convertSourceText(text);
    if (conv.unknown.length) ctx.note("templates", "テンプレート", `不明な差し込みタグをそのまま残しました: ${conv.unknown.join(" ")}`);
    return { message_type: "text", message_content: conv.text };
  }
  if (type === "image") {
    const url = urlFromMedia(t);
    if (!url) return null;
    return { message_type: "image", message_content: imageMessageContent(url) };
  }
  if (type === "flex" || type === "carousel") {
    const flex = data.message_flex ?? data.flex ?? data.contents ?? t.content;
    if (!flex) return null;
    return { message_type: "flex", message_content: typeof flex === "string" ? flex : JSON.stringify(flex) };
  }
  // ボタン・カード・動画・音声・位置情報・フォーム等: テキストで代替
  const text = ((data.message_text as { content?: string } | undefined)?.content ?? "") as string;
  const url = urlFromMedia(t);
  if (text.trim()) return { message_type: "text", message_content: convertSourceText(text).text + (url ? `\n${url}` : "") };
  if (url) return { message_type: "text", message_content: url };
  return null;
}

export function mapTemplates(store: SnapshotStore, ctx: PlanContext): void {
  const details = store.readJson<Array<SourceTemplateDetail & { category_name?: string }>>("template_details.json");
  const r = ctx.report("templates", "テンプレート");
  if (!details) {
    const list = store.readJson<unknown[]>("templates.json") ?? [];
    r.source = list.length;
    r.level = list.length ? "none" : "full";
    if (list.length) r.notes.push("テンプレートの中身は公式MCPでのみ取得できます（`lme2harness login` 後に再度 extract）");
    return;
  }
  r.source = details.length;
  for (const t of details) {
    const category = (t.category_name ?? "general").replace(/^\(Uncategorized\)$/, "general") || "general";
    const name = (t.name ?? "").trim() || `テンプレート${t.id}`;
    const parts: Array<{ part: TemplatePart; child: SourceTemplateDetail | null }> = [];
    if (t.type === "group" && Array.isArray(t.children)) {
      for (const c of t.children) {
        const p = templateToPart(c, ctx);
        if (p) parts.push({ part: p, child: c });
      }
    } else {
      const p = templateToPart(t, ctx);
      if (p) parts.push({ part: p, child: null });
    }
    if (!parts.length) {
      r.skipped += 1;
      ctx.note("templates", "テンプレート", "文字・画像・Flex 以外だけのテンプレートは移せませんでした（ボタン・カード等）");
      continue;
    }
    parts.forEach(({ part, child }, i) => {
      const id = harnessId("template", t.id, child?.id ?? 0);
      if (i === 0) ctx.templateIds.set(t.id, id);
      if (child) ctx.templateIds.set(child.id, id);
      ctx.add({
        table: "templates",
        values: {
          id,
          name: parts.length > 1 ? `${name} (${i + 1}/${parts.length})` : name,
          category,
          message_type: part.message_type,
          message_content: part.message_content,
          created_at: sourceToHarnessJst(t.updated_at, ctx.now),
          updated_at: ctx.now,
        },
      });
    });
    r.migrated += 1;
    if (parts.length > 1) ctx.note("templates", "テンプレート", "複数メッセージのテンプレートは「名前 (1/n)」の形で分割しました");
    if (parts.some((p) => p.part.message_type === "image")) ctx.note("templates", "テンプレート", "画像はエルメの URL を参照しています。エルメ解約後は表示できなくなるので、管理画面で画像を登録し直してください");
  }
}

// ---------- ステップ配信 ----------
type DeliveryMode = ScenarioStepsInfo["deliveryMode"];

/** 流す時点で、そのシナリオが L Harness で有効になっているか（SQL の式） */
export function scenarioActiveSql(scenarioId: string): string {
  return `EXISTS (SELECT 1 FROM scenarios WHERE id = ${quote(scenarioId)} AND is_active = 1)`;
}

/**
 * L Harness で有効にした（動いている）シナリオは、移行し直しても設定を書き換えない。
 * 「最初から有効にする」設定（activate_automations）のときは、これまでどおり書き換える。
 */
function keepActiveScenario(ctx: PlanContext): Partial<Row> {
  return ctx.options.activate_automations ? {} : { updateWhere: "scenarios.is_active = 0" };
}

/** 有効にしたシナリオには、ステップを足すことも書き換えることもしない（動いている配信を変えないため） */
function keepActiveScenarioSteps(ctx: PlanContext, scenarioId: string): Partial<Row> {
  if (ctx.options.activate_automations) return {};
  return { insertWhere: `NOT ${scenarioActiveSql(scenarioId)}`, updateWhere: "(SELECT is_active FROM scenarios WHERE scenarios.id = scenario_steps.scenario_id) = 0" };
}

/** scenarios の 1 行（ステップ配信・あいさつで列の並びを揃える） */
function scenarioValues(
  ctx: PlanContext,
  v: { id: string; name: string; description: string; trigger_type: string; delivery_mode: DeliveryMode; created_at: string },
): Record<string, SqlValue> {
  return {
    id: v.id,
    name: v.name,
    description: v.description,
    trigger_type: v.trigger_type,
    trigger_tag_id: null,
    is_active: ctx.options.activate_automations ? 1 : 0,
    delivery_mode: v.delivery_mode,
    line_account_id: ctx.lineAccountId,
    created_at: v.created_at,
    updated_at: ctx.now,
  };
}

/** scenario_steps の 1 行（条件分岐・テンプレート参照は使わない） */
function scenarioStepValues(
  ctx: PlanContext,
  v: {
    id: string;
    scenario_id: string;
    step_order: number;
    delay_minutes: number;
    message_type: string;
    message_content: string;
    timing: Pick<MigratedStep["timing"], "offset_days" | "offset_minutes" | "delivery_time">;
    on_reach_tag_id: string | null;
  },
): Record<string, SqlValue> {
  return {
    id: v.id,
    scenario_id: v.scenario_id,
    step_order: v.step_order,
    delay_minutes: v.delay_minutes,
    message_type: v.message_type,
    message_content: v.message_content,
    offset_days: v.timing.offset_days,
    offset_minutes: v.timing.offset_minutes,
    delivery_time: v.timing.delivery_time,
    template_id: null,
    on_reach_tag_id: v.on_reach_tag_id,
    condition_type: null,
    condition_value: null,
    next_step_on_false: null,
    created_at: ctx.now,
  };
}

export function mapScenarios(store: SnapshotStore, ctx: PlanContext): void {
  const list = store.readJson<SourceScenarioListItem[]>("scenarios.json") ?? [];
  const details = store.readJson<SourceScenarioDetail[]>("scenario_details.json");
  const r = ctx.report("scenarios", "ステップ配信");
  r.source = list.length;
  if (!details) {
    r.level = list.length ? "none" : "full";
    if (list.length) r.notes.push("ステップの中身は公式MCPでのみ取得できます");
    return;
  }
  const byId = new Map(details.map((d) => [d.id, d]));
  for (const s of list) {
    mapScenario(s, byId.get(s.id), ctx);
    r.migrated += 1;
  }
  r.notes.push("配信トリガーはすべて「手動」で、停止状態で入れています（並行運用中の二重送信を防ぐため）。切替後に管理画面で有効化してください");
  if (!ctx.options.activate_automations) r.notes.push("L Harness で有効にしたシナリオは、移行し直しても設定・ステップを変えず、新しく入る人は「一時停止」で入れます（エルメ側で変えた分は、L Harness で止めてから移行し直すか、管理画面で直してください）");
}

/** シナリオ 1 つ → scenarios 1 行 + scenario_steps。移したステップの並びを ctx.scenarioSteps に残す。 */
function mapScenario(s: SourceScenarioListItem, detail: SourceScenarioDetail | undefined, ctx: PlanContext): void {
  const steps = [...(detail?.steps ?? [])].sort((a, b) => a.order_number - b.order_number);
  const scenarioId = harnessId("scenario", s.id);
  ctx.scenarioIds.set(s.id, scenarioId);
  const deliveryMode: DeliveryMode = steps.some((st) => st.delay_type === "date_based") ? "absolute_time" : "relative";
  ctx.add({
    table: "scenarios",
    values: scenarioValues(ctx, {
      id: scenarioId,
      name: s.name,
      description: `L Message から移行（元ID ${s.id}）`,
      trigger_type: "manual",
      delivery_mode: deliveryMode,
      created_at: sourceToHarnessJst(s.created_at, ctx.now),
    }),
    update: ["name", "description", "delivery_mode", "updated_at"],
    ...keepActiveScenario(ctx),
  });
  const migratedSteps: MigratedStep[] = [];
  ctx.scenarioSteps.set(s.id, { name: s.name, deliveryMode, steps: migratedSteps });
  let order = 0;
  for (const st of steps) {
    const migrated = mapScenarioStep(s.id, scenarioId, st, deliveryMode, order, ctx);
    if (!migrated) continue;
    migratedSteps.push(migrated);
    order = migrated.lastOrder;
  }
  if (!steps.length) ctx.note("scenarios", "ステップ配信", "ステップが空のシナリオは枠だけ作りました");
}

/**
 * ステップ 1 つ → scenario_steps（メッセージ 1 通 = 1 行）。
 * prevOrder は直前までの step_order。行を作らなかったら null。
 */
function mapScenarioStep(
  sourceScenarioId: number,
  scenarioId: string,
  st: SourceScenarioStep,
  mode: DeliveryMode,
  prevOrder: number,
  ctx: PlanContext,
): MigratedStep | null {
  const tagIds = tagIdsFromActions(st.actions);
  const onReachTag = firstMappedTagId(ctx, tagIds);
  if (tagIds.length > 1) ctx.note("scenarios", "ステップ配信", "1ステップに複数のタグ付与があるものは最初のタグだけ移しました");
  const timing = stepTiming(st, mode);
  const parts = st.templates.map((t) => templateToPart({ id: t.id, type: t.type, content: t.content, data: undefined }, ctx)).filter((p): p is TemplatePart => Boolean(p));
  if (!parts.length) {
    if (!onReachTag) return null; // 何もしないステップ
    // タグ付けだけのステップ: L Harness は空のメッセージを送れないので移さず、記録だけ残す
    ctx.note("scenarios", "ステップ配信", "メッセージ無しでタグだけ付けるステップは L Harness に無いため移していません（自動化ルールで代替してください）");
    return null;
  }
  let order = prevOrder;
  parts.forEach((part, i) => {
    order += 1;
    ctx.add({
      table: "scenario_steps",
      values: scenarioStepValues(ctx, {
        id: harnessId("scenario_step", sourceScenarioId, st.id, i),
        scenario_id: scenarioId,
        step_order: order,
        delay_minutes: i === 0 ? timing.delay_minutes : 0,
        message_type: part.message_type === "carousel" ? "flex" : part.message_type,
        message_content: part.message_content,
        timing,
        on_reach_tag_id: i === parts.length - 1 ? onReachTag : null,
      }),
      conflict: ["id"],
      ...keepActiveScenarioSteps(ctx, scenarioId),
    });
  });
  if (st.filters && st.filters.length) ctx.note("scenarios", "ステップ配信", "ステップの配信条件（フィルタ）は移していません。必要なら条件分岐で設定し直してください");
  return { sourceStepId: st.id, orderNumber: st.order_number, lastOrder: order, parts: parts.map((p) => ({ message_type: p.message_type, message_content: p.message_content })), timing };
}

function stepTiming(st: SourceScenarioStep, mode: DeliveryMode): MigratedStep["timing"] {
  if (mode === "absolute_time") {
    if (st.delay_type === "date_based") {
      const hhmm = (st.start_time ?? "00:00:00").slice(0, 5);
      return { delay_minutes: 0, offset_days: st.start_day ?? 0, offset_minutes: null, delivery_time: hhmm };
    }
    // immediate / 分指定: 当日 00:00（過去なので即時）
    const mins = Number(st.delay_minutes ?? 0);
    return { delay_minutes: 0, offset_days: 0, offset_minutes: Number.isFinite(mins) ? mins : 0, delivery_time: "00:00" };
  }
  if (st.delay_type === "immediate") return { delay_minutes: 0, offset_days: null, offset_minutes: null, delivery_time: null };
  const mins = Number(st.delay_minutes ?? 0);
  return { delay_minutes: Number.isFinite(mins) ? mins : 0, offset_days: null, offset_minutes: null, delivery_time: null };
}

// ---------- あいさつメッセージ ----------
export function mapWelcome(store: SnapshotStore, ctx: PlanContext): void {
  const welcome = store.readJson<SourceWelcomeMessage[]>("welcome_messages.json") ?? [];
  const r = ctx.report("welcome", "あいさつメッセージ");
  r.source = welcome.filter((w) => w.message).length;
  for (const w of welcome) {
    if (!w.message?.trim()) continue;
    const scenarioId = harnessId("scenario", "welcome", w.type);
    const label = w.type === "add_new" ? "友だち追加時" : w.type === "add_old" ? "再追加時" : "ブロック解除時";
    ctx.add({
      table: "scenarios",
      values: scenarioValues(ctx, {
        id: scenarioId,
        name: `あいさつ（${label}）`,
        description: "L Message のあいさつメッセージから移行",
        trigger_type: w.type === "add_new" ? "friend_add" : "manual",
        delivery_mode: "relative",
        created_at: ctx.now,
      }),
      ...keepActiveScenario(ctx),
    });
    ctx.add({
      table: "scenario_steps",
      values: scenarioStepValues(ctx, {
        id: harnessId("scenario_step", "welcome", w.type, 0),
        scenario_id: scenarioId,
        step_order: 1,
        delay_minutes: 0,
        message_type: "text",
        message_content: convertSourceText(w.message).text,
        timing: { offset_days: null, offset_minutes: null, delivery_time: null },
        on_reach_tag_id: tagIdsFromActions(w.actions).map((id) => ctx.tagIds.get(id)).find(Boolean) ?? null,
      }),
      ...keepActiveScenarioSteps(ctx, scenarioId),
    });
    r.migrated += 1;
  }
  if (r.migrated) r.notes.push("友だち追加時のあいさつは「友だち追加」トリガーのシナリオ（停止状態）にしました。再追加・ブロック解除時は手動トリガーです");
}

// ---------- 自動応答 ----------
export function mapAutoReplies(store: SnapshotStore, ctx: PlanContext, templateTextById: Map<number, string>): void {
  const rules = store.readJson<SourceAutoReply[]>("auto_replies.json") ?? [];
  const r = ctx.report("auto_replies", "自動応答");
  r.source = rules.length;
  for (const rule of rules) {
    if (rule.trigger_by !== "keyword" || !rule.keywords?.length) {
      r.skipped += 1;
      ctx.note("auto_replies", "自動応答", "キーワード以外のトリガー（全メッセージ等）は移していません");
      continue;
    }
    const { text, templateId } = autoReplyResponse(rule, ctx, templateTextById);
    if (!text && !templateId) {
      r.skipped += 1;
      ctx.note("auto_replies", "自動応答", "返信内容が文字・テンプレート以外（タグ付けのみ等）のルールは移していません");
      continue;
    }
    const active = !rule.is_stopped && ctx.options.activate_automations ? 1 : 0;
    rule.keywords.forEach((k, i) => {
      ctx.add({
        table: "auto_replies",
        values: {
          id: harnessId("auto_reply", rule.id, k.id ?? i),
          keyword: k.keyword,
          match_type: k.match_type === "exact" ? "exact" : "contains",
          response_type: "text",
          response_content: convertSourceText(text ?? "").text,
          template_id: templateId,
          line_account_id: ctx.lineAccountId,
          is_active: active,
          created_at: sourceToHarnessJst(rule.created_at, ctx.now),
        },
      });
    });
    r.migrated += 1;
    if (rule.keyword_logic === "all" && rule.keywords.length > 1) ctx.note("auto_replies", "自動応答", "「全キーワードを含む」条件は L Harness に無いため、各キーワード単独で反応します");
    if (rule.time_mode && rule.time_mode !== "always") ctx.note("auto_replies", "自動応答", "時間帯の条件は移していません");
    if (rule.filters?.length) ctx.note("auto_replies", "自動応答", "対象の絞り込み条件は移していません");
  }
  if (r.migrated) r.notes.push("すべて停止状態で入れています。切替後に有効化してください");
}

/** 自動応答の返信内容: 文字アクションの本文。無ければテンプレート送信アクションのテンプレート。 */
function autoReplyResponse(rule: SourceAutoReply, ctx: PlanContext, templateTextById: Map<number, string>): { text: string | null; templateId: string | null } {
  const text = textFromActions(rule.actions);
  if (text) return { text, templateId: null };
  const tplAction = (rule.actions ?? []).find((a) => a.type === "template");
  const tplId = Number((tplAction?.data as { id?: number } | undefined)?.id);
  if (!Number.isFinite(tplId)) return { text: null, templateId: null };
  return { text: templateTextById.get(tplId) ?? null, templateId: ctx.templateIds.get(tplId) ?? null };
}

// ---------- 流入経路 ----------
export function mapTrafficSources(store: SnapshotStore, ctx: PlanContext): void {
  const sources = store.readJson<SourceTrafficSource[]>("traffic_sources.json") ?? [];
  const r = ctx.report("traffic_sources", "流入経路");
  r.source = sources.length;
  for (const s of sources) {
    ctx.add({
      table: "entry_routes",
      values: {
        id: harnessId("entry_route", s.id),
        ref_code: s.code,
        name: s.name,
        tag_id: firstMappedTagId(ctx, tagIdsFromActions(s.actions)),
        scenario_id: null,
        redirect_url: null,
        is_active: 1,
        created_at: sourceToHarnessJst(s.created_at, ctx.now),
        updated_at: ctx.now,
        run_account_friend_add_scenarios: 1,
      },
      conflict: ["id"],
    });
    r.migrated += 1;
  }
  if (r.migrated) {
    r.level = "partial";
    r.notes.push("名前・コード・付与タグを「流入経路」として作りました。エルメ時代のクリック数は移せません。QR/URL は L Harness 側で発行し直してください");
  }
}
