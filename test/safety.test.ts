import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keptKvBlock, prepareBridgeState, saveBridgeState, syncBridgeTemplate } from "../src/commands/bridge.js";
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
    // 配備し終えるまでは保存しない（途中で失敗しても前の URL のまま使える）
    expect(JSON.parse(readFileSync(path, "utf8")).path_token_line).toBe(first.path_token_line);
    saveBridgeState(path, rotated);
    expect(JSON.parse(readFileSync(path, "utf8")).path_token_line).toBe(rotated.path_token_line);
  });

  it("移行先を記録する前の版で作った状態は、前の wrangler.toml の移行先と違えば止める", () => {
    const path = statePath();
    const first = prepareBridgeState(path, config);
    const old = { path_token_line: first.path_token_line, path_token_lmessage: first.path_token_lmessage, worker_name: "lme2harness-bridge", created_at: first.created_at };
    const toml = (id: string, url: string) => `name = "lme2harness-bridge"\n[[d1_databases]]\nbinding = "DB"\ndatabase_id = "${id}"\n\n[vars]\nHARNESS_URL = "${url}"\n`;
    writeFileSync(path, JSON.stringify(old));
    expect(() => prepareBridgeState(path, config, { previousToml: toml("11111111-1111-1111-1111-111111111111", config.harness_url!) })).toThrow(/別の移行先/);
    expect(() => prepareBridgeState(path, config, { previousToml: toml(config.d1_database_id!, "https://other.example.workers.dev") })).toThrow(/別の移行先/);
    expect(JSON.parse(readFileSync(path, "utf8")).target).toBeUndefined();
    expect(prepareBridgeState(path, config, { previousToml: toml(config.d1_database_id!, `${config.harness_url}/`) })).toMatchObject(old);
  });

  it("wrangler.toml を作り直しても、足した重複排除（KV）の設定は残す", () => {
    const previous = `name = "x"\n\n[vars]\nHARNESS_URL = "https://h"\n\n[[kv_namespaces]]\nbinding = "DEDUP"\nid = "abc123"\n`;
    expect(keptKvBlock(previous)).toBe(`\n[[kv_namespaces]]\nbinding = "DEDUP"\nid = "abc123"\n`);
    expect(keptKvBlock(`name = "x"\n`)).toBe("");
    // コメントにした設定は引き継がない（有効にすると配備が失敗する）
    expect(keptKvBlock(`name = "x"\n# [[kv_namespaces]]\n# binding = "DEDUP"\n# id = "<id>"\n`)).toBe("");
    expect(keptKvBlock(`[[kv_namespaces]]\nbinding = "DEDUP"\nid = "abc"\n# 後ろのメモ\n[vars]\nX = "1"\n`)).toBe(`\n[[kv_namespaces]]\nbinding = "DEDUP"\nid = "abc"\n# 後ろのメモ\n`);
    expect(keptKvBlock(null)).toBe("");
  });
});

describe("既存のブリッジを新しい版にする", () => {
  function dirs() {
    const root = mkdtempSync(join(tmpdir(), "lme2harness-bridge-sync-"));
    const src = join(root, "packaged");
    mkdirSync(join(src, "src"), { recursive: true });
    writeFileSync(join(src, "src", "index.ts"), "// 新しい版");
    writeFileSync(join(src, "package.json"), "{}");
    writeFileSync(join(src, "wrangler.toml"), "name = \"packaged\"");
    return { root, src, bridge: join(root, "bridge"), backup: join(root, "backup") };
  }

  it("初回はそのままコピーする（wrangler.toml はコピーしない）", () => {
    const d = dirs();
    expect(syncBridgeTemplate(d.src, d.bridge, d.backup)).toEqual([]);
    expect(readFileSync(join(d.bridge, "src", "index.ts"), "utf8")).toBe("// 新しい版");
    expect(existsSync(join(d.bridge, "wrangler.toml"))).toBe(false);
  });

  it("前の版で入れた Worker は新しくし、前のものは控えに残す。設定（wrangler.toml）と同じファイルには触らない", () => {
    const d = dirs();
    mkdirSync(join(d.bridge, "src"), { recursive: true });
    writeFileSync(join(d.bridge, "src", "index.ts"), "// 前の版");
    writeFileSync(join(d.bridge, "package.json"), "{}");
    writeFileSync(join(d.bridge, "wrangler.toml"), "name = \"mine\"");
    expect(syncBridgeTemplate(d.src, d.bridge, d.backup)).toEqual([join("src", "index.ts")]);
    expect(readFileSync(join(d.bridge, "src", "index.ts"), "utf8")).toBe("// 新しい版");
    expect(readFileSync(join(d.backup, "src", "index.ts"), "utf8")).toBe("// 前の版");
    expect(existsSync(join(d.backup, "package.json"))).toBe(false);
    expect(readFileSync(join(d.bridge, "wrangler.toml"), "utf8")).toBe("name = \"mine\"");
    // もう一度流しても何も変えない
    expect(syncBridgeTemplate(d.src, d.bridge, join(d.root, "backup2"))).toEqual([]);
    expect(existsSync(join(d.root, "backup2"))).toBe(false);
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
