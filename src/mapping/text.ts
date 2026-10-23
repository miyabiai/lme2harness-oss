/**
 * エルメの差し込みタグ → L Harness の変数。
 * エルメ: {name}（LINE名）、[FRIEND_INFO_xxxxxxxx]（友だち情報。ほぼ「名前」用途）、[NAME] など
 * L Harness: {{name}}、{{metadata.KEY}}、{{uid}}、{{friend_id}}
 * 不明なタグは {{name}} にせず、そのまま残して警告する（意味を取り違えないため）。
 */
export interface ConvertResult {
  text: string;
  replaced: number;
  unknown: string[];
}

const FRIEND_INFO_RE = /\[FRIEND_INFO_[A-Za-z0-9]+\]/g;
/** エルメの「システム表示名」の差し込み。L Harness では友だちのメタデータ system_name に入れている */
const SYSTEM_NAME_RE = /\[FRIEND_INFO_system_name\]/g;
const NAME_RE = /\[(NAME|LINE_NAME|USER_NAME|name)\]/g;
/** エルメのテンプレート・ステップ本文の名前差し込み（2026-10 実データで確認）。{{name}} は対象外 */
const BRACE_NAME_RE = /(?<!\{)\{name\}(?!\})/g;
const ANY_TAG_RE = /\[[A-Z_]{3,}[A-Za-z0-9_]*\]/g;

export function convertLmeText(input: string, friendInfoAsName = true): ConvertResult {
  let replaced = 0;
  let text = input.replace(SYSTEM_NAME_RE, () => {
    replaced += 1;
    return "{{metadata.system_name}}";
  });
  if (friendInfoAsName) {
    text = text.replace(FRIEND_INFO_RE, () => {
      replaced += 1;
      return "{{name}}";
    });
  }
  text = text.replace(NAME_RE, () => {
    replaced += 1;
    return "{{name}}";
  });
  text = text.replace(BRACE_NAME_RE, () => {
    replaced += 1;
    return "{{name}}";
  });
  const unknown = Array.from(new Set(text.match(ANY_TAG_RE) ?? []));
  return { text, replaced, unknown };
}

/** HTML の説明文（フォームの help）をプレーンテキストに落とす。 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
