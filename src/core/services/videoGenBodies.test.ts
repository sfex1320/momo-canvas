/**
 * 视频适配器请求体与规格报告快测（node --experimental-strip-types 直跑）
 * 覆盖（3.5 §6.5/§6.8）：Ark / DashScope / Google / 通用 OpenAI 兼容 / 智谱 / 硅基流动 / 自定义协议 ——
 * 请求体字段构造 + duration 钳制 + resolution 传递 + fps 不发送的报告 + 自定义协议 {{fps}} 占位符消费。
 * 注意：这是请求体构造层测试，未执行真实外部生成（联调需真实 Key）。
 */
import { buildArkSeedanceBody, buildDashscopeWanBody, buildGoogleVideoBody } from "./videoAdapters.ts";
import { buildZhipuVideoBody, buildSiliconflowVideoBody, buildOpenAiVideoBody, buildCustomVideoVars, customProtoSpecReport, videoEngineCapability } from "./videoGen.ts";
import type { CustomProtocol, ModelCard } from "../types.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`✓ ${name}`);
};

const card = (protocol: string, model = "test-model"): ModelCard =>
  ({ providerId: "p", providerName: "P", role: "video", protocol, baseUrl: "https://api.example.com", model, name: model, apiKey: "k" }) as never as ModelCard;
const req = (over: Record<string, unknown> = {}) => ({
  prompt: "a cat",
  duration: "5",
  resolution: "1080p",
  fps: 24,
  aspect: "16:9",
  ...over,
}) as never as Parameters<typeof buildArkSeedanceBody>[1];

/* ---------------- Ark · Seedance ---------------- */
const ark = buildArkSeedanceBody(card("ark"), req());
eq("Ark:duration 直出", (ark.body as Record<string, unknown>).duration, 5);
eq("Ark:resolution 直出", (ark.body as Record<string, unknown>).resolution, "1080p");
eq("Ark:fps 未发送", "fps" in (ark.body as Record<string, unknown>), false);
eq("Ark:报告 durationSec", ark.report.durationSec, 5);
eq("Ark:报告 fps 未应用", ark.report.unapplied?.some((u) => u.field === "fps"), true);
const arkClamp = buildArkSeedanceBody(card("ark"), req({ duration: "20" }));
eq("Ark:时长钳制 20→15", (arkClamp.body as Record<string, unknown>).duration, 15);
eq("Ark:钳制入报告", arkClamp.report.durationSec, 15);
eq("Ark:钳制记未应用差异", arkClamp.report.unapplied?.some((u) => u.field === "durationSec" && /取整/.test(u.reason)), true);
const arkFrac = buildArkSeedanceBody(card("ark"), req({ duration: "5.6" }));
eq("Ark:小数取整 5.6→6", (arkFrac.body as Record<string, unknown>).duration, 6);

/* ---------------- DashScope · Wan ---------------- */
const ds = buildDashscopeWanBody(card("dashscope"), req());
eq("DS:parameters.duration", (ds.params as Record<string, unknown>).duration, 5);
eq("DS:1080p→size 1920*1080", (ds.params as Record<string, unknown>).size, "1920*1080");
eq("DS:fps 未发送", "fps" in (ds.params as Record<string, unknown>), false);
eq("DS:报告 fps 未应用", ds.report.unapplied?.some((u) => u.field === "fps"), true);
const dsClamp = buildDashscopeWanBody(card("dashscope"), req({ duration: "1" }));
eq("DS:时长钳制 1→2", (dsClamp.params as Record<string, unknown>).duration, 2);
const ds720 = buildDashscopeWanBody(card("dashscope"), req({ resolution: "720p" }));
eq("DS:720p→size 1280*720", (ds720.params as Record<string, unknown>).size, "1280*720");

/* ---------------- Google · Omni/Veo ---------------- */
const gg = buildGoogleVideoBody(card("google", "veo-3.1"), req());
eq("Google:durationSeconds", (gg.parameters as Record<string, unknown>).durationSeconds, 5);
eq("Google:resolution 随请求提交", (gg.parameters as Record<string, unknown>).resolution, "1080p");
eq("Google:aspectRatio", (gg.parameters as Record<string, unknown>).aspectRatio, "16:9");
eq("Google:model 后缀 predictLongRunning", gg.model.includes(":predictLongRunning") || gg.model.includes(":"), true);
eq("Google:fps 未发送", "fps" in (gg.parameters as Record<string, unknown>), false);
const ggClamp = buildGoogleVideoBody(card("google"), req({ duration: "12" }));
eq("Google:时长钳制 12→8", (ggClamp.parameters as Record<string, unknown>).durationSeconds, 8);
eq("Google:钳制入报告", ggClamp.report.durationSec, 8);

