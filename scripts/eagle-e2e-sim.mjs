/**
 * MOMO × Eagle 资产桥 — 端到端多流程模拟（对真实 Eagle API 执行）
 *
 * 流程覆盖：收录(copy-in) → 存储核验(store) → 元数据加工(simulate Eagle-side edit)
 *          → 提取(read-back) → 重复收录幂等(idempotency) → 删除往返(non-destructive delete)
 *
 * 运行：node scripts/eagle-e2e-sim.mjs   （需要 Eagle 正在运行）
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** 生成内容唯一的 32x32 PNG（Eagle 按内容指纹查重，含回收站——实验素材必须每轮不同） */
function makeUniquePng(seed) {
  const w = 32, h = 32;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let st = seed >>> 0 || 1;
  const rnd = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 0xffffffff);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const at = y * (w * 3 + 1) + 1 + x * 3;
      raw[at] = Math.floor(rnd() * 256);
      raw[at + 1] = Math.floor(rnd() * 256);
      raw[at + 2] = Math.floor(rnd() * 256);
    }
  }
  const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcB = Buffer.alloc(4);
    crcB.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcB]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const HOST = "http://127.0.0.1:41595";
const ROOT_NAME = process.env.EAGLE_ROOT || "Eagle-Momo";
let pass = 0, fail = 0;

const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};

const api = async (method, p, body) => {
  const r = await fetch(`${HOST}${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};

async function main() {
  console.log(`\n=== MOMO × Eagle 多流程模拟（根文件夹：${ROOT_NAME}）===\n`);

  /* ⓪ 健康检查 */
  const app = await api("GET", "/api/v2/app/info");
  ok("健康检查", app?.status === "success", JSON.stringify(app).slice(0, 80));
  const lib = await api("GET", "/api/v2/library/info");
  ok("读取素材库", lib?.status === "success" && !!lib.data?.path);

  /* ① 找/建根文件夹 */
  const findRoot = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.name === ROOT_NAME) return n;
      const deep = findRoot(n.children);
      if (deep) return deep;
    }
    return null;
  };
  let root = findRoot(lib.data.folders);
  if (!root) {
    const created = await api("POST", "/api/v2/folder/create", { name: ROOT_NAME, description: "MOMO 智能画布资产同步根目录" });
    root = created.data;
  }
  ok("根文件夹就位", !!root?.id, JSON.stringify(root).slice(0, 80));

  /* ② 收录：从 MOMO assets 目录取 2 张现存图（两遍不同名 = 两遍拷贝） */
  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "momo-e2e-"));
  const pics = [0, 1].map((i) => {
    const f = path.join(tmpDir, `momo-e2e-${Date.now()}-${i}.png`);
    fs.writeFileSync(f, makeUniquePng(Date.now() + i * 7919));
    return f;
  });
  ok("生成唯一实验素材", pics.every((f) => fs.existsSync(f)));

  const ids = [];
  for (let i = 0; i < pics.length; i++) {
    const r = await api("POST", "/api/v2/item/add", {
      items: [{ path: pics[i], name: `MOMO模拟${i + 1}_${Date.now() % 100000}`, tags: ["MOMO", "模拟"], folders: [root.id], annotation: `来自 MOMO 模拟流程 #${i + 1}` }],
    });
    ok(`第 ${i + 1} 遍收录受理`, r?.status === "success" && !!r.data?.ids?.[0]);
    ids.push(r.data.ids[0]);
  }

  /* ③ 存储核验：等 Eagle 异步入库完成（网络盘可能慢，轮询最多 15s） */
  const waitItem = async (id, tries = 15) => {
    for (let t = 0; t < tries; t++) {
      const q = await api("POST", "/api/v2/item/get", { ids: [id] });
      if (q?.data?.data?.[0]) return q.data.data[0];
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  };
  const it0 = await waitItem(ids[0]);
  ok("存储核验：条目落库", !!it0);
  ok("存储核验：归位根文件夹", it0?.folders?.includes(root.id), JSON.stringify(it0?.folders));
  ok("存储核验：标签写入", JSON.stringify(it0?.tags ?? []).includes("MOMO"));

  /* ④ 模拟 Eagle 端加工：改名 + 加星（MOMO 双向模式要拉回的就是这类变化） */
  const u = await api("POST", "/api/v2/item/update", { id: ids[0], name: `${it0.name}·已加工`, star: 4 });
  ok("Eagle 端加工（改名+评分）", u?.status === "success" && u.data !== false);
  const it1 = await waitItem(ids[0], 5);
  ok("加工后回读生效", it1?.name?.endsWith("·已加工") && it1?.star === 4, JSON.stringify({ name: it1?.name, star: it1?.star }));
  ok("修改游标前移（增量扫描依据：Eagle 改名只动 lastModified）", (it1?.lastModified ?? 0) > (it0?.lastModified ?? 0));

  /* ⑤ 重复收录幂等（MOMO 侧靠 itemId 记忆；这里验证 Eagle 端行为以确认防线必要） */
  const dup = await api("POST", "/api/v2/item/add", {
    items: [{ path: pics[0], name: "MOMO模拟_重复推", tags: ["MOMO"], folders: [root.id] }],
  });
  ok("重复收录受理（幂等由 MOMO itemId 记忆保证）", dup?.status === "success");

  /* ⑥ 删除往返：isDeleted true → false（验证非破坏，不真删文件） */
  const del = await api("POST", "/api/v2/item/update", { id: ids[1], isDeleted: true });
  ok("模拟删除（isDeleted）", del?.status === "success");
  const gone = await api("POST", "/api/v2/item/get", { ids: [ids[1]] });
  ok("删除后列表不可见", (gone?.data?.data ?? []).length === 0);
  await api("POST", "/api/v2/item/update", { id: ids[1], isDeleted: false });
  const back = await api("POST", "/api/v2/item/get", { ids: [ids[1]] });
  ok("恢复后可见（非破坏删除验证完毕）", (back?.data?.data ?? []).length === 1);

  /* 清理：把模拟条目全部标记删除（留库干净），文件在 Eagle 回收站可找回 */
  for (const id of [...ids, dup.data.ids[0]]) {
    await api("POST", "/api/v2/item/update", { id, isDeleted: true });
  }
  for (const f of pics) fs.rmSync(f, { force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n（模拟产生的 ${ids.length + 1} 条已移入 Eagle 回收站，可随时彻底清除）`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("模拟中断:", e.message);
  process.exit(1);
});
