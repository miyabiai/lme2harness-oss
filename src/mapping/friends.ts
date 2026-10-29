import type { SnapshotStore } from "../snapshot/store.js";
import type { PlanContext } from "./context.js";
import type { SourceConversationIndexEntry, SourceFriendSnapshot } from "../source/types.js";
import { harnessId } from "../harness/ids.js";
import { sourceToHarnessJst, parseSourceDate, toHarnessJst } from "../harness/time.js";
import { isEventRecord, messageToLogParts, outgoingSource } from "./messages.js";
import { nextDeliveryAt, restoreProgress } from "./scenario-progress.js";
import { scenarioActiveSql } from "./masters.js";
import { quote } from "../sql/render.js";

const LINE_UID_RE = /^U[0-9a-f]{32}$/;

function isBlocked(s: SourceFriendSnapshot): boolean {
  const d = s.detail;
  if (typeof d?.is_blocked === "boolean") return d.is_blocked;
  if (typeof s.row.is_blocked === "boolean") return s.row.is_blocked;
  const bs = s.conversation?.block_status;
  if (bs) return bs !== "normal";
  return false;
}

function followedAt(s: SourceFriendSnapshot): string | null {
  return s.detail?.followed_at ?? s.row.followed_at ?? s.row.added_time ?? null;
}

function blockedAtOf(s: SourceFriendSnapshot): string | null {
  return s.detail?.blocked_at ?? s.row.blocked_at ?? null;
}

export interface FriendMapStats {
  friends: number;
  blocked: number;
  tags: number;
  messages: number;
  chats: number;
  scenarios: number;
  /** 配信中で位置を復元できた人 */
  scenarioRestored: number;
  /** 配信中で位置が分からなかった人 */
  scenarioUnknown: number;
  /** 停止中の人（一時停止で入れる） */
  scenarioStopped: number;
  invalidUid: number;
  /** 会話ではない記録（ステップ配信の開始・停止など）。入れない */
  events: number;
  /** 本文が空の送信記録（エルメの履歴自体に本文が無い）。入れない */
  empty: number;
}

type EntityReport = ReturnType<PlanContext["report"]>;

