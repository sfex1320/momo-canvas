/**
 * 节点外壳：统一卡片、头部操作、端口、上游传入提示
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { NODE_INPUTS, useBoard } from "../../core/stores/boardStore";
import { useUi } from "../../core/stores/uiStore";
import { collectUpstream, collectUpstreamParts } from "../../core/runner";
import { IcClose, IcCopy, IcEyeOff, IcTrash } from "../../ui/icons";
import { Thumb } from "../../ui/Thumb";
import type { NodeKind, RunStatus } from "../../core/types";

/** 上游组合预览弹窗：图N 顺序 + 各段文本来源 + 合并预览 */
function UpstreamPopover({ id, onClose }: { id: string; onClose: () => void }) {
  const parts = collectUpstreamParts(id);
  const images = parts.filter((p) => p.kind === "image");
  const texts = parts.filter((p) => p.kind === "text");
  const rootRef = useRef<HTMLDivElement>(null);
  /* 点击弹窗外（画布空白/其他节点）自动收起；工具栏「弹窗锁定」开启时不收起 */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (useUi.getState().popLock) return;
      const t = e.target as Node | null;
      if (rootRef.current?.contains(t)) return;
      if ((t as HTMLElement | null)?.closest?.(".up-badge")) return; // 徽标自己负责开关
      onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);
  return (
    <div ref={rootRef} className="up-pop glass nodrag nowheel">
      <div className="up-pop-head">
        <b>上游传入组合</b>
        <span title="按上游节点位置排序（上→下），拖动节点可调整顺序">按位置上→下排序</span>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          <IcClose size={14} />
        </button>
      </div>
      <div className="up-pop-body">
        {images.length ? (
          <>
            <div className="up-sec">参考图 {images.length} 张 · 图N 即传给模型的顺序（提示词里可用 @ 引用）</div>
            {images.map((p, i) => (
              <div key={i} className="up-row">
                <Thumb src={p.value} alt="" />
                <b>图{i + 1}</b>
                <span title={p.from}>{p.from}</span>
              </div>
            ))}
          </>
        ) : null}
        {texts.length ? (
          <>
            <div className="up-sec">文本 {texts.length} 段 · 提示词框留空时按此顺序换行合并</div>
            {texts.map((p, i) => (
              <div key={i} className="up-text">
                <div className="up-text-head">
                  <b>段{i + 1}</b>
                  <span title={p.from}>{p.from}</span>
                </div>
                <div className="up-text-body">{p.value}</div>
              </div>
            ))}
            {texts.length > 1 ? (
              <>
                <div className="up-sec">合并预览（实际发给模型的完整文本）</div>
                <div className="up-text">
                  <div className="up-text-body">{texts.map((t) => t.value).join("\n")}</div>
                </div>
              </>
            ) : null}
          </>
        ) : null}
        <div className="up-sec dim">调整上游节点的上下位置即可改变顺序</div>
      </div>
    </div>
  );
}

/** 上游传入提示：几张图（圆角缩略图）/ 几段文本；点击展开组合预览 */
function UpstreamBadge({ id }: { id: string }) {
  // 弹窗开启状态放全局 store：锁定时点击画布/其他节点也不丢；「弹窗锁定」见工具栏
  const open = useUi((s) => s.upPop.includes(id));
  const toggleUpPop = useUi((s) => s.toggleUpPop);
  // 扁平指纹 + 浅比较：此前全量订阅 nodes/edges，拖动的每一帧都会让全部节点重算重渲染（画布掉帧/闪烁来源之一）
  const flat = useBoard(
    useShallow(() => {
      const u = collectUpstream(id);
      return [String(u.texts.length), ...u.texts, ...u.images];
    }),
  );
  const nTexts = Number(flat[0]);
  const texts = flat.slice(1, 1 + nTexts);
  const images = flat.slice(1 + nTexts);
  if (!texts.length && !images.length) return null;
  return (
    <>
      <div
        className={`up-badge nodrag ${open ? "open" : ""}`}
        role="button"
        title="上游已传入的内容（点击查看组合方式与顺序）"
        onClick={() => toggleUpPop(id)}
      >
        {images.slice(0, 4).map((s, i) => (
          <Thumb key={i} src={s} alt="" />
        ))}
        {images.length > 4 ? <span className="ub-more">+{images.length - 4}</span> : null}
        {images.length ? <span className="ub-txt">{images.length} 张图传入</span> : null}
        {texts.length ? <span className="ub-txt">{texts.length} 段文本传入</span> : null}
      </div>
      {open ? <UpstreamPopover id={id} onClose={() => useUi.getState().closeUpPop(id)} /> : null}
    </>
  );
}

