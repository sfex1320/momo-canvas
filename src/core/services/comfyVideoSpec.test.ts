/**
 * applyVideoSpecToWorkflow 快测（node --experimental-strip-types 直跑）
 * 覆盖（3.5 §6.8）五种模板情况：宽高+FPS+帧数全有 / 只有宽高 / 只有帧数 / 完全没有规格入口 / 下拉比例匹配失败。
 * 纯工作流注入层测试——未连接真实 ComfyUI（联调需在线实例）。
 */
import { applyVideoSpecToWorkflow } from "./comfy.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`✓ ${name}`);
};

type Wf = Parameters<typeof applyVideoSpecToWorkflow>[0];
const node = (classType: string, inputs: Record<string, unknown>, title?: string) => ({
  class_type: classType,
  inputs,
  _meta: title ? { title } : undefined,
});

/* ① 宽高 + FPS 参数 + 帧数入口全有 */
const wf1: Wf = {
  "1": node("EmptyLatentVideo", { width: 512, height: 512, length: 96 }),
  "2": node("PrimitiveFloat", { value: 12 }, "时长（秒）"),
  "3": node("PrimitiveFloat", { value: 24 }, "帧率 fps"),
};
const r1 = applyVideoSpecToWorkflow(wf1, [], { durationSec: 10, fps: 24, resolution: { width: 1920, height: 1080 } });
eq("全有:时长写入", wf1["2"].inputs.value, 10);
eq("全有:fps 参数写入", wf1["3"].inputs.value, 24);
eq("全有:宽高直写", [wf1["1"].inputs.width, wf1["1"].inputs.height], [1920, 1080]);
eq("全有:三项 applied", [r1.durationApplied, r1.fpsApplied, r1.resolutionApplied], [true, true, true]);
eq("全有:无警告", r1.warnings, []);
eq("全有:actualValues.fps", r1.actualValues.fps, 24);
eq("全有:actualValues.durationSec", r1.actualValues.durationSec, 10);
eq("全有:actualValues.width/height", [r1.actualValues.width, r1.actualValues.height], [1920, 1080]);

/* ② 只有宽高（无 FPS 参数、无帧数入口）→ fps 不生效 + 明确 warning */
const wf2: Wf = { "1": node("EmptyLatentImage", { width: 512, height: 512 }) };
const r2 = applyVideoSpecToWorkflow(wf2, [], { durationSec: 10, fps: 30, resolution: { width: 1280, height: 720 } });
eq("只有宽高:宽高写入", [wf2["1"].inputs.width, wf2["1"].inputs.height], [1280, 720]);
eq("只有宽高:resolutionApplied", r2.resolutionApplied, true);
eq("只有宽高:fpsApplied", r2.fpsApplied, false);
eq("只有宽高:fps warning", r2.warnings.some((w) => /帧率 \/ 帧数入口|帧率.*不会生效/.test(w) || /帧率\/帧数入口/.test(w)), true);
eq("只有宽高:时长未生效 warning", r2.warnings.some((w) => /时长.*不会生效|时长\/帧数入口/.test(w)), true);

/* ③ 只有帧数入口（length）→ 帧数 = 最终 fps × duration；fps 无独立入口但换算生效 */
const wf3: Wf = { "1": node("EmptySD3LatentVideo", { length: 49, width: 512, height: 512 }) };
const r3 = applyVideoSpecToWorkflow(wf3, [], { durationSec: 12, fps: 24 });
eq("只有帧数:帧数换算", wf3["1"].inputs.length, 288);
eq("只有帧数:durationApplied（帧数承载）", r3.durationApplied, true);
eq("只有帧数:fps 无独立入口", r3.fpsApplied, false);
eq("只有帧数:actualValues.frames", r3.actualValues.frames, 288);
eq("只有帧数:分辨率未提供不警告", r3.warnings.filter((w) => /分辨率/.test(w)).length, 0);

/* ④ 完全没有规格入口 → 三项都有 warning，全部不 applied */
const wf4: Wf = { "1": node("CheckpointLoaderSimple", { ckpt_name: "a.safetensors" }) };
const r4 = applyVideoSpecToWorkflow(wf4, [], { durationSec: 10, fps: 24, resolution: { width: 1920, height: 1080 } });
eq("无入口:全部未 applied", [r4.durationApplied, r4.fpsApplied, r4.resolutionApplied], [false, false, false]);
eq("无入口:时长 warning", r4.warnings.some((w) => /时长/.test(w)), true);
eq("无入口:帧率 warning", r4.warnings.some((w) => /帧率|帧数/.test(w)), true);
eq("无入口:分辨率 warning", r4.warnings.some((w) => /分辨率/.test(w)), true);
eq("无入口:没有写入任何节点", r4.writtenNodes, []);

/* ⑤ 下拉分辨率/比例：匹配成功写选项值；匹配失败保持原值 + warning */
const wf5: Wf = { "1": node("ResolutionSelector", { aspect_ratio: "1:1 (Square)", megapixels: 1 }) };
const r5hit = applyVideoSpecToWorkflow(wf5, [], { resolution: { aspect: "16:9", mp: 1 } }, {
  aspectOptions: () => ["1:1 (Square)", "16:9 (Widescreen)", "9:16 (Portrait)"],
});
eq("下拉:匹配成功写选项值", wf5["1"].inputs.aspect_ratio, "16:9 (Widescreen)");
eq("下拉:resolutionApplied", r5hit.resolutionApplied, true);
eq("下拉:actualValues.aspect", r5hit.actualValues.aspect, "16:9 (Widescreen)");

const wf5b: Wf = { "1": node("ResolutionSelector", { aspect_ratio: "1:1 (Square)", megapixels: 1 }) };
const r5miss = applyVideoSpecToWorkflow(wf5b, [], { resolution: { aspect: "21:9" } }, {
  aspectOptions: () => ["1:1 (Square)", "16:9 (Widescreen)"],
});
eq("下拉:匹配失败保持原值", wf5b["1"].inputs.aspect_ratio, "1:1 (Square)");
eq("下拉:失败 warning", r5miss.warnings.some((w) => /21:9.*不在模板下拉选项表/.test(w)), true);

/* 暴露参数优先于输入名兜底：megapixels 参数命中走参数分支 */
const wf6: Wf = { "1": node("ResolutionSelector", { megapixels: 1 }) };
const r6 = applyVideoSpecToWorkflow(
  wf6,
  [{ key: "1.megapixels", nodeId: "1", input: "megapixels", label: "百万像素", kind: "number", value: 1 }],
  { resolution: { mp: 2 } },
);
eq("参数:百万像素命中", wf6["1"].inputs.megapixels, 2);
eq("参数:writtenNodes 记录", r6.writtenNodes, [{ nodeId: "1", input: "megapixels", value: 2, label: "ResolutionSelector" }]);

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
