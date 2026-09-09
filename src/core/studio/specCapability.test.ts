/**
 * specCapability 快测（node --experimental-strip-types 直跑）
 * 覆盖：specCapabilityFor（配方快照 + 协议能力合成）/ mergeAdapterReport（适配器真实上报合并——
 * Take 的 applied 只保留真实发送项，内部钳制与未应用项进 adjustments）/ mergeComfySpecReport（无入口转 adjustment）。
 */
import { specCapabilityFor, mergeAdapterReport, mergeComfySpecReport } from "./specCapability.ts";
import type { ResolvedVideoSpec } from "../types.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`✓ ${name}`);
};
const ok = (name: string, v: boolean) => eq(name, v, true);

const baseSpec: ResolvedVideoSpec = {
  requested: { resolution: { label: "2K", width: 2560, height: 1440 }, fps: 24, durationSec: 12 },
  applied: { resolution: { label: "2K", width: 2560, height: 1440 }, fps: 24, durationSec: 12 },
  source: { resolution: "segment-title", fps: "segment-title", durationSec: "segment-title" },
  adjustments: [],
};

/* specCapabilityFor：配方快照优先，无快照回落协议能力 */
const arkCard = { providerId: "p", role: "video", protocol: "ark", baseUrl: "https://x", model: "seedance", name: "seedance", apiKey: "k" } as never;
eq("能力组装:协议兜底", specCapabilityFor(undefined, arkCard).duration, { min: 4, max: 15, step: 1 });
eq("能力组装:协议 fps=null", specCapabilityFor(undefined, arkCard).fps, null);
eq(
  "能力组装:配方快照覆盖",
  specCapabilityFor({ capabilitySnapshot: { maxDurationSec: 10, durations: [4, 6, 8], firstFrame: true, lastFrame: false, referenceImages: 1, referenceVideos: 0, referenceAudio: 0, nativeAudio: false } }),
  { fps: undefined, duration: { min: 4, max: 10, step: 2 } },
);
eq("能力组装:无快照无卡", specCapabilityFor(undefined), {});

/* mergeAdapterReport：适配器如实上报（内部钳制 12→10s；fps 未发送；resolution 发送 2K 保持宽高） */
const merged = mergeAdapterReport(baseSpec, {
  durationSec: 10,
  resolution: "2K",
  unapplied: [{ field: "fps", reason: "火山方舟协议没有帧率直出参数——未发送 fps" }],
});
eq("合并:applied 时长=适配器真实值", merged.applied.durationSec, 10);
eq("合并:applied 无 fps", merged.applied.fps, undefined);
eq("合并:applied 分辨率保留宽高", merged.applied.resolution?.width, 2560);
eq("合并:requested 保留原值", merged.requested.durationSec, 12);
ok("合并:时长差异进 adjustments", merged.adjustments.some((a) => a.field === "fps" && a.applied === null));
// 适配器不发分辨率（如 siliconflow 折算失败）：applied 删项 + adjustment
const mergedNoRes = mergeAdapterReport(baseSpec, { durationSec: 10, unapplied: [] });
ok("合并:分辨率未发送进 adjustments", mergedNoRes.adjustments.some((a) => a.field === "resolution" && a.applied === null));
eq("合并:applied 无分辨率", mergedNoRes.applied.resolution, undefined);
// 分辨率档位被适配器改写：applied 跟随新档
const mergedRes = mergeAdapterReport(baseSpec, { durationSec: 12, resolution: "1080p" });
eq("合并:分辨率档位跟随", mergedRes.applied.resolution?.label, "1080p");
eq("合并:分辨率宽高重建", [mergedRes.applied.resolution?.width, mergedRes.applied.resolution?.height], [1920, 1080]);

/* mergeComfySpecReport：模板无入口 → applied 删项 + adjustment（warning 文本入 reason） */
const comfyMerged = mergeComfySpecReport(baseSpec, {
  resolutionApplied: false,
  fpsApplied: false,
  durationApplied: true,
  writtenNodes: [{ nodeId: "2", input: "value", value: 12, label: "时长（秒）" }],
  warnings: ["模板没有帧率/帧数入口（帧率 24fps 不会生效）", "模板没有分辨率入口（百万像素/宽高/比例都没有）——分辨率 不会生效"],
  actualValues: { durationSec: 12 },
});
eq("Comfy合并:时长 applied", comfyMerged.applied.durationSec, 12);
eq("Comfy合并:fps 删项", comfyMerged.applied.fps, undefined);
eq("Comfy合并:分辨率删项", comfyMerged.applied.resolution, undefined);
ok("Comfy合并:fps adjustment", comfyMerged.adjustments.some((a) => a.field === "fps" && /帧率/.test(a.reason)));
ok("Comfy合并:分辨率 adjustment", comfyMerged.adjustments.some((a) => a.field === "resolution" && /分辨率/.test(a.reason)));
// 只按 fps×duration 写了总帧数：时长 applied、fps 记换算事实（不是「未应用」）
const framesMerged = mergeComfySpecReport(baseSpec, {
  resolutionApplied: true,
  fpsApplied: false,
  durationApplied: true,
  writtenNodes: [{ nodeId: "1", input: "length", value: 288, label: "EmptyLatentVideo" }],
  warnings: [],
  actualValues: { frames: 288, width: 2560, height: 1440 },
});
ok("Comfy合并:帧数换算生效", framesMerged.applied.durationSec === 12 && framesMerged.applied.resolution?.width === 2560);
ok("Comfy合并:fps 换算事实入 adjustments", framesMerged.adjustments.some((a) => a.field === "fps" && /288 帧/.test(a.reason)));
eq("Comfy合并:无报告原样返回", mergeComfySpecReport(baseSpec, undefined), baseSpec);

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
