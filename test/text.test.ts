import { describe, expect, it } from "vitest";
import { convertSourceText } from "../src/mapping/text.js";

describe("エルメの差し込み → L Harness の変数", () => {
  it("{name} を {{name}} にする（{{name}} はそのまま）", () => {
    expect(convertSourceText("{name}さん、こんにちは").text).toBe("{{name}}さん、こんにちは");
    expect(convertSourceText("{{name}}さん").text).toBe("{{name}}さん");
  });

  it("計測リンク等の不明なタグは残して知らせる", () => {
    const r = convertSourceText("こちら\n[CONVERSION_BnjTzoSJ]");
    expect(r.text).toContain("[CONVERSION_BnjTzoSJ]");
    expect(r.unknown).toEqual(["[CONVERSION_BnjTzoSJ]"]);
  });
});

describe("システム表示名の差し込み", () => {
  it("[FRIEND_INFO_system_name] は {{metadata.system_name}} にする", () => {
    const r = convertSourceText("[FRIEND_INFO_system_name]さん、こんにちは");
    expect(r.text).toBe("{{metadata.system_name}}さん、こんにちは");
    expect(r.unknown).toEqual([]);
  });
});
