import { describe, expect, it } from "vitest";
import { matchRichMenus } from "../src/commands/richmenu.js";
import type { LmeRichMenu } from "../src/lme/types.js";

const line = (id: string, name: string, areasCount: number, h = 1686) => ({ richMenuId: id, name, chatBarText: "メニュー", size: { width: 2500, height: h }, areasCount, isCurrentDefault: false, adminManaged: false, adminInfo: null });
const elme = (name: string, areas: number, h = 1686): LmeRichMenu => ({ id: 1, name, width: 2500, height: h, detail: { areas: Array.from({ length: areas }, () => ({ action_type: "URL" })) } });

describe("リッチメニューの突き合わせ", () => {
  it("名前・大きさ・ボタン数が一致する1つに対応させる", () => {
    const m = matchRichMenus([elme("一般用", 6), elme("会員用", 7)], [line("r1", "一般用", 6), line("r2", "会員用", 7)]);
    expect(m.map((x) => x.line?.richMenuId)).toEqual(["r1", "r2"]);
  });

  it("ボタン数や大きさが違えば対応させない", () => {
    expect(matchRichMenus([elme("一般用", 6)], [line("r1", "一般用", 5)])[0].line).toBeNull();
    expect(matchRichMenus([elme("一般用", 6, 843)], [line("r1", "一般用", 6)])[0].line).toBeNull();
  });

  it("同じ名前が複数あれば決めない（取り違え防止）", () => {
    const m = matchRichMenus([elme("一般用", 6)], [line("r1", "一般用", 6), line("r2", "一般用", 6)]);
    expect(m[0].line).toBeNull();
    expect(m[0].reason).toContain("2 個");
  });
});
