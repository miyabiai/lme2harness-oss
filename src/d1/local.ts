import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

/**
 * ローカル検証用: L Harness の bootstrap.sql を読んだ SQLite に、生成 SQL を流す。
 * D1 と同じ SQLite なので、制約違反や構文エラーを本番前に検出できる。
 */
export class LocalD1 {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
  }

  loadSchema(bootstrapSqlPath: string): void {
    this.db.exec(readFileSync(bootstrapSqlPath, "utf8"));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  execStatements(statements: string[]): void {
    this.db.exec("BEGIN");
    try {
      for (const s of statements) this.db.exec(s);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  count(table: string, where = "1=1"): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get() as { c: number };
    return row.c;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: Array<string | number | null>): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  close(): void {
    this.db.close();
  }
}
