/**
 * 内置中转站协议预设 —— 唯一协议来源（3.6 起：自定义协议编辑/校准/自愈功能已移除，
 * 协议只从这里来，按服务商 baseUrl 自动绑定；站点接口有变化时改这里即可）。
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

export type ProtoPreset = {
  key: string;
  label: string;
  /** 匹配服务商 baseUrl 的正则（自动定位要绑定的卡片） */
  hostMatch: RegExp;
  note: string;
  proto: Omit<CustomProtocol, "id">;
};

const AUTH_HEADERS = { Authorization: "Bearer {{apiKey}}", "Content-Type": "application/json" };

export const PROTO_PRESETS: ProtoPreset[] = [
  {
    key: "65535-image",
    label: "65535 生图",
    hostMatch: /65535\.space/i,
    note: "有参考图自动切 /v1/images/edits；蒙版按官方 {\"image_url\":…} 对象格式；异步轮询 job 状态",
    proto: {
      name: "65535 生图",
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
    label: "APIMart 生图",
    hostMatch: /apimart\.ai|aishuch\.com/i,
    note: "逆向通道 image_urls 接受 base64 参考图；该通道不支持真蒙版（重绘节点请用「指令式」）",
    proto: {
      name: "APIMart 生图",
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
    label: "APIMart 生视频",
    hostMatch: /apimart\.ai|aishuch\.com/i,
    note: "image 字段按有无上游图条件出现（纯文生视频不再发空 image）",
    proto: {
      name: "APIMart 生视频",
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

/** 预设协议的确定性 id（重复绑定时复用同一条，不产生重复协议） */
export const presetProtoId = (key: string) => `preset-${key}`;
