/** 连接问题不消耗单个素材的重试额度，断网再久也不丢队列。 */
export function eagleRetryDecision(ok:boolean,connected:boolean,attempt:number):"done"|"wait"|"retry"|"failed" {
  if(ok)return "done";
  if(!connected)return "wait";
  return attempt+1>=3?"failed":"retry";
}
export const eagleConnectionFailure=(msg:string)=>/连不上|超时|EAGLE_OFFLINE|校验失败|拒绝访问|Token 无效|HTTP (401|403|502|503)/i.test(msg);