export function mapFriends(store: SnapshotStore, ctx: PlanContext): FriendMapStats {
  const stats: FriendMapStats = { friends: 0, blocked: 0, tags: 0, messages: 0, chats: 0, scenarios: 0, scenarioRestored: 0, scenarioUnknown: 0, scenarioStopped: 0, invalidUid: 0, events: 0, empty: 0 };
  // 会話一覧（確認状態・対応ステータス・最終日時）。friends/<id>.json に無い分をここから補う
  const index = store.readJson<Record<string, SourceConversationIndexEntry>>("conversation_index.json") ?? {};
  const fr = ctx.report("friends", "友だち");
  const tr = ctx.report("friend_tags", "友だちのタグ");
  const mr = ctx.report("messages", "会話履歴");
  const sr = ctx.report("friend_scenarios", "ステップ配信の進行状態");
  const seenUids = new Set<string>();

  for (const s of store.friends()) {
    fr.source += 1;
    const uid = s.row.line_friend_id ?? s.detail?.line_friend_id ?? "";
    if (!LINE_UID_RE.test(uid)) {
      stats.invalidUid += 1;
      fr.skipped += 1;
      ctx.note("friends", "友だち", "LINE の userId が無い（削除済み等）友だちは移せません");
      continue;
    }
    if (seenUids.has(uid)) {
      fr.skipped += 1;
      ctx.note("friends", "友だち", "同じ LINE userId が複数あったため 1 件にまとめました");
      continue;
    }
    seenUids.add(uid);
    const idx = index[String(s.row.lmessage_friend_id)];
    if (s.conversation && idx) {
      s.conversation.confirm_status = s.conversation.confirm_status ?? idx.confirm_status;
      s.conversation.handling_status = s.conversation.handling_status ?? idx.handling_status;
      s.conversation.last_message_date = s.conversation.last_message_date ?? idx.last_message_date;
    }
    const blocked = isBlocked(s);
    if (blocked && !ctx.options.include_blocked) {
      fr.skipped += 1;
      continue;
    }
    const friend: FriendInfo = {
      snap: s,
      id: ctx.friendId(s.row.lmessage_friend_id),
      followed: sourceToHarnessJst(followedAt(s), ctx.now),
      handling: s.conversation?.handling_status?.name ?? idx?.handling_status?.name ?? null,
    };
    addFriendRow(friend, uid, blocked, ctx);
    stats.friends += 1;
    fr.migrated += 1;
    if (blocked) stats.blocked += 1;
    addFriendTags(friend, ctx, stats, tr);
    const lastAt = addMessages(friend, ctx, stats, mr);
    addChat(friend, lastAt, ctx, stats);
    addFriendScenarios(friend, ctx, stats, sr);
  }
  fr.notes.push("アイコン画像と表示名の最新値は `lme2harness enrich` で LINE から取り直せます（ブロック中の人は取れません）");
  if (stats.blocked) fr.notes.push(`ブロック中 ${stats.blocked}人は「ブロック」状態で入れています`);
  if (sr.source) {
    sr.notes.push("完了の人は「完了」、配信中の人は会話履歴の送信記録から「何通目まで届いたか」を復元し、続きの予定時刻を入れています（シナリオは停止状態なので、L Harness で有効にするまで送られません）。停止中の人は「一時停止」で入れ、送りません");
    if (stats.scenarioRestored) sr.notes.push(`配信中の ${stats.scenarioRestored}人は続きから送れる状態で入れました。有効にした時点で予定時刻を過ぎている分はすぐ送られるので、切り替えの直前にもう一度 extract → plan → apply してから有効にしてください`);
    if (stats.scenarioUnknown) {
      sr.level = "partial";
      sr.notes.push(`配信中の ${stats.scenarioUnknown}人は、エルメの会話履歴が開始時点まで残っておらず位置が分からないため「一時停止」で入れました。L Harness の画面からは再開できないので、続きが必要な人は手動で送るか、シナリオに入れ直してください`);
    }
    if (stats.scenarioStopped) sr.notes.push(`エルメで配信を止めた ${stats.scenarioStopped}人は「一時停止」で入れました（前回の移行で配信中として入れた人も止まります。L Harness でまだ有効にしていないシナリオに限ります）`);
    if (stats.scenarioRestored && !ctx.options.activate_automations) sr.notes.push("L Harness で既に有効にしているシナリオに新しく入る人は、流す時点で「一時停止」にします（自動では送りません）");
  }
  mr.notes.push("エルメ側の画像・ファイルはエルメの URL を参照しています（エルメ解約後は開けなくなります）");
  if (stats.events) mr.notes.push(`ステップ配信の開始・停止などの記録 ${stats.events}件は会話ではないので入れていません`);
  if (stats.empty) mr.notes.push(`本文が空の送信記録 ${stats.empty}件は入れていません（エルメの履歴自体に本文が残っていないもの）`);
  return stats;
}

/** 移す友だち 1 人分の共通値 */
interface FriendInfo {
  snap: SourceFriendSnapshot;
  /** L Harness の friends.id */
  id: string;
  /** 友だち追加日時（L Harness JST） */
  followed: string;
  /** 対応ステータス名 */
  handling: string | null;
}

/** friends.metadata（友だち情報・エルメ側の元データ _lme）を作る */
function friendMetadata(f: FriendInfo, ctx: PlanContext): Record<string, unknown> {
  const s = f.snap;
  const detail = s.detail;
  const friendInfo: Record<string, { title: string; value: unknown }> = {};
  const top: Record<string, unknown> = {};
  for (const fi of detail?.friend_info ?? []) {
    const title = (fi.title ?? fi.name ?? ctx.fieldTitles.get(fi.id) ?? `field_${fi.id}`).trim();
    if (fi.value === null || fi.value === undefined || fi.value === "") continue;
    friendInfo[String(fi.id)] = { title, value: fi.value };
    if (ctx.options.friend_info_top_level && !(title in top)) top[title] = fi.value;
  }
  // 友だち情報の標準項目: -1=システム表示名、-2=電話番号、-3=メールアドレス
  const systemName = detail?.system_name ?? s.row.system_name ?? friendInfo["-1"]?.value ?? null;
  const email = detail?.email ?? s.row.email ?? (friendInfo["-3"]?.value as string | undefined) ?? null;
  const phone = detail?.phone ?? s.row.phone ?? (friendInfo["-2"]?.value as string | undefined) ?? null;
  const handling = f.handling;
  return {
    ...top,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(systemName ? { system_name: systemName } : {}),
    ...(handling ? { handling_status: handling } : {}),
    _lme: {
      friend_id: s.row.lmessage_friend_id,
      system_name: systemName,
      handling_status: handling,
      confirm_status: s.conversation?.confirm_status ?? null,
      followed_at: followedAt(s),
      blocked_at: blockedAtOf(s),
      friend_info: friendInfo,
      scenarios: (detail?.scenarios ?? []).map((sc) => ({ id: sc.scenario_id ?? sc.id, name: sc.scenario_name ?? sc.name, status: sc.status, started_at: sc.started_at ?? null, ended_at: sc.ended_at ?? null })),
      memo: detail?.memo ?? [],
      purchase_history: detail?.purchase_history ?? [],
      migrated_at: ctx.now,
    },
  };
}

