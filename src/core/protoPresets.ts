/**
 * 常用中转站协议预设 — 一键导入/修复
 *  按服务商 baseUrl 匹配：若该服务商的对应槽位已绑定自定义协议，则「原地覆盖」其内容
 *  （保留原 id，绑定关系不变）；未绑定则新建协议并自动绑定到匹配的服务商槽位。
 *
 *  预设内容来自对各中转站官方文档/网页端源码的逆向核对（2026-07）：
 *   - 65535.space：文生图 /v1/images/generations、图生图与蒙版 /v1/images/edits（纯 JSON，
 *     image_urls 收 dataURL，mask 为 {"image_url": dataURL} 对象），official_fallback:false
 *     触发逆向异步通道；轮询 /v1/images/async-generations/{job_id}，done/failed，
 *     结果 result_urls[] 或 result_b64[]。
 *   - APIMart（api.apimart.ai / api.aishuch.com）：逆向通道 gpt-image-2 的 image_urls 接受
 *     base64 dataURL；真蒙版仅官方通道 mask_url（公网 URL）支持，故此预设不带 {{mask}}——
 *     局部重绘请在节点上选「指令式」通道。轮询 GET /v1/tasks/{task_id}。
 */
import type { CustomProtocol } from "./types";
import { useSettings } from "./stores/settingsStore";
import { uid } from "./utils";

export type ProtoPreset = {
  key: string;
  label: string;
  /** 匹配服务商 baseUrl 的正则（自动定位要修复/绑定的卡片） */
  hostMatch: RegExp;
  note: string;
  proto: Omit<CustomProtocol, "id">;
};

const AUTH_HEADERS = { Authorization: "Bearer {{apiKey}}", "Content-Type": "application/json" };

export const PROTO_PRESETS: ProtoPreset[] = [
  {
    key: "65535-image",
    label: "65535 异步生图（文生图 + 图生图 + 真蒙版）",
    hostMatch: /65535\.space/i,
    note: "有参考图自动切 /v1/images/edits；蒙版按官方 {\"image_url\":…} 对象格式；异步轮询 job 状态",
    proto: {
      name: "65535 异步生图（图生图+蒙版·修正版）",
      role: "image",
      submit: {
        url: "{{baseUrl}}/v1/images/{{?images}}edits{{/images}}{{^images}}generations{{/images}}",
        method: "POST",
        headers: AUTH_HEADERS,
        body: '{"model":"{{model}}","prompt":"{{prompt}}","n":{{n}},"size":"{{size}}","official_fallback":false{{?images}},"image_urls":{{images}}{{/images}}{{?mask}},"mask":{"image_url":"{{mask}}"}{{/mask}}}',
      },
      taskIdPath: "job_id",
      poll: {
        url: "{{baseUrl}}/v1/images/async-generations/{{taskId}}",
        method: "GET",
        headers: { Authorization: "Bearer {{apiKey}}" },
        intervalMs: 3000,
        statusPath: "status",
        doneValue: "done",
        failValue: "failed",
      },
      resultPath: "result_urls[]",
    },
  },
  {
    key: "apimart-image",
    label: "APIMart GPT-Image-2 异步生图（文生图 + 图生图）",
    hostMatch: /apimart\.ai|aishuch\.com/i,
    note: "逆向通道 image_urls 接受 base64 参考图；该通道不支持真蒙版（重绘节点请用「指令式」）",
    proto: {
      name: "APIMart GPT-Image-2 异步生图（修正版）",
      role: "image",
      submit: {
        url: "{{baseUrl}}/v1/images/generations",
        method: "POST",
        headers: AUTH_HEADERS,
        body: '{"model":"{{model}}","prompt":"{{prompt}}","n":{{n}},"size":"{{size}}"{{?images}},"image_urls":{{images}}{{/images}}}',
      },
      taskIdPath: "data[].task_id",
      poll: {
        url: "{{baseUrl}}/v1/tasks/{{taskId}}",
        method: "GET",
        headers: { Authorization: "Bearer {{apiKey}}" },
        intervalMs: 3000,
        statusPath: "data.status",
        doneValue: "completed",
        failValue: "failed",
      },
      resultPath: "data.result.images[].url[]",
    },
  },
  {
    key: "apimart-video",
    label: "APIMart Seedance 异步生视频（文/图生视频）",
    hostMatch: /apimart\.ai|aishuch\.com/i,
    note: "image 字段按有无上游图条件出现（纯文生视频不再发空 image）",
    proto: {
      name: "APIMart Seedance 异步生视频（修正版）",
      role: "video",
      submit: {
        url: "{{baseUrl}}/v1/videos/generations",
        method: "POST",
        headers: AUTH_HEADERS,
        body: '{"model":"{{model}}","prompt":"{{prompt}}"{{?image}},"image":"{{image}}"{{/image}},"resolution":"720p","size":"16:9","duration":5,"generate_audio":false}',
      },
      taskIdPath: "data[].task_id",
      poll: {
        url: "{{baseUrl}}/v1/videos/tasks/{{taskId}}",
        method: "GET",
        headers: { Authorization: "Bearer {{apiKey}}" },
        intervalMs: 5000,
        statusPath: "data[].status",
        doneValue: "succeeded",
        failValue: "failed",
      },
      resultPath: "data[].video_url",
    },
  },
];

/** 应用预设：覆盖修复已绑定的协议 / 新建并绑定；返回给用户看的结果说明 */
export function applyProtoPreset(preset: ProtoPreset): string {
  const st = useSettings.getState();
  const s = st.settings;
  const role = preset.proto.role === "video" ? "video" : "image";
  const protos = [...s.customProtocols];
  const providers = s.models.providers.map((p) => ({ ...p, models: { ...p.models } }));
  const done: string[] = [];
  let boundNew = false;

  for (const pv of providers) {
    if (!preset.hostMatch.test(pv.baseUrl ?? "")) continue;
    const slot = pv.models[role];
    const bound = slot?.protocol?.startsWith("custom:") ? slot.protocol.slice("custom:".length) : null;
    if (bound) {
      const idx = protos.findIndex((x) => x.id === bound);
      if (idx >= 0) {
        protos[idx] = { ...preset.proto, id: bound };
        done.push(`已原地修复「${pv.name}」绑定的协议（绑定关系不变）`);
        continue;
      }
    }
    // 该服务商还没绑自定义协议：新建一份并绑定到对应槽位
    const id = uid(6);
    protos.push({ ...preset.proto, id });
    pv.models[role] = { ...(slot ?? { models: [] }), protocol: `custom:${id}` };
    boundNew = true;
    done.push(`已为「${pv.name}」新建协议并绑定到${role === "video" ? "视频" : "图片"}槽位`);
  }

  if (!done.length) {
    // 没有匹配的服务商：只把协议加进协议库
    protos.push({ ...preset.proto, id: uid(6) });
    done.push("没有找到匹配的服务商卡片，已将协议加入协议库（可在服务商的槽位手动选用）");
  }

  st.update("customProtocols", protos);
  if (boundNew) st.update("models", { ...s.models, providers });
  return done.join("；");
}
