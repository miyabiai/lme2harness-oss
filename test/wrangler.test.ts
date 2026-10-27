import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { d1Query, localWranglerCommand, runWrangler, WRANGLER_VERSION } from "../src/d1/wrangler.js";

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "lme2harness-wrangler-"));
}

describe("wrangler の呼び出し", () => {
  it("出力の受け取りの切れ目で日本語・絵文字が壊れない", async () => {
    // 「架」の3バイトを2回に分けて書く子プロセス
    const script = "const b=Buffer.from('[{\"results\":[{\"v\":\"架空🍁\"}]}]');process.stdout.write(b.subarray(0,20));setTimeout(()=>process.stdout.write(b.subarray(20)),50)";
    const result = await runWrangler([], { databaseName: "x", command: [process.execPath, "-e", script] });
    expect(JSON.parse(result.stdout)[0].results[0].v).toBe("架空🍁");
    const rows = await d1Query("SELECT 1", { databaseName: "x", command: [process.execPath, "-e", script, "--"] });
    expect(rows[0].v).toBe("架空🍁");
  });

  it("wrangler 自身のログに結果を書かせない", async () => {
    const result = await runWrangler([], { databaseName: "x", command: [process.execPath, "-e", "process.stdout.write(String(process.env.WRANGLER_WRITE_LOGS))"] });
    expect(result.stdout).toBe("false");
  });

  it("引数はシェルを通さずそのまま渡る（記号や空白を含んでも分かれない）", async () => {
    const tricky = ["SELECT COUNT(*) AS c FROM friends WHERE name LIKE 'L Message%'", "a&b|c>d \"q\" %PATH%"];
    const result = await runWrangler(tricky, { databaseName: "x", command: [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))"] });
    expect(JSON.parse(result.stdout)).toEqual(tricky);
  });

  it("失敗したときのエラー文に SQL の中身（顧客データ）を出さない", async () => {
    const script = "process.stderr.write(\"✘ [ERROR] near VALUES: INSERT INTO friends (id, display_name) VALUES ('f1', '山田花子')\\nAuthentication error [code: 10000]\\n\");process.exit(1)";
    await expect(d1Query("SELECT 1", { databaseName: "x", command: [process.execPath, "-e", script, "--"] })).rejects.toThrow(/Authentication error/);
    await expect(d1Query("SELECT 1", { databaseName: "x", command: [process.execPath, "-e", script, "--"] })).rejects.not.toThrow(/山田花子/);
  });
});

describe("wrangler の起動コマンド", () => {
  it("Mac・Linux は手元の wrangler、無ければ版を固定した npx", () => {
    const dir = temporary();
    expect(localWranglerCommand(dir, "darwin")).toEqual(["npx", "--yes", `wrangler@${WRANGLER_VERSION}`]);
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "wrangler"), "");
    expect(localWranglerCommand(dir, "linux")).toEqual([join(dir, "node_modules", ".bin", "wrangler")]);
  });

  it("Windows はコマンドプロンプトを通さず、node で wrangler（無ければ npx）の本体を直接動かす", () => {
    const dir = temporary();
    const nodeDir = temporary();
    const node = join(nodeDir, "node.exe");
    expect(() => localWranglerCommand(dir, "win32", node)).toThrow(/WSL/);
    mkdirSync(join(nodeDir, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"), "");
    expect(localWranglerCommand(dir, "win32", node)).toEqual([node, join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"), "--yes", `wrangler@${WRANGLER_VERSION}`]);
    mkdirSync(join(dir, "node_modules", "wrangler", "bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "wrangler", "bin", "wrangler.js"), "");
    expect(localWranglerCommand(dir, "win32", node)).toEqual([node, join(dir, "node_modules", "wrangler", "bin", "wrangler.js")]);
  });
});
