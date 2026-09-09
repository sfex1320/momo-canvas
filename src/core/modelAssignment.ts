import type { ModelRole } from "./types";
/** 只拦官方明确区分的 Seed 理解模型，未知中转别名保持兼容。 */
export function modelAssignmentIssue(role:ModelRole,model:string):string|undefined {
  if(role==="video"&&/^doubao-seed-\d/i.test(model.trim()))return `「${model}」是对话/视觉理解模型，不能生成视频。请在视频用途选择 Seedance 等视频模型，Seed 模型放入对话用途。`;
}
