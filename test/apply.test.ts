import { describe, expect, it } from "vitest";
import { runInTableGroups } from "../src/commands/apply.js";

function item(table: string, n: number) {
  return { table, n };
}

describe("投入の並列", () => {
  it("同じ表だけ同時に流し、表の順番は守る", async () => {
    const items = [item("tags", 1), item("friends", 2), item("friends", 3), item("friends", 4), item("friends", 5), item("friend_tags", 6), item("friend_tags", 7)];
    let running = 0;
    let peak = 0;
    const finished: number[] = [];
    const tableAt = new Map<number, string>();
    await runInTableGroups(items, 3, async (it) => {
      running += 1;
      peak = Math.max(peak, running);
      tableAt.set(it.n, it.table);
      // 後のものほど早く終わらせ、順序が入れ替わっても壊れないことを見る
      await new Promise((r) => setTimeout(r, 10 - it.n));
      running -= 1;
      finished.push(it.n);
    });
    expect(peak).toBe(3);
    expect(finished.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // friend_tags（子表）は friends（親表）が全部終わってから
    const lastFriends = Math.max(...finished.filter((n) => tableAt.get(n) === "friends").map((n) => finished.indexOf(n)));
    const firstFriendTags = Math.min(...finished.filter((n) => tableAt.get(n) === "friend_tags").map((n) => finished.indexOf(n)));
    expect(lastFriends).toBeLessThan(firstFriendTags);
  });

  it("並列 1 なら順番どおり", async () => {
    const order: number[] = [];
    await runInTableGroups([item("a", 1), item("a", 2), item("b", 3)], 1, async (it) => {
      order.push(it.n);
    });
    expect(order).toEqual([1, 2, 3]);
  });
});