function addFriendRow(f: FriendInfo, uid: string, blocked: boolean, ctx: PlanContext): void {
  const s = f.snap;
  const displayName = (s.detail?.line_name ?? s.row.line_name ?? "").trim() || null;
  ctx.add({
    table: "friends",
    values: {
      id: f.id,
      line_user_id: uid,
      display_name: displayName,
      picture_url: null,
      status_message: null,
      is_following: blocked ? 0 : 1,
      user_id: null,
      line_account_id: ctx.lineAccountId,
      metadata: JSON.stringify(friendMetadata(f, ctx)),
      first_followed_at: f.followed,
      current_follow_started_at: blocked ? null : f.followed,
      last_followed_at: f.followed,
      last_unfollowed_at: blocked ? sourceToHarnessJst(blockedAtOf(s), ctx.now) : null,
      unfollow_count: blocked ? 1 : 0,
      created_at: f.followed,
      updated_at: ctx.now,
    },
    conflict: ["line_user_id"],
    // 既に L Harness にいる友だち（並行運用で先に登録済み・前回移した人）は、表示名・アイコンを壊さずメタデータと所属だけ補う。
    // メタデータは L Harness 側で足された項目（フォームの回答など）を残してエルメの項目を足し、
    // エルメ側の元データ（_lme）だけは今回の取得結果に置き換える。追加日は古い方にする
    update: ["metadata", "line_account_id", "updated_at", "first_followed_at", "created_at"],
    merge: {
      metadata: "json_set(json_patch(CASE WHEN json_valid(friends.metadata) THEN friends.metadata ELSE '{}' END, excluded.metadata), '$._lme', json(json_extract(excluded.metadata, '$._lme')))",
      first_followed_at: olderDate("friends.first_followed_at", "excluded.first_followed_at"),
      created_at: olderDate("friends.created_at", "excluded.created_at"),
    },
  });
}

/** 2つの日時（L Harness JST の文字列）の古い方。既存が空なら入れる値 */
function olderDate(existing: string, incoming: string): string {
  return `CASE WHEN ${existing} IS NULL OR substr(${incoming},1,23) < substr(${existing},1,23) THEN ${incoming} ELSE ${existing} END`;
}

/** タグ（＋対応ステータスのタグ）→ friend_tags */
function addFriendTags(f: FriendInfo, ctx: PlanContext, stats: FriendMapStats, tr: EntityReport): void {
  const tags = f.snap.detail?.tags ?? [];
  tr.source += tags.length;
  for (const t of tags) {
    const tagId = ctx.tagIds.get(t.tag_id);
    if (!tagId) {
      ctx.note("friend_tags", "友だちのタグ", "タグ一覧に無いタグ（削除済み）は飛ばしました");
      continue;
    }
    ctx.add({
      table: "friend_tags",
      values: { friend_id: f.id, tag_id: tagId, assigned_at: sourceToHarnessJst(t.added_at, f.followed) },
      conflict: ["friend_id", "tag_id"],
      update: [],
    });
    stats.tags += 1;
    tr.migrated += 1;
  }
  if (f.handling && ctx.handlingStatusTagIds.has(f.handling)) {
    ctx.add({
      table: "friend_tags",
      values: { friend_id: f.id, tag_id: ctx.handlingStatusTagIds.get(f.handling)!, assigned_at: ctx.now },
      conflict: ["friend_id", "tag_id"],
      update: [],
    });
  }
}

