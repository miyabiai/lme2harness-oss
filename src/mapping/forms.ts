import type { SnapshotStore } from "../snapshot/store.js";
import type { PlanContext } from "./context.js";
import type { SourceFormDetail, SourceFormField, SourceFormResponse } from "../source/types.js";
import { harnessId } from "../harness/ids.js";
import { sourceToHarnessJst } from "../harness/time.js";
import { htmlToText } from "./text.js";
import { firstMappedTagId, tagIdsFromActions, textFromActions } from "./masters.js";

/**
 * エルメのフォーム → L Harness forms.fields（JSON 配列）
 * L Harness の type: text / email / tel / number / textarea / select / radio / checkbox / date
 */
interface HarnessField {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function convertFormField(f: SourceFormField, usedNames: Set<string>): { field: HarnessField | null; skippedReason?: string } {
  let type = (f.type ?? "").toLowerCase();
  const title = (f.title ?? f.label ?? "").trim();
  const label = (f.label ?? "").trim();
  const settingsPeek = parseJson<{ type?: string }>(f.settings ?? null, {});
  if (type === "text_new") {
    // エルメの text_new は 2 用途ある:
    //  - 「テキスト」ブロック（説明文。label が「テキスト」）→ 入力欄ではない
    //  - 「よく使われる項目」（名前・メールアドレス・電話番号・生年月日・国内住所・性別）→ 入力欄
    if (label === "テキスト" || title === "テキスト" || (!label && !title)) {
      return { field: null, skippedReason: "説明文（入力欄ではない）" };
    }
    const st = (settingsPeek.type ?? "").toLowerCase();
    type = st === "email" ? "email" : st === "tel" || /電話/.test(label) ? "tel" : /生年月日|誕生日/.test(label) ? "date" : /性別/.test(label) ? "select" : "text";
    if (type === "select" && !f.settings?.includes("items")) {
      // 性別は選択肢が settings に無いことがあるので固定の候補にする
      f = { ...f, settings: JSON.stringify({ type: "select", items: [{ label: "男性", value: "男性" }, { label: "女性", value: "女性" }, { label: "その他", value: "その他" }] }) };
    }
  }
  if (type === "html" || type === "heading" || type === "description") {
    return { field: null, skippedReason: "説明文（入力欄ではない）" };
  }
  if (type.includes("file") || type.includes("image")) {
    return { field: null, skippedReason: "ファイル添付（L Harness のフォームに無い）" };
  }
  const rules = parseJson<{ required?: boolean }>(f.rules, {});
  const settings = parseJson<{ type?: string; items?: Array<{ label?: string; value?: string }>; multiple?: boolean }>(f.settings ?? null, {});
  let name = title || `field_${f.id}`;
  if (usedNames.has(name)) {
    let i = 2;
    while (usedNames.has(`${name}_${i}`)) i++;
    name = `${name}_${i}`;
  }
  usedNames.add(name);
  const base: Omit<HarnessField, "type"> = { name, label: title || name, required: Boolean(rules.required) };
  if (f.placeholder) base.placeholder = f.placeholder;
  const options = (settings.items ?? []).map((it) => (it.label ?? it.value ?? "").trim()).filter(Boolean);
  if (type.startsWith("select") || type === "radio" || type === "checkbox" || type === "dropdown") {
    if (!options.length) return { field: { ...base, type: "text" } };
    if (type === "checkbox" || settings.multiple) return { field: { ...base, type: "checkbox", options } };
    if (type === "radio") return { field: { ...base, type: "radio", options } };
    return { field: { ...base, type: "select", options } };
  }
  if (type.startsWith("date")) return { field: { ...base, type: "date" } };
  if (type === "email") return { field: { ...base, type: "email" } };
  if (type === "tel" || type === "phone") return { field: { ...base, type: "tel" } };
  if (type === "number" || type === "point") return { field: { ...base, type: "number" } };
  if (type === "textarea" || type === "text_area") return { field: { ...base, type: "textarea" } };
  // エルメの "text" はテキストボックス。settings.items を持つもの（複数行入力の設定）や長文想定なら textarea
  const long = Array.isArray(settings.items) || (f.placeholder ?? "").length > 20 || /相談|内容|自由|詳しく|理由/.test(title);
  return { field: { ...base, type: long ? "textarea" : "text" } };
}

function answerValue(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as { date?: string; time?: string; value?: unknown };
    if (o.date) {
      const d = o.date.replace(/\//g, "-");
      return o.time ? `${d} ${o.time}` : d;
    }
    if ("value" in o) return o.value;
    return JSON.stringify(v);
  }
  return v ?? "";
}

export function mapForms(store: SnapshotStore, ctx: PlanContext): void {
  const forms = store.readJson<SourceFormDetail[]>("forms.json");
  const r = ctx.report("forms", "フォーム");
  const rr = ctx.report("form_submissions", "フォーム回答");
  if (!forms) {
    r.level = "none";
    r.notes.push("フォームは公式MCPでのみ取得できます");
    return;
  }
  r.source = forms.length;
  for (const form of forms) {
    const { fields, skipped, nameByTitle } = convertFormFields(form);
    const formId = harnessId("form", form.id);
    ctx.formIds.set(form.id, formId);
    const tagIds = tagIdsFromActions(form.actions_on_reply);
    const thanks = textFromActions(form.actions_on_reply);
    const name = form.title?.trim() || form.name;
    ctx.add({
      table: "forms",
      values: {
        id: formId,
        name,
        description: [form.name !== form.title ? `（エルメ管理名: ${form.name}）` : "", htmlToText(form.description)].filter(Boolean).join("\n") || null,
        fields: JSON.stringify(fields),
        on_submit_tag_id: firstMappedTagId(ctx, tagIds),
        on_submit_scenario_id: null,
        on_submit_message_type: thanks ? "text" : null,
        on_submit_message_content: thanks,
        save_to_metadata: 1,
        is_active: ctx.options.activate_automations ? 1 : 0,
        submit_count: 0,
        created_at: sourceToHarnessJst(form.created_at, ctx.now),
        updated_at: ctx.now,
      },
      update: ["name", "description", "fields", "on_submit_tag_id", "on_submit_message_type", "on_submit_message_content", "updated_at"],
    });
    r.migrated += 1;
    for (const s of new Set(skipped)) ctx.note("forms", "フォーム", `移せない項目があります: ${s}`);
    if (form.actions_on_open?.length) ctx.note("forms", "フォーム", "「開封時」のアクションは L Harness に無いため移していません");
    if (tagIds.length > 1) ctx.note("forms", "フォーム", "回答時に複数タグを付ける設定は最初のタグだけ移しました");

    const responses = store.readJson<SourceFormResponse[]>(`form_responses/${form.id}.json`) ?? [];
    rr.source += responses.length;
    const submitCount = addFormSubmissions(form.id, formId, responses, nameByTitle, ctx);
    rr.migrated += submitCount;
    if (submitCount) {
      ctx.add({
        table: "forms",
        values: { id: formId, name, fields: JSON.stringify(fields), submit_count: submitCount },
        update: ["submit_count"],
      });
    }
  }
  if (r.migrated) r.notes.push("回答は L Harness の「回答一覧」に入ります。添付ファイルはエルメの URL を回答データに残しています");
}

/** フォームの全ページの項目を位置順に変換する。nameByTitle はエルメの回答の name（=タイトル）→ L Harness の name */
function convertFormFields(form: SourceFormDetail): { fields: HarnessField[]; skipped: string[]; nameByTitle: Map<string, string> } {
  const usedNames = new Set<string>();
  const fields: HarnessField[] = [];
  const skipped: string[] = [];
  const nameByTitle = new Map<string, string>();
  for (const page of form.pages ?? []) {
    for (const f of [...(page.fields ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
      const { field, skippedReason } = convertFormField(f, usedNames);
      if (!field) {
        if (skippedReason) skipped.push(skippedReason);
        continue;
      }
      fields.push(field);
      if (f.title) nameByTitle.set(f.title, field.name);
    }
  }
  return { fields, skipped, nameByTitle };
}

/** 回答 → form_submissions。入れた件数を返す */
function addFormSubmissions(sourceFormId: number, formId: string, responses: SourceFormResponse[], nameByTitle: Map<string, string>, ctx: PlanContext): number {
  let count = 0;
  for (const resp of responses) {
    const data: Record<string, unknown> = {};
    for (const a of resp.answers ?? []) {
      const key = nameByTitle.get(a.name) ?? a.name;
      if (!key) continue;
      data[key] = answerValue(a.value);
    }
    const friendId = ctx.friendIds.has(resp.lmessage_friend_id) ? ctx.friendId(resp.lmessage_friend_id) : null;
    if (!friendId) {
      ctx.note("form_submissions", "フォーム回答", "友だち一覧に無い人（削除済み等）の回答は友だちに紐づけず保存しました");
    }
    ctx.add({
      table: "form_submissions",
      values: {
        id: harnessId("form_submission", sourceFormId, resp.id),
        form_id: formId,
        friend_id: friendId,
        data: JSON.stringify(data),
        created_at: sourceToHarnessJst(resp.answered_at, ctx.now),
      },
      update: ["data", "friend_id"],
    });
    count += 1;
  }
  return count;
}
