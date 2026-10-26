import { SnapshotStore } from "../snapshot/store.js";
import type { SourceAction, SourceRichMenu, SourceTrafficSource, SourceWelcomeMessage } from "../source/types.js";
import type { HarnessApi } from "../harness/api.js";
import { loadEnv, requireHarness, resolveLineAccountId, snapshotDir } from "./shared.js";
import * as log from "../log.js";

/**
 * エルメで作ったリッチメニューを L Harness の管理画面に取り込む。
 *
 * エルメのリッチメニューは LINE 上に登録済みなので、作り直さずに L Harness 標準の
 * 取り込み API（POST /api/rich-menu-groups/import）で「管理対象」にするだけにする。
 * LINE 上のメニュー・画像・誰に表示しているか（個別の紐づけ）は一切変わらない。
 *
 * 突き合わせ: LINE 上の名前はエルメの管理名と同じなので、名前・サイズ・ボタン数で対応を取る。
 */
interface LineMenu {
  richMenuId: string;
  name: string;
  chatBarText: string;
  size: { width: number; height: number };
  areasCount: number;
  isCurrentDefault: boolean;
  adminManaged: boolean;
  adminInfo: { groupId: string; groupName: string } | null;
}

/** エルメのリッチメニューのボタン（get_richmenu_detail の areas[]） */
interface SourceRichMenuArea {
  action_type?: string;
  content_open_url?: string | null;
  switch_to_menu?: unknown;
  actions?: unknown[];
}

export interface RichMenuMatch {
  elme: SourceRichMenu;
  line: LineMenu | null;
  reason?: string;
}

/** エルメのメニューと LINE 上のメニューの対応を取る（名前・サイズ・ボタン数がすべて一致し、候補が1つだけのもの） */
export function matchRichMenus(elme: SourceRichMenu[], line: LineMenu[]): RichMenuMatch[] {
  return elme.map((e) => {
    const areas = ((e.detail as { areas?: SourceRichMenuArea[] } | undefined)?.areas ?? []).length;
    const cands = line.filter(
      (l) => l.name === e.name && (!e.width || l.size.width === e.width) && (!e.height || l.size.height === e.height) && (!areas || l.areasCount === areas),
    );
    if (cands.length === 1) return { elme: e, line: cands[0] };
    if (!cands.length) return { elme: e, line: null, reason: "LINE 上に同じ名前・大きさ・ボタン数のメニューが見つかりません（エルメで削除済み・未公開の可能性）" };
    return { elme: e, line: null, reason: `LINE 上に同じ名前のメニューが ${cands.length} 個あり、どれか決められません` };
  });
}

/** エルメ側で「誰にどのメニューを出すか」を決めていた設定を拾う（L Harness で作り直すときの手がかり） */
export function displayRules(store: SnapshotStore): string[] {
  const rules: string[] = [];
  const name = (a: SourceAction) => String(a.data?.richmenu_name ?? a.content ?? "?");
  for (const w of store.readJson<SourceWelcomeMessage[]>("welcome_messages.json") ?? []) {
    for (const a of w.actions ?? []) {
      if (a.type === "richmenu") rules.push(`友だち追加のとき「${name(a)}」を表示`);
    }
  }
  for (const t of store.readJson<SourceTrafficSource[]>("traffic_sources.json") ?? []) {
    for (const a of t.actions ?? []) {
      if (a.type === "richmenu") rules.push(`流入経路「${t.name}」から来た人に「${name(a)}」を表示`);
    }
  }
  return [...new Set(rules)];
}

export async function runRichMenu(opts: { dryRun?: boolean }): Promise<void> {
  const env = loadEnv();
  const harness = requireHarness(env);
  const accountId = await resolveLineAccountId(env);
  const store = new SnapshotStore(snapshotDir(env));
  const elme = store.readJson<SourceRichMenu[]>("rich_menus.json") ?? [];
  if (!elme.length) {
    log.info("エルメにリッチメニューがありません（または未取得。`lme2harness extract` を先に）");
    return;
  }
  const ext = await harness.request<{ lineMenus: LineMenu[]; currentDefault: string | null }>("GET", `/api/rich-menu-groups/external?accountId=${encodeURIComponent(accountId)}`);
  const lineMenus = ext.lineMenus ?? [];
  log.info(`エルメのリッチメニュー ${elme.length}個 / LINE 上のメニュー ${lineMenus.length}個`);

  let imported = 0;
  for (const m of matchRichMenus(elme, lineMenus)) {
    if (!m.line) {
      log.warn(`「${m.elme.name}」: ${m.reason}`);
      continue;
    }
    if (m.line.adminManaged) {
      log.info(`  済 「${m.elme.name}」は取り込み済みです（${m.line.adminInfo?.groupName ?? ""}）`);
      continue;
    }
    if (opts.dryRun) {
      log.info(`  (dry-run) 「${m.elme.name}」→ ${m.line.richMenuId} を取り込みます`);
      continue;
    }
    try {
      const g = await harness.request<{ id: string; name: string }>(
        "POST",
        `/api/rich-menu-groups/import?accountId=${encodeURIComponent(accountId)}&richMenuId=${encodeURIComponent(m.line.richMenuId)}`,
      );
      imported += 1;
      log.info(`  ✓ 「${m.elme.name}」を取り込みました`);
      await warnTrackingUrls(harness, g.id, m.elme);
    } catch (e) {
      log.warn(`「${m.elme.name}」を取り込めませんでした: ${(e as Error).message}`);
    }
  }

  log.info("");
  if (!opts.dryRun) log.info(`取り込み ${imported}個。L Harness 管理画面の「リッチメニュー」に出ています`);
  log.info("※ LINE 上の表示は何も変わっていません。並行運用中は L Harness で「公開」「公開停止」を押さないでください");
  log.info("  （公開し直すと LINE 上のメニューが作り直され、エルメが個別に表示している人の紐づけが外れます）");
  const rules = displayRules(store);
  if (rules.length) {
    log.info("");
    log.info("エルメで「誰にどのメニューを出すか」を決めていた設定（切り替え後に L Harness の自動化で作り直す）:");
    for (const r of rules) log.info(`  - ${r}`);
    log.info("  今表示されている人の紐づけは LINE 側に残るので、切り替え後も同じメニューが出続けます");
  }
}

/** LINE 上のリンク先がエルメのクリック計測 URL だと、エルメ解約後に開けなくなるので知らせる */
async function warnTrackingUrls(harness: HarnessApi, groupId: string, elme: SourceRichMenu): Promise<void> {
  try {
    const g = await harness.request<{ pages?: Array<{ areas?: Array<{ actionType: string; actionData?: { uri?: string } }> }> }>("GET", `/api/rich-menu-groups/${encodeURIComponent(groupId)}`);
    const uris = (g.pages ?? []).flatMap((p) => p.areas ?? []).filter((a) => a.actionType === "uri").map((a) => a.actionData?.uri ?? "");
    const viaElme = uris.filter((u) => /lmes?\.jp|l-message|lme\.jp/i.test(new URL(u, "https://x").hostname));
    if (viaElme.length) {
      const direct = ((elme.detail as { areas?: SourceRichMenuArea[] } | undefined)?.areas ?? []).map((a) => a.content_open_url).filter(Boolean);
      log.warn(`「${elme.name}」のボタン ${viaElme.length}個がエルメ経由の URL です。エルメ解約後に開けなくなるので、切り替え時に管理画面で直接の URL（例: ${direct[0] ?? "元のリンク先"}）に差し替えてください`);
    }
  } catch {
    /* 確認できなくても取り込み自体は成功しているので続ける */
  }
}