/** 会話履歴 → messages_log。最後のメッセージ日時（無ければ null）を返す */
function addMessages(f: FriendInfo, ctx: PlanContext, stats: FriendMapStats, mr: EntityReport): string | null {
  const s = f.snap;
  const msgs = s.conversation?.messages ?? [];
  let lastAt: string | null = null;
  let seq = 0;
  for (const m of msgs) {
    if (isEventRecord(m)) {
      stats.events += 1;
      continue;
    }
    const at = parseSourceDate(m.sent_at);
    const createdAt = at === null ? f.followed : toHarnessJst(at);
    const parts = messageToLogParts(m);
    if (!parts.length) {
      stats.empty += 1;
      continue;
    }
    const incoming = m.sender === "friend";
    for (const part of parts) {
      seq += 1;
      ctx.add({
        table: "messages_log",
        values: {
          id: harnessId("message", s.row.lmessage_friend_id, m.message_id ?? m.sent_at, seq),
          friend_id: f.id,
          direction: incoming ? "incoming" : "outgoing",
          message_type: part.message_type,
          content: part.content,
          broadcast_id: null,
          scenario_step_id: null,
          template_id_at_send: null,
          delivery_type: null,
          source: incoming ? "user" : outgoingSource(m),
          line_account_id: ctx.lineAccountId,
          created_at: createdAt,
        },
        update: [],
      });
      stats.messages += 1;
      mr.migrated += 1;
    }
    if (parts.length && (!lastAt || createdAt > lastAt)) lastAt = createdAt;
  }
  mr.source += msgs.length;
  if (s.conversation && !s.conversation.complete) ctx.note("messages", "会話履歴", "公開APIは直近100件までなので、古い履歴は入っていません（MCP ログインで全履歴）");
  return lastAt;
}

/** chats（1 友だち 1 行。無いと「未対応」扱いになるので履歴がある人は必ず作る） */
function addChat(f: FriendInfo, lastAt: string | null, ctx: PlanContext, stats: FriendMapStats): void {
  const conv = f.snap.conversation;
  if (!conv) return;
  const unread = (conv?.confirm_status ?? "").toString().toLowerCase() === "unread";
  ctx.add({
    table: "chats",
    values: {
      id: harnessId("chat", f.snap.row.lmessage_friend_id),
      friend_id: f.id,
      operator_id: null,
      status: unread ? "unread" : "resolved",
      notes: f.handling ? `対応ステータス: ${f.handling}` : null,
      last_message_at: lastAt ?? sourceToHarnessJst(conv?.last_message_date, f.followed),
      line_account_id: ctx.lineAccountId,
      created_at: f.followed,
      updated_at: ctx.now,
    },
    conflict: ["friend_id"],
    // 既にあるチャットは、対応状態（未読・対応済み）を L Harness 側のまま残し、メモは人が書いたものを残し、最終日時を古くしない。
    // エルメの確認状態を入れるのは新しく作るときだけ
    update: ["notes", "last_message_at", "updated_at"],
    merge: {
      // メモは、このツールが書いた「対応ステータス: …」だけ書き換え、L Harness で人が書いたメモは残す
      notes: "CASE WHEN chats.notes IS NULL OR chats.notes LIKE '対応ステータス: %' THEN excluded.notes ELSE chats.notes END",
      last_message_at: "CASE WHEN chats.last_message_at IS NULL OR substr(excluded.last_message_at,1,23) > substr(chats.last_message_at,1,23) THEN excluded.last_message_at ELSE chats.last_message_at END",
    },
  });
  stats.chats += 1;
}