export function NodeShell({
  id,
  title,
  icon,
  status,
  error,
  selected,
  width,
  headExtra,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  status: RunStatus;
  error?: string;
  selected?: boolean;
  width: number;
  headExtra?: ReactNode;
  children: ReactNode;
}) {
  const duplicateNode = useBoard((s) => s.duplicateNode);
  const removeNode = useBoard((s) => s.removeNode);
  const updateData = useBoard((s) => s.updateData);
  const ignored = useBoard(
    (s) => !!((s.nodes.find((n) => n.id === id)?.data as Record<string, unknown> | undefined)?.ignored),
  );
  const kind = useBoard((s) => s.nodes.find((n) => n.id === id)?.type as NodeKind | undefined);
  const hinted = useUi((s) => (s.proxHint ? s.proxHint.includes(id) : false));
  const ghost = useUi((s) => (s.dupGhost ? s.dupGhost.includes(id) : false));
  const hasInputs = kind ? Object.keys(NODE_INPUTS[kind] ?? {}).length > 0 : false;
  return (
    <div
      className={`mnode ${status} ${selected ? "sel" : ""} ${hinted ? "prox" : ""} ${ignored ? "ign" : ""} ${ghost ? "ghost" : ""}`}
      style={{ width }}
    >
      <div className="mnode-head">
        <span className="kind-ic">{icon}</span>
        <span className="title">{title}</span>
        {headExtra}
        <span className="acts nodrag">
          <button
            className={`icon-btn ${ignored ? "on-warn" : ""}`}
            title={ignored ? "恢复此节点（重新向下游传递）" : "忽略此节点（半透明，不向下游传递）"}
            onClick={() => updateData(id, { ignored: !ignored })}
          >
            <IcEyeOff size={16} />
          </button>
          <button className="icon-btn" title="创建副本 (Ctrl+D)" onClick={() => duplicateNode(id)}>
            <IcCopy size={17} />
          </button>
          <button className="icon-btn danger" title="删除 (Del)" onClick={() => removeNode(id)}>
            <IcTrash size={17} />
          </button>
        </span>
      </div>
      {hasInputs ? <UpstreamBadge id={id} /> : null}
      {children}
      {status === "error" && error ? <div className="mnode-err nodrag nowheel">{error}</div> : null}
    </div>
  );
}

/** 输出模式切换（打光/多角度/角色卡头部用）：出图 ↔ 提示词；切换会改变输出端口类型，需断开旧下游连线 */
export function OutModeToggle({ id, mode }: { id: string; mode: "image" | "prompt" }) {
  const updateData = useBoard((s) => s.updateData);
  const set = (m: "image" | "prompt") => {
    if (m === mode) return;
    const s = useBoard.getState();
    const doomed = s.edges.filter((e) => e.source === id);
    if (doomed.length) s.onEdgesChange(doomed.map((e) => ({ type: "remove" as const, id: e.id })));
    updateData(id, { outMode: m });
  };
  return (
    <span
      className="lang-seg outmode nodrag"
      title="输出模式：出图 = 调用绘画模型生成并输出图片；提示词 = 不出图，向下游输出构造好的提示词文本（可接生成图像等节点组合使用）"
    >
      <button className={mode === "image" ? "on" : ""} onClick={() => set("image")}>
        出图
      </button>
      <button className={mode === "prompt" ? "on" : ""} onClick={() => set("prompt")}>
        提示词
      </button>
    </span>
  );
}

/** 文本输入端口（左上，紫色）；data-lab 会在悬停节点时显示为小标签 */
export const PortTextIn = () => (
  <Handle type="target" position={Position.Left} id="in-text" data-lab="文本入" title="文本输入 · 接提示词/对话等" className="port port-text" style={{ top: 26 }} />
);

/** 图片输入端口（左下一格，蓝色） */
export const PortImageIn = ({ top = 58 }: { top?: number }) => (
  <Handle type="target" position={Position.Left} id="in-image" data-lab="图片入" title="图片输入 · 接图片/生成图像等" className="port port-image" style={{ top }} />
);

/** 视频输入端口（绿色） */
export const PortVideoIn = ({ top = 58 }: { top?: number }) => (
  <Handle type="target" position={Position.Left} id="in-video" data-lab="视频入" title="视频输入 · 接生成视频/取段/拼接等" className="port port-video" style={{ top }} />
);

const OUT_LAB: Record<string, string> = { text: "文本出", image: "图片出", video: "视频出" };

/** 输出端口（默认右中；传 top 可固定到指定高度，如角色卡放头部） */
export const PortOut = ({ kind, top }: { kind: "text" | "image" | "video"; top?: number }) => (
  <Handle type="source" position={Position.Right} id="out" data-lab={OUT_LAB[kind]} title={OUT_LAB[kind].replace("出", "输出")} className={`port port-${kind}`} style={top !== undefined ? { top } : undefined} />
);
