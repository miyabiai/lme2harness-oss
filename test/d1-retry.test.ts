import { describe, expect, it } from "vitest";
import { isTransientD1Error } from "../src/d1/wrangler.js";

describe("D1 の一時的な失敗の判定", () => {
  it("アップロード失敗・内部エラー・5xx は再試行する", () => {
    expect(isTransientD1Error("✘ [ERROR] File could not be uploaded. Please retry.\n<Error><Code>InternalError</Code></Error>")).toBe(true);
    expect(isTransientD1Error("A request to the Cloudflare API failed. HTTP 503")).toBe(true);
    expect(isTransientD1Error("fetch failed")).toBe(true);
    expect(isTransientD1Error("✘ [ERROR] Network connection lost.")).toBe(true);
  });
  it("SQL の誤り・認証エラーは再試行しない", () => {
    expect(isTransientD1Error("no such table: friends: SQLITE_ERROR [code: 7500]")).toBe(false);
    expect(isTransientD1Error("Authentication error [code: 10000]")).toBe(false);
  });
});
