import { describe, expect, it } from "vitest";
import { isChunkDone, recordChunkDone } from "../src/commands/apply.js";
import { chunkPrefix } from "../src/mapping/plan.js";

describe("SQL ファイル名と流し済みの記録", () => {
  it("表ごとに固定の番号（tags が無くても friends は 08）", () => {
    expect(chunkPrefix("tags")).toBe("01");
    expect(chunkPrefix("friends")).toBe("08");
    expect(chunkPrefix("messages_log")).toBe("11");
    expect(chunkPrefix("なにか別の表")).toMatch(/^9\d$/);
  });

  it("番号が違っても同じファイル・同じ中身なら流し済み", () => {
    const done = ["sql/07_friends_001.sql:abc", "sql/11_messages_log_003.sql:def"];
    expect(isChunkDone(done, "sql/08_friends_001.sql", "abc")).toBe(true);
    expect(isChunkDone(done, "sql/08_friends_001.sql", "zzz")).toBe(false);
    expect(isChunkDone(done, "sql/08_friends_002.sql", "abc")).toBe(false);
  });

  it("記録は古い番号の分を置き換える", () => {
    const next = recordChunkDone(["sql/07_friends_001.sql:abc", "sql/09_chats_001.sql:x"], "sql/08_friends_001.sql", "new");
    expect(next).toEqual(["sql/09_chats_001.sql:x", "sql/08_friends_001.sql:new"]);
  });
});
