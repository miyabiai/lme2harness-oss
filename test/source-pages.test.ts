import { describe, expect, it } from "vitest";
import { LmeSource } from "../src/lme/source.js";
import type { LmeMcpClient } from "../src/lme/mcp-client.js";

/** get_form_responses のように pagination.total が「そのページの件数」しか返さない MCP を模す */
function fakeMcp(totalRows: number, limit = 100): LmeMcpClient {
  const calls: number[] = [];
  const client = {
    calls,
    hasToken: () => true,
    async call(_name: string, args: Record<string, unknown>) {
      const page = Number(args.page ?? 1);
      calls.push(page);
      const start = (page - 1) * limit;
      const rows = Array.from({ length: Math.max(0, Math.min(limit, totalRows - start)) }, (_, i) => ({ id: start + i + 1 }));
      return { form_id: 1, pagination: { currentPage: page, limit, total: rows.length }, responses: rows };
    },
  };
  return client as unknown as LmeMcpClient;
}

describe("MCP のページ送り", () => {
  it("pagination.total がページ内件数でも最後まで読む", async () => {
    const mcp = fakeMcp(4575);
    const source = new LmeSource({ mcp, botId: "b", mcpIntervalMs: 0 });
    const rows = await source.formResponses(1);
    expect(rows).toHaveLength(4575);
    expect((mcp as unknown as { calls: number[] }).calls).toEqual(Array.from({ length: 46 }, (_, i) => i + 1));
  });

  it("件数が limit の倍数なら空ページを 1 回だけ読んで止まる", async () => {
    const mcp = fakeMcp(200);
    const source = new LmeSource({ mcp, botId: "b", mcpIntervalMs: 0 });
    expect(await source.formResponses(1)).toHaveLength(200);
    expect((mcp as unknown as { calls: number[] }).calls).toEqual([1, 2, 3]);
  });
});
