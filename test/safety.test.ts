import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keptKvBlock, prepareBridgeState } from "../src/commands/bridge.js";
import { stepsCheck } from "../src/commands/verify.js";
import { isSafeHarnessUrl } from "../src/harness/api.js";
import type { PlanManifest } from "../src/mapping/plan.js";

const config = { d1_database_id: "00000000-0000-0000-0000-000000000000", harness_url: "https://fictional-harness.example.workers.dev" } as Parameters<typeof prepareBridgeState>[1];

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), "lme2harness-bridge-")), ".lme2harness", "bridge.json");
}

describe("ブリッジの状態", () => {
  it("新しいフォルダでは Worker 名の末尾をフォルダごとに変え、本人だけが読める権限で保存する", () => {
    const a = prepareBridgeState(statePath(), config);
    const b = prepareBridgeState(statePath(), config);
    expect(a.worker_name).toMatch(/^lme2harness-bridge-[0-9a-f]{8}$/);
    expect(a.worker_name).not.toBe(b.worker_name);
    expect(prepareBridgeState(statePath(), { ...config, bridge_worker_name: "my-bridge" }).worker_name).toBe("my-bridge");
  });

  it.skipIf(process.platform === "win32")("状態ファイルは 0600", () => {
    const path = statePath();
    prepareBridgeState(path, config);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("前に作った状態（古い版の固定の Worker 名も）は Worker 名・URL を変えず、移行先を記録する", () => {
    const path = statePath();
    const first = prepareBridgeState(path, config);
    const old = { path_token_line: first.path_token_line, path_token_lmessage: first.path_token_lmessage, worker_name: "lme2harness-bridge", created_at: first.created_at };
    // 古い版が書いた状態（target なし）
    writeFileSync(path, JSON.stringify(old));
    const again = prepareBridgeState(path, config);
    expect(again).toMatchObject(old);
    expect(JSON.parse(readFileSync(path, "utf8")).target).toBeTruthy();
  });

  it("別の移行先のつなぎ先で配備し直そうとしたら止める", () => {
    const path = statePath();
    prepareBridgeState(path, config);
    expect(() => prepareBridgeState(path, { ...config, d1_database_id: "11111111-1111-1111-1111-111111111111" })).toThrow(/別の移行先/);
  });

  it("--rotate-token は --deploy と一緒のときだけ、同じ Worker のまま両方のトークンを作り直す", () => {
    const path = statePath();
    const first = prepareBridgeState(path, config);
    expect(() => prepareBridgeState(path, config, { rotateToken: true })).toThrow(/--deploy/);
    const rotated = prepareBridgeState(path, config, { rotateToken: true, deploy: true });
    expect(rotated.worker_name).toBe(first.worker_name);
    expect(rotated.path_token_line).not.toBe(first.path_token_line);
    expect(rotated.path_token_lmessage).not.toBe(first.path_token_lmessage);
    expect(rotated.path_token_line).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(JSON.parse(readFileSync(path, "utf8")).path_token_line).toBe(rotated.path_token_line);
  });

  it("wrangler.toml を作り直しても、足した重複排除（KV）の設定は残す", () => {
    const previous = `name = "x"\n\n[vars]\nHARNESS_URL = "https://h"\n\n[[kv_namespaces]]\nbinding = "DEDUP"\nid = "abc123"\n`;
    expect(keptKvBlock(previous)).toBe(`\n[[kv_namespaces]]\nbinding = "DEDUP"\nid = "abc123"\n`);
    expect(keptKvBlock(`name = "x"\n`)).toBe("");
    expect(keptKvBlock(null)).toBe("");
  });
});

describe("verify のステップ件数", () => {
  const manifest = { counts: { scenario_steps: 5 }, steps_by_scenario: { "sc-1": 3, "sc-2": 2 } } as unknown as PlanManifest;
  const d1With = (rows: unknown[]) => ({ databaseName: "x", command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(JSON.stringify([{ results: rows }]))})`, "--"] });

  it("L Harness で有効にしたシナリオのステップは数えない", async () => {
    const check = await stepsCheck(manifest, d1With([{ id: "sc-1" }, { id: "not-planned" }]));
    expect(check.expected).toBe(2);
    expect(check.sql).toContain("c.is_active = 0");
  });

  it("有効なシナリオが無い・古い計画では、これまでどおり全部を数える", async () => {
    expect((await stepsCheck(manifest, d1With([]))).expected).toBe(5);
    expect((await stepsCheck({ counts: { scenario_steps: 5 } } as unknown as PlanManifest, d1With([{ id: "sc-1" }]))).expected).toBe(5);
  });
});

describe("L Harness の URL", () => {
  it("API キーは https か手元（localhost）にだけ送る", () => {
    expect(isSafeHarnessUrl("https://h.example.workers.dev")).toBe(true);
    expect(isSafeHarnessUrl("http://localhost:8787")).toBe(true);
    expect(isSafeHarnessUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isSafeHarnessUrl("http://h.example.workers.dev")).toBe(false);
    expect(isSafeHarnessUrl("ftp://h")).toBe(false);
  });
});
