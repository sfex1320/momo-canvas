/**
 * 任务中心（导演台 3.0 · 方案 §9.4）
 * 顶栏 JobStrip 显示运行中任务概览；点开浮层看全部记录（生成/提取/渲染/分析/制图/音频）。
 * 单段失败不阻断其他片段；远程任务取消按钮注明「已提交部分无法撤销计费」。
 */
import { useEffect, useState } from "react";
import { JOB_STATUS_LABEL, activeJobs, useJobCenter } from "../../../core/studio/jobCenter";
import { IcActivity, IcClose, IcLoading, IcCheck, IcWarn } from "../../../ui/icons";

export function JobStrip() {
  const jobs = useJobCenter((s) => s.jobs);
  const setPanelOpen = useJobCenter((s) => s.setPanelOpen);
  const panelOpen = useJobCenter((s) => s.panelOpen);
  const running = activeJobs(jobs);
  const failed = jobs.filter((j) => j.status === "failed").length;
  if (!running.length && !failed && !panelOpen) return null;
  const top = running[0];
  return (
    <button className="st-jobstrip" title="任务中心：生成 / 提取 / 渲染 / 分析全部可观察" onClick={() => setPanelOpen(!panelOpen)}>
      <IcActivity size={13} />
      {top ? (
        <span style={{ minWidth: 0 }}>
          {top.label}
          {running.length > 1 ? ` 等 ${running.length} 项` : ""}
          {top.pct !== undefined ? ` ${Math.round(top.pct)}%` : ""}
        </span>
      ) : (
        <span>{failed ? `${failed} 个任务失败` : "无进行中任务"}</span>
      )}
    </button>
  );
}

export function JobCenterPanel() {
  const [retry,setRetry]=useState<string|null>(null);
  const [retrying,setRetrying]=useState<string|null>(null);
  const jobs = useJobCenter((s) => s.jobs);
  const open = useJobCenter((s) => s.panelOpen);
  const setOpen = useJobCenter((s) => s.setPanelOpen);
  const sweep = useJobCenter((s) => s.sweep);
  useEffect(() => {
    if (open) sweep();
  }, [open, sweep]);
  if (!open) return null;
  return (
    <div className="st-jobs" role="dialog" aria-label="任务中心">
      <div className="st-panel-h">
        任务中心
        <span className="st-hint">{jobs.length} 条记录</span>
        <button className="st-iconbtn" style={{ marginLeft: "auto" }} title="关闭" onClick={() => setOpen(false)}>
          <IcClose size={14} />
        </button>
      </div>
      <div className="st-panel-b">
        {jobs.length === 0 ? <div className="st-empty"><b>暂无任务</b>生成、微参考提取、渲染与音乐分析都会出现在这里。</div> : null}
        {jobs.map((j) => (
          <div className="st-job" key={j.id}>
            {j.status === "running" || j.status === "queued" || j.status === "prechecking" ? (
              <IcLoading size={14} />
            ) : j.status === "done" ? (
              <IcCheck size={14} style={{ color: "var(--ok)" }} />
            ) : j.status === "failed" || j.status === "blocked" ? (
              <IcWarn size={14} style={{ color: "var(--danger)" }} />
            ) : (
              <IcActivity size={14} style={{ opacity: 0.5 }} />
            )}
            <span className="lbl" title={`${j.label} · ${j.stage ?? ""}${j.error ? ` · ${j.error}` : ""}`}>
              {j.label}
              {j.stage ? <span className="st-hint"> · {j.stage}</span> : null}
            </span>
            {j.status === "running" || j.status === "queued" ? (
              <span className={`bar${j.pct === undefined ? " indet" : ""}`} style={{ flex: 1 }}>
                {j.pct !== undefined ? <i style={{ width: `${j.pct}%` }} /> : <i />}
              </span>
            ) : (
              <span className="st-hint" style={{ flex: 1, textAlign: "right" }}>
                {JOB_STATUS_LABEL[j.status]}
                {j.error ? ` · ${j.error.slice(0, 30)}` : ""}
              </span>
            )}
            {j.retryRun && (j.status==="failed"||j.status==="cancelled") && <span>{retry===j.id?<><small>{j.retryNote}</small><button className="st-btn sm" disabled={!!retrying} onClick={()=>{setRetrying(j.id);setRetry(null);void j.retryRun!().catch(e=>useJobCenter.getState().patch(j.id,{error:String(e)})).finally(()=>setRetrying(null));}}>确认续跑</button><button className="st-btn sm" onClick={()=>setRetry(null)}>取消</button></>:<button className="st-btn sm" disabled={!!retrying} onClick={()=>setRetry(j.id)}>续跑未完成项</button>}</span>}
            {j.cancelRun && (j.status === "running" || j.status === "queued" || j.status === "prechecking") ? (
              <button
                className="st-iconbtn"
                title={j.cancellable === false ? "远程已提交部分无法撤销计费——点击停止后续提交" : "请求停止（批量等待当前段结束；制图和录制立即停止等待）"}
                onClick={() => {
                  j.cancelRun?.();
                  useJobCenter.getState().patch(j.id, { status: "cancelled", finishedAt: Date.now(), stage: "已取消" });
                }}
              >
                <IcClose size={13} />
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