/** ステップ配信の進行状態 → friend_scenarios（停止中の人は一時停止で入れる） */
function addFriendScenarios(f: FriendInfo, ctx: PlanContext, stats: FriendMapStats, sr: EntityReport): void {
  const s = f.snap;
  for (const sc of s.detail?.scenarios ?? []) {
    sr.source += 1;
    const sourceScenarioId = sc.scenario_id ?? sc.id;
    const scenarioId = sourceScenarioId !== undefined ? ctx.scenarioIds.get(sourceScenarioId) : undefined;
    if (sourceScenarioId === undefined || !scenarioId) {
      sr.skipped += 1;
      ctx.note("friend_scenarios", "ステップ配信の進行状態", "ステップ配信の中身が無い（MCP 未使用か削除済み）ものは進行状態を作っていません");
      continue;
    }
    const startedMs = parseSourceDate(sc.started_at);
    // 停止中の人は「一時停止」で入れる（前回の移行で配信中として入れた人も、L Harness でまだ有効にしていないシナリオならここで止まる）
    const progress: FriendScenarioProgress = sc.status === "following" ? followingProgress(sourceScenarioId, startedMs, f, ctx)
      : sc.status === "completed" ? { status: "completed", currentOrder: 9999, nextAt: null }
      : { status: "paused", currentOrder: -1, nextAt: null };
    if (sc.status !== "completed" && sc.status !== "following") stats.scenarioStopped += 1;
    if (progress.status === "active") stats.scenarioRestored += 1;
    if (progress.status === "paused" && sc.status === "following") stats.scenarioUnknown += 1;
    // L Harness で有効にしたシナリオに新しく入る人は、流す時点で「一時停止」にする（自動では送らない）
    const holdIfActive = progress.status === "active" && !ctx.options.activate_automations;
    const active = scenarioActiveSql(scenarioId);
    const id = harnessId("friend_scenario", s.row.lmessage_friend_id, sourceScenarioId);
    ctx.add({
      table: "friend_scenarios",
      values: {
        id,
        friend_id: f.id,
        scenario_id: scenarioId,
        current_step_order: progress.currentOrder,
        status: progress.status,
        started_at: sourceToHarnessJst(sc.started_at, f.followed),
        next_delivery_at: progress.nextAt,
        updated_at: ctx.now,
      },
      ...(holdIfActive
        ? { valueSql: { status: `CASE WHEN ${active} THEN 'paused' ELSE 'active' END`, next_delivery_at: `CASE WHEN ${active} THEN NULL ELSE ${quote(progress.nextAt)} END` } }
        : {}),
      // L Harness が自分で入れた同じ人・同じシナリオの所属（完了以外）があれば、そちらを残して新しくは入れない
      // （同じ人の二重登録で一意制約に当たって止まらないように）。前に入れた行の更新は続ける
      ...(progress.status === "completed"
        ? {}
        : { insertWhere: `EXISTS (SELECT 1 FROM friend_scenarios WHERE id = ${quote(id)}) OR NOT EXISTS (SELECT 1 FROM friend_scenarios WHERE friend_id = ${quote(f.id)} AND scenario_id = ${quote(scenarioId)} AND id <> ${quote(id)} AND status != 'completed')` }),
      update: ["status", "current_step_order", "next_delivery_at", "updated_at"],
      // L Harness でシナリオを動かし始めた後は、L Harness 側の進行を上書きしない。L Harness の所属と並ぶ行も変えない
      updateWhere:
        "(SELECT is_active FROM scenarios WHERE scenarios.id = friend_scenarios.scenario_id) = 0" +
        " AND NOT EXISTS (SELECT 1 FROM friend_scenarios AS other WHERE other.friend_id = friend_scenarios.friend_id AND other.scenario_id = friend_scenarios.scenario_id AND other.id <> friend_scenarios.id AND other.status != 'completed')",
    });
    stats.scenarios += 1;
    sr.migrated += 1;
  }
}

interface FriendScenarioProgress {
  status: "completed" | "active" | "paused";
  currentOrder: number;
  nextAt: string | null;
}

/** 配信中の人: 会話履歴の送信記録から「何通目まで届いたか」を復元する */
function followingProgress(sourceScenarioId: number, startedMs: number | null, f: FriendInfo, ctx: PlanContext): FriendScenarioProgress {
  const info = ctx.scenarioSteps.get(sourceScenarioId);
  const progress = info && info.steps.length ? restoreProgress(info, f.snap.conversation?.messages ?? [], startedMs) : null;
  if (!info || !progress) {
    // 履歴が開始時点まで残っていない: 位置が分からないので一時停止で残す（L Harness では自動では再開しない）
    return { status: "paused", currentOrder: -1, nextAt: null };
  }
  const next = info.steps[progress.lastIndex + 1];
  if (!next) return { status: "completed", currentOrder: 9999, nextAt: null };
  return {
    status: "active",
    currentOrder: progress.lastIndex >= 0 ? info.steps[progress.lastIndex].lastOrder : -1,
    nextAt: toHarnessJst(nextDeliveryAt(info, next, startedMs ?? Date.parse(ctx.now), progress.lastAt)),
  };
}
