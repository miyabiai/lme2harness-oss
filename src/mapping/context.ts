import type { Row } from "../sql/render.js";
import type { Lme2HarnessConfig } from "../config.js";
import { harnessId } from "../harness/ids.js";
import { nowJst } from "../harness/time.js";

/** 移行対象ごとの集計。レポートに出す。 */
export interface EntityReport {
  label: string;
  /** 取り出し元の件数 */
  source: number;
  /** L Harness に入れる行数（複数テーブルに分かれる場合は主たる表） */
  migrated: number;
  /** 取り込めなかった件数 */
  skipped: number;
  /** 判定: full / partial / none / manual */
  level: "full" | "partial" | "none" | "manual";
  notes: string[];
}

/** 移したステップ（L Harness に行を作ったものだけ）。進行状態の復元に使う */
export interface MigratedStep {
  lmeStepId: number;
  orderNumber: number;
  /** このステップの最後の行の step_order（「ここまで送った」ときの current_step_order） */
  lastOrder: number;
  /** 送られる中身（照合用） */
  parts: Array<{ message_type: string; message_content: string }>;
  timing: { delay_minutes: number; offset_days: number | null; offset_minutes: number | null; delivery_time: string | null };
}

export interface ScenarioStepsInfo {
  name: string;
  deliveryMode: "absolute_time" | "relative";
  steps: MigratedStep[];
}

export class PlanContext {
  readonly rows: Row[] = [];
  readonly reports = new Map<string, EntityReport>();
  readonly warnings: string[] = [];
  readonly now: string;
  /** エルメ tag_id → L Harness tags.id */
  readonly tagIds = new Map<number, string>();
  /** エルメ scenario_id → L Harness scenarios.id */
  readonly scenarioIds = new Map<number, string>();
  /** エルメ scenario_id → 移したステップの並び（進行状態の復元に使う） */
  readonly scenarioSteps = new Map<number, ScenarioStepsInfo>();
  /** エルメ template_id → L Harness templates.id（group は先頭の子） */
  readonly templateIds = new Map<number, string>();
  /** エルメ lmessage_friend_id → L Harness friends.id */
  readonly friendIds = new Map<number, string>();
  /** エルメ form_id → L Harness forms.id */
  readonly formIds = new Map<number, string>();
  /** エルメ友だち情報 field_id → タイトル */
  readonly fieldTitles = new Map<number, string>();
  /** 対応ステータス名 → tags.id（オプション有効時） */
  readonly handlingStatusTagIds = new Map<string, string>();
  /** 既存の L Harness タグ（名前 → id） */
  readonly existingTags: Map<string, string>;

  constructor(
    readonly lineAccountId: string,
    readonly options: Lme2HarnessConfig["options"],
    existingTags: Map<string, string> = new Map(),
    now = nowJst(),
  ) {
    this.existingTags = existingTags;
    this.now = now;
  }

  add(row: Row): void {
    this.rows.push(row);
  }

  report(key: string, label: string): EntityReport {
    let r = this.reports.get(key);
    if (!r) {
      r = { label, source: 0, migrated: 0, skipped: 0, level: "full", notes: [] };
      this.reports.set(key, r);
    }
    return r;
  }

  note(key: string, label: string, note: string): void {
    const r = this.report(key, label);
    if (!r.notes.includes(note)) r.notes.push(note);
  }

  friendId(lmeFriendId: number): string {
    let id = this.friendIds.get(lmeFriendId);
    if (!id) {
      id = harnessId("friend", lmeFriendId);
      this.friendIds.set(lmeFriendId, id);
    }
    return id;
  }
}
