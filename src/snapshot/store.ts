import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SourceFriendSnapshot, SnapshotMeta } from "../source/types.js";
import { ensurePrivateDir, readJsonFile, writePrivateFile } from "../util.js";

/**
 * スナップショットはディレクトリ構造の JSON。
 *   meta.json / tags.json / fields.json / ... （マスタ）
 *   friends/index.json（一覧）、friends/<lmessage_friend_id>.json（1人分）
 * 1人1ファイルにしているのは、途中で止めても続きから再開できるようにするため。
 * 顧客データなので、フォルダは 0700・ファイルは 0600（本人だけが読める）で作る。
 */
export class SnapshotStore {
  constructor(readonly dir: string) {
    ensurePrivateDir(dir);
    ensurePrivateDir(join(dir, "friends"));
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  writeJson(name: string, data: unknown): void {
    const p = this.path(name);
    ensurePrivateDir(dirname(p));
    const tmp = `${p}.tmp`;
    writePrivateFile(tmp, JSON.stringify(data, null, 1));
    renameSync(tmp, p);
  }

  readJson<T>(name: string): T | null {
    return readJsonFile<T>(this.path(name));
  }

  has(name: string): boolean {
    return existsSync(this.path(name));
  }

  meta(): SnapshotMeta | null {
    return this.readJson<SnapshotMeta>("meta.json");
  }

  writeFriend(snap: SourceFriendSnapshot): void {
    this.writeJson(`friends/${snap.row.lmessage_friend_id}.json`, snap);
  }

  hasFriend(id: number): boolean {
    return this.has(`friends/${id}.json`);
  }

  readFriend(id: number): SourceFriendSnapshot | null {
    return this.readJson<SourceFriendSnapshot>(`friends/${id}.json`);
  }

  /** 保存済みの友だちを順に返す（メモリに全件載せない）。 */
  *friends(): Generator<SourceFriendSnapshot> {
    const dir = join(this.dir, "friends");
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
    for (const f of files) {
      yield JSON.parse(readFileSync(join(dir, f), "utf8")) as SourceFriendSnapshot;
    }
  }

  friendCount(): number {
    const dir = join(this.dir, "friends");
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).length;
  }
}
