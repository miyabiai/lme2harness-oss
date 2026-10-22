/**
 * 行データ → SQLite(D1) の SQL 文字列。
 * - 値は文字列・数値・null・boolean（0/1）・オブジェクト（JSON 文字列化）
 * - 冪等: INSERT ... ON CONFLICT(主キー) DO UPDATE / DO NOTHING を使う
 * - チャンク: wrangler d1 execute --file に渡すサイズに分ける
 */

export type SqlValue = string | number | boolean | null | undefined | Record<string, unknown> | unknown[];

export interface Row {
  table: string;
  values: Record<string, SqlValue>;
  /** 衝突キー（省略時 id） */
  conflict?: string[];
  /** 衝突時に更新する列（省略時: 衝突キー以外の全列。空配列なら DO NOTHING） */
  update?: string[];
  /** 衝突時に更新する条件（既存行を表名で参照できる）。満たさなければ何もしない */
  updateWhere?: string;
}

export function quote(v: SqlValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  // SQLite は \u0000 を文字列終端として扱い得るので除く
  return `'${s.replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

export function renderInsert(row: Row): string {
  const cols = Object.keys(row.values);
  const conflict = row.conflict ?? ["id"];
  const updateCols = row.update ?? cols.filter((c) => !conflict.includes(c));
  const vals = cols.map((c) => quote(row.values[c])).join(", ");
  const onConflict =
    updateCols.length === 0
      ? `ON CONFLICT(${conflict.join(", ")}) DO NOTHING`
      : `ON CONFLICT(${conflict.join(", ")}) DO UPDATE SET ${updateCols.map((c) => `${c} = excluded.${c}`).join(", ")}${row.updateWhere ? ` WHERE ${row.updateWhere}` : ""}`;
  return `INSERT INTO ${row.table} (${cols.join(", ")}) VALUES (${vals}) ${onConflict};`;
}

export interface SqlChunk {
  name: string;
  statements: string[];
  bytes: number;
}

/** 文のリストを、文数とバイト数の上限でチャンクに分ける。 */
export function chunkStatements(statements: string[], prefix: string, maxStatements = 400, maxBytes = 900_000): SqlChunk[] {
  const chunks: SqlChunk[] = [];
  let cur: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (cur.length) {
      chunks.push({ name: `${prefix}_${String(chunks.length + 1).padStart(3, "0")}.sql`, statements: cur, bytes });
      cur = [];
      bytes = 0;
    }
  };
  for (const s of statements) {
    const b = Buffer.byteLength(s, "utf8") + 1;
    if (cur.length >= maxStatements || (bytes + b > maxBytes && cur.length > 0)) flush();
    cur.push(s);
    bytes += b;
  }
  flush();
  return chunks;
}
