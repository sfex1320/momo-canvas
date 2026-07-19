import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut, PortTextIn } from "../NodeShell";
import { IcDice, IcDownload, IcFlow, IcGear, IcLoading, IcPlay } from "../../../ui/icons";
import { Switch } from "../../../ui/kit";
import { useBoard } from "../../../core/stores/boardStore";
import { useComfy } from "../../../core/stores/comfyStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { runFlow } from "../../../core/runner";
import { saveImageAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import { Thumb } from "../../../ui/Thumb";
import type { ComfyData, ComfyExposedParam } from "../../../core/types";

export const ComfyNode = memo(function ComfyNode({ id, data, selected }: NodeProps) {
  const d = data as ComfyData;
  const upd = useBoard((s) => s.updateData);
  const templates = useComfy((s) => s.templates);
  const setTemplateMgr = useUi((s) => s.setTemplateMgr);
  const setLightbox = useUi((s) => s.setLightbox);
  const running = d.status === "running";
  const tpl = templates.find((t) => t.id === d.templateId);
  const main = d.results?.[d.picked ?? 0];

  const setParam = (key: string, v: string | number) => upd(id, { params: { ...d.params, [key]: v } });

  const save = async () => {
    if (!main) return;
    try {
      const p = await saveImageAs(main, useSettings.getState().settings.save, { model: tpl?.name });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="ComfyUI 工作流"
      icon={<IcFlow size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={330}
      headExtra={
        main ? (
          <span className="acts nodrag" style={{ opacity: 1 }}>
            <button className="icon-btn" title="保存到本地" onClick={save}>
              <IcDownload size={17} />
            </button>
          </span>
        ) : undefined
      }
    >
      <div className="mnode-body">
        <div style={{ display: "flex", gap: 7 }}>
          <select
            className="select nodrag"
            style={{ flex: 1, minHeight: 36 }}
            value={d.templateId ?? ""}
            onChange={(e) => upd(id, { templateId: e.target.value || undefined, params: {} })}
          >
            <option value="">选择工作流模板…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button className="icon-btn nodrag" title="管理模板（导入 / 编辑参数）" onClick={() => setTemplateMgr(true)}>
            <IcGear size={18} />
          </button>
        </div>

        {tpl ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {tpl.params.map((p) => (
              <ParamField key={p.key} p={p} value={d.params?.[p.key]} onChange={(v) => setParam(p.key, v as never)} />
            ))}
          </div>
        ) : (
          <div className="hint" style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.6 }}>
            还没有模板？点右上齿轮导入 ComfyUI 工作流（API 格式 JSON），并勾选要暴露的参数。
          </div>
        )}

        <button className="btn primary nodrag" disabled={running || !tpl} onClick={() => void runFlow(id)}>
          {running ? <IcLoading size={17} /> : <IcPlay size={16} />}
          {running ? "执行中…" : "运行工作流"}
        </button>
        {running && d.progress ? (
          <div className="progress-line">
            <IcLoading size={14} />
            {d.progress}
            {d.progressPct !== undefined ? <b className="pl-pct">{d.progressPct}%</b> : null}
          </div>
        ) : null}
        {running && d.progressPct !== undefined ? (
          <div className="progress-bar" title={`${d.progressPct}%`}>
            <i style={{ width: `${d.progressPct}%` }} />
          </div>
        ) : null}
        {main && !running ? (
          <>
            <Thumb className="img-main nodrag" src={main} alt="" res onClick={() => setLightbox(main)} />
            {d.results.length > 1 ? (
              <div className="thumbs nodrag">
                {d.results.map((s, i) => (
                  <Thumb
                    key={i}
                    src={s}
                    className={i === (d.picked ?? 0) ? "on" : ""}
                    onClick={() => upd(id, { picked: i })}
                    alt=""
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        {d.textOut && !running ? (
          <div className="comfy-textout nodrag">
            <pre>{d.textOut}</pre>
            <button
              className="btn sm"
              onClick={() => void navigator.clipboard.writeText(d.textOut!).then(() => toast("已复制文本 ✓", "ok"))}
            >
              复制文本输出
            </button>
          </div>
        ) : null}
      </div>
      <PortTextIn />
      <PortImageIn />
      <PortOut kind="image" />
    </NodeShell>
  );
});

function ParamField({
  p,
  value,
  onChange,
}: {
  p: ComfyExposedParam;
  value: string | number | undefined;
  onChange: (v: string | number | boolean) => void;
}) {
  const v = value !== undefined ? value : (p.value as string | number);
  const label = (
    <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)" }}>{p.label}</label>
  );
  switch (p.kind) {
    case "text":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {label}
          <textarea
            className="textarea nodrag nowheel"
            rows={2}
            value={String(v ?? "")}
            placeholder="留空则使用上游文本"
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    case "seed":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {label}
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="input nodrag"
              type="number"
              style={{ minHeight: 34 }}
              value={Number(v ?? 0)}
              onChange={(e) => onChange(Number(e.target.value))}
            />
            <button
              className="icon-btn nodrag"
              title="随机种子"
              onClick={() => onChange(Math.floor(Math.random() * 2 ** 31))}
            >
              <IcDice size={18} />
            </button>
          </div>
        </div>
      );
    case "number":
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }}>{label}</span>
          <input
            className="input nodrag"
            type="number"
            style={{ width: 110, minHeight: 34 }}
            value={Number(v ?? 0)}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </div>
      );
    case "toggle":
      return (
        <div className="nodrag" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }}>{label}</span>
          <Switch on={Boolean(v)} onChange={(b) => onChange(b)} />
        </div>
      );
    case "image":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {label}
          <input
            className="input nodrag"
            style={{ minHeight: 34 }}
            value={String(v ?? "")}
            placeholder="留空则使用上游图片（自动上传）"
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
  }
}
