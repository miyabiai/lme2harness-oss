import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGuidedEnv, checkKeys, runKeys } from "../src/commands/keys.js";
import { loadDotEnv } from "../src/config.js";

describe("keys: 秘密の値を .env に貼ってもらう", () => {
  it("今回貼るものを先頭にし、既にある値とほかの項目は残す", () => {
    const text = buildGuidedEnv({ LME_API_KEY: "lme_live_sk_x", MY_OWN: "keep" }, ["HARNESS_API_KEY"]);
    const lines = text.split("\n");
    const harness = lines.indexOf("HARNESS_API_KEY=");
    const lme = lines.indexOf("LME_API_KEY=lme_live_sk_x");
    expect(harness).toBeGreaterThan(0);
    expect(lme).toBeGreaterThan(harness);
    expect(lines).toContain("MY_OWN=keep");
    expect(lines[harness - 1]).toContain("L Harness の API キー");
  });

  it("形式だけ確かめ、値そのものは結果に出さない", () => {
    const r = checkKeys({ LINE_CHANNEL_SECRET: "0123456789abcdef0123456789abcdef", LME_WEBHOOK_SECRET: "wrong-secret" }, ["LINE_CHANNEL_SECRET", "LME_WEBHOOK_SECRET", "HARNESS_API_KEY"]);
    expect(r.ok).toEqual([{ key: "LINE_CHANNEL_SECRET", length: 32 }]);
    expect(r.invalid).toEqual([{ key: "LME_WEBHOOK_SECRET", reason: "whsec_ で始まっていません" }]);
    expect(r.missing).toEqual(["HARNESS_API_KEY"]);
    expect(JSON.stringify(r)).not.toContain("wrong-secret");
  });

  it("テキストエディットで貼ったときの全角空白や “ ” は外して読む", () => {
    const dir = mkdtempSync(join(tmpdir(), "l2h-"));
    writeFileSync(join(dir, ".env"), "HARNESS_API_KEY=“abc123”　\nLME_API_KEY= 'lme_live_sk_1' \n");
    expect(loadDotEnv(dir)).toMatchObject({ HARNESS_API_KEY: "abc123", LME_API_KEY: "lme_live_sk_1" });
  });

  it.skipIf(process.platform === "win32")("保存されるまで待ち、貼られたら 0600 にして戻る", async () => {
    const dir = mkdtempSync(join(tmpdir(), "l2h-"));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const done = runKeys({ names: ["HARNESS_API_KEY"], editor: false, timeout: 10 });
      // 人がエディタで貼って保存した想定（権限が 0644 に戻るエディタもある）
      setTimeout(() => {
        const text = readFileSync(join(dir, ".env"), "utf8").replace("HARNESS_API_KEY=\n", "HARNESS_API_KEY=key-from-editor\n");
        writeFileSync(join(dir, ".env"), text, { mode: 0o644 });
      }, 1200);
      await done;
      expect(loadDotEnv(dir).HARNESS_API_KEY).toBe("key-from-editor");
      expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    } finally {
      process.chdir(cwd);
    }
  }, 15_000);
});
