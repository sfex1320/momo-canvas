import assert from "node:assert/strict";
import { activeEagleAssets, newEagleImports } from "../../src/core/eagleSyncIdentity";
import type { AssetItem } from "../../src/core/types";

const asset = (id: string, revision: number, patch: Partial<AssetItem> = {}): AssetItem => ({
  id, kind: "image", name: id, path: "fixture.png", size: 10, createdAt: revision, folderId: null,
  eagle: { itemId: "remote-1", libraryKey: "lib-a", pairId: "pair", linkedAt: 1, state: "synced", lastRemoteModifiedAt: 200 },
  lineage: { rootAssetId: "old", revision }, ...patch,
} as AssetItem);
const old = asset("old", 0);
old.eagle = { ...old.eagle!, state: "remote-dirty", lastRemoteModifiedAt: undefined };
const latest = asset("latest", 1, { lineage: { rootAssetId: "old", parentAssetId: "old", revision: 1 } });
// 回归：旧版本状态曾被扫描改回 remote-dirty，也不得重新进入同步。
assert.deepEqual(activeEagleAssets([old, latest], "lib-a").map(i => i.id), ["latest"]);
assert.deepEqual(activeEagleAssets([latest, old], "lib-a").map(i => i.id), ["latest"]);
const previous = new Set(["old", "latest"]);
for (let i = 0; i < 20; i++) {
  const selected = activeEagleAssets([old, latest], "lib-a");
  assert.equal(selected.filter(a => a.eagle!.lastRemoteModifiedAt !== 200).length, 0);
  assert.equal(newEagleImports(selected, previous).length, 0);
}
const next = asset("next", 2, { lineage: { rootAssetId: "old", parentAssetId: "latest", revision: 2 } });
assert.equal(newEagleImports([next], previous).length, 1);
assert.equal(newEagleImports([next], new Set([...previous, next.id])).length, 0);
const otherLibrary = asset("other", 5); otherLibrary.eagle!.libraryKey = "lib-b";
assert.deepEqual(activeEagleAssets([latest, otherLibrary], "lib-a").map(i => i.id), ["latest"]);
assert.equal(activeEagleAssets([{ ...latest, deletedAt: 10 }], "lib-a").length, 0);
const localCopy = asset("copy", 2, { eagle: undefined, lineage: { rootAssetId: "old", parentAssetId: "latest", revision: 2 } });
assert.deepEqual(activeEagleAssets([latest, localCopy], "lib-a").map(i => i.id), ["latest"]);
const offline = asset("offline", 0); offline.eagle!.state = "offline";
assert.equal(activeEagleAssets([offline], "lib-a").length, 1);
console.log("Eagle 同步回归通过：旧版本排除、20 轮无重复更新、真实新版本通知、库隔离、删除过滤、普通副本和离线恢复。");
