import { describe, expect, it } from "vitest";
import { convertLmeText } from "../src/mapping/text.js";

describe("エルメの差し込み → L Harness の変数", () => {
  it("{name} を {{name}} にする（{{name}} はそのまま）", () => {
    expect(convertLmeText("{name}さん、こんにちは").text).toBe("{{name}}さん、こんにちは");
    expect(convertLmeText("{{name}}さん").text).toBe("{{name}}さん");
  });

  it("計測リンク等の不明なタグは残して知らせる", () => {
    const r = convertLmeText("こちら\n[CONVERSION_BnjTzoSJ]");
    expect(r.text).toContain("[CONVERSION_BnjTzoSJ]");
    expect(r.unknown).toEqual(["[CONVERSION_BnjTzoSJ]"]);
  });
});