/* ---------------- 通用 OpenAI 兼容（Sora 风格） ---------------- */
const oa = buildOpenAiVideoBody(req(), "sora-2", "sora");
eq("OpenAI:seconds 字符串", (oa.body as Record<string, unknown>).seconds, "5");
eq("OpenAI:size 存在", typeof (oa.body as Record<string, unknown>).size, "string");
eq("OpenAI:fps 未发送", "fps" in (oa.body as Record<string, unknown>), false);
eq("OpenAI:报告 fps 未应用", oa.report.unapplied?.some((u) => u.field === "fps"), true);
const oaGeneric = buildOpenAiVideoBody(req(), "wan-generic", "generic");
eq("OpenAI:通用家族 size 折算", /^\d{3,4}x\d{3,4}$/.test(String((oaGeneric.body as Record<string, unknown>).size)), true);

/* ---------------- 智谱 / 硅基流动 ---------------- */
const zp = buildZhipuVideoBody(card("zhipu"), req());
eq("智谱:duration 数字", (zp.body as Record<string, unknown>).duration, 5);
eq("智谱:size 折算", (zp.body as Record<string, unknown>).size, "1920x1080");
eq("智谱:fps 未发送", "fps" in (zp.body as Record<string, unknown>), false);
const sf = buildSiliconflowVideoBody(req(), "sf-model");
eq("硅基:无 duration 字段", "duration" in (sf.body as Record<string, unknown>), false);
eq("硅基:时长未应用入报告", sf.report.unapplied?.some((u) => u.field === "durationSec"), true);
eq("硅基:image_size", (sf.body as Record<string, unknown>).image_size, "1920x1080");

/* ---------------- 自定义协议：{{fps}} 占位符消费 ---------------- */
const vars = buildCustomVideoVars(card("custom:x"), req());
eq("自定义:fps 变量值", vars.fps, "24");
eq("自定义:duration 变量值", vars.duration, "5");
eq("自定义:resolution 变量值", vars.resolution, "1080p");
const protoWithFps = {
  id: "x", name: "x", role: "video", enabled: true,
  submit: { url: "https://api.example.com/v", method: "POST", body: '{"model":"{{model}}","prompt":"{{prompt}}","duration":{{duration}},"resolution":"{{resolution}}","fps":{{fps}}}' },
  resultPath: "data.url",
} as never as CustomProtocol;
const repHit = customProtoSpecReport(protoWithFps, req(), vars);
eq("自定义:模板引用 {{fps}} → applied", repHit.fps, 24);
eq("自定义:applied duration", repHit.durationSec, 5);
eq("自定义:无未应用项", repHit.unapplied, undefined);
const protoNoFps = {
  id: "y", name: "y", role: "video", enabled: true,
  submit: { url: "https://api.example.com/v", method: "POST", body: '{"model":"{{model}}","prompt":"{{prompt}}","duration":{{duration}}}' },
  resultPath: "data.url",
} as never as CustomProtocol;
const repMiss = customProtoSpecReport(protoNoFps, req(), vars);
eq("自定义:模板没引用 {{fps}} → 未应用", repMiss.unapplied?.some((u) => u.field === "fps" && /未引用/.test(u.reason)), true);
eq("自定义:没引用则 applied 无 fps", repMiss.fps, undefined);

/* ---------------- videoEngineCapability：引擎能力描述 ---------------- */
eq("能力:ark fps=null", videoEngineCapability(card("ark")).fps, null);
eq("能力:ark duration", videoEngineCapability(card("ark")).duration, { min: 4, max: 15, step: 1 });
eq("能力:google duration", videoEngineCapability(card("google")).duration, { min: 4, max: 8 });
eq("能力:dashscope resolutions", videoEngineCapability(card("dashscope")).resolutions, ["720p", "1080p"]);
eq("能力:openai fps=null", videoEngineCapability(card("openai")).fps, null);
eq("能力:custom 不钳制 fps", videoEngineCapability(card("custom:z")).fps, undefined);

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
