import { compactError } from "../../core/errorText";
/**
 * 节点外壳：统一卡片、端口、上游传入提示。
 * 节点本体保持干净：头部只有「图标 + 名称」；所有操作按钮（含各节点 headExtra 注入的动作）
 * 收进悬停/选中时从顶部弹出的悬浮工具条（图标 + 文字，玻璃胶囊）；
 * 输出为图片/视频的节点，工具条里还有「编辑」（NodeEditMenu）：直接作用于本节点图片
 * （框选裁剪/蒙版重绘/扩图/尺寸/增强），会话期间工具条整体切换为对应的编辑工具条。
 * media 变体：图片/视频节点无边框，预览充满整个节点。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Handle, Position, useReactFlow } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { NODE_INPUTS, useBoard } from "../../core/stores/boardStore";
import { useUi } from "../../core/stores/uiStore";
import { collectUpstream, collectUpstreamParts, isNodeDirty } from "../../core/runner";
import { NodeEditMenu } from "./NodeEditMenu";
import { IcClose, IcCopy, IcEyeOff, IcLink, IcStop, IcTrash } from "../../ui/icons";
import { abortNode, useRunTasks } from "../../core/runControl";
import { Thumb } from "../../ui/Thumb";
import type { NodeKind, RunStatus } from "../../core/types";

/** 上游脏标记角标：上游内容已变更（改了提示词/换了参考图/重排了组成员）时显示「待更新」，
 *  提示用户运行本节点会重新计算。订阅整个 board：任何上游编辑都会让 isNodeDirty 重算 */
function DirtyBadge({ id }: { id: string }) {
  const dirty = useBoard(() => isNodeDirty(id));
  if (!dirty) return null;
  return (
    <div className="dirty-badge" title="上游内容已变更，运行本节点将重新计算上游部分">
      ⟳ 待更新
    </div>
  );
}

/** 上游组合预览弹窗：图N 顺序 + 各段文本来源 + 合并预览（从工具条「传入」按钮向下弹出）；
 *  点击任一行选中并飞到来源节点——「传入 N 却找不到谁传的」时一眼定位 */
function UpstreamPopover({ id, onClose }: { id: string; onClose: () => void }) {
  const parts = collectUpstreamParts(id);
  const images = parts.filter((p) => p.kind === "image");
  const texts = parts.filter((p) => p.kind === "text");
  const rootRef = useRef<HTMLDivElement>(null);
  const rf = useReactFlow();
  const locate = (nid: string) => {
    const s = useBoard.getState();
    s.onNodesChange(s.nodes.map((n) => ({ type: "select" as const, id: n.id, selected: n.id === nid })));
    void rf.fitView({ nodes: [{ id: nid }], duration: 360, maxZoom: 1.3, padding: 3 });
  };
  /* 点击弹窗外（画布空白/其他节点）自动收起；工具栏「弹窗锁定」开启时不收起 */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (useUi.getState().popLock) return;
      const t = e.target as Node | null;
      if (rootRef.current?.contains(t)) return;
      if ((t as HTMLElement | null)?.closest?.(".up-tool")) return; // 按钮自己负责开关
      onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);
  return (
    <div ref={rootRef} className="up-pop glass nodrag nowheel">
      <div className="up-pop-head">
        <b>上游传入组合</b>
        <span title="按上游节点位置排序（上→下），拖动节点可调整顺序">按位置上→下排序 · 点击行定位来源</span>
        <button className="icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
          <IcClose size={14} />
        </button>
      </div>
      <div className="up-pop-body">
        {images.length ? (
          <>
            <div className="up-sec">参考图 {images.length} 张 · 图N 即传给模型的顺序（提示词里可用 @ 引用）</div>
            {images.map((p, i) => (
              <div key={i} className="up-row" role="button" tabIndex={0} title={`选中并定位：${p.from}`} onClick={() => locate(p.nodeId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    locate(p.nodeId);
                  }
                }}
              >
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
              <div key={i} className="up-text" role="button" tabIndex={0} title={`选中并定位：${p.from}`} onClick={() => locate(p.nodeId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    locate(p.nodeId);
                  }
                }}
              >
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

/** 上游传入按钮（悬浮工具条内）：几段文本/几张图，点击向下弹出组合预览 */
function UpstreamTool({ id }: { id: string }) {
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
    <span className="up-tool">
      <button
        className={`nt-btn nodrag ${open ? "on" : ""}`}
        title={`上游已传入：${texts.length} 段文本 · ${images.length} 张图（点击查看组合方式与顺序）`}
        onClick={() => toggleUpPop(id)}
      >
        <IcLink size={14} />
        传入 {texts.length + images.length}
      </button>
      {open ? <UpstreamPopover id={id} onClose={() => useUi.getState().closeUpPop(id)} /> : null}
    </span>
  );
}

/**
 * 媒体节点宽度：随内容比例自适应（实现移至 core/imageInfo 供画布布局计算同源复用，此处保留导出）
 */
export { mediaNodeWidth } from "../../core/imageInfo";

export function NodeShell({  id,
  title,
  icon,
  status,
  error,
  selected,
  width,
  headExtra,
  hideUpstream,
  hideHead,
  media,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  status: RunStatus;
  error?: string;
  selected?: boolean;
  width: number;
  /** 节点专属动作（保存/替换/生成…）：渲染进顶部悬浮工具条，建议用 .nt-btn（图标+文字） */
  headExtra?: ReactNode;
  /** 隐藏节点上的"上游传入"徽标（生成节点改由生成设置弹窗显示上游） */
  hideUpstream?: boolean;
  /** 隐藏顶部标题行（分镜组切片等纯图外观；工具条仍随悬停出现） */
  hideHead?: boolean;
  /** 无边框媒体模式：图片/视频节点预览充满整个节点，无卡片底色 */
  media?: boolean;
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
  const hasInputs = kind ? Object.keys(NODE_INPUTS[kind] ?? {}).length > 0 : false;
  // 直接编辑会话（框选裁剪/蒙版涂抹）命中本节点：工具条整体切换为编辑工具条并常显
  const editing = useUi((s) => s.mediaEdit?.nodeId === id);
  // 「上游传入」弹窗开着时工具条常显：弹窗挂在工具条内，鼠标一移开工具条就淡出，
  // 会把弹窗一起带走，工具栏的「弹窗锁定」等于失效
  const upPopOpen = useUi((s) => s.upPop.includes(id));
  return (
    <div
      className={`mnode ${media ? "media" : ""} ${hideHead ? "no-head" : ""} ${status} ${selected ? "sel" : ""} ${hinted ? "prox" : ""} ${ignored ? "ign" : ""} ${editing ? "editing" : ""} ${upPopOpen ? "uppop" : ""}`}
      style={{ width }}
    >
      <div className="mnode-head">
        <span className="kind-ic">{icon}</span>
        <span className="title">{title}</span>
      </div>
      {/* 脏标记角标必须作 .mnode 直接子元素：.mnode-head 悬停/选中时整体 opacity:0，放里面会跟着消失 */}
      <DirtyBadge id={id} />
      <div className="mnode-toolbar nodrag nowheel">
        {editing ? (
          <NodeEditMenu id={id} />
        ) : (
          <>
            {status === "running" ? <StopTool id={id} /> : null}
            {hasInputs && !hideUpstream ? <UpstreamTool id={id} /> : null}
            {headExtra}
            <NodeEditMenu id={id} />
            <span className="nt-sep" />
            <button
              className={`icon-btn ${ignored ? "on-warn" : ""}`}
              title={ignored ? "恢复此节点（重新向下游传递）" : "忽略此节点（半透明，不向下游传递）"}
              aria-label={ignored ? "恢复此节点（重新向下游传递）" : "忽略此节点（半透明，不向下游传递）"}
              onClick={() => updateData(id, { ignored: !ignored })}
            >
              <IcEyeOff size={15} />
            </button>
            <button className="icon-btn" title="创建副本 (Ctrl+D)" aria-label="创建副本 (Ctrl+D)" onClick={() => duplicateNode(id)}>
              <IcCopy size={16} />
            </button>
            <button className="icon-btn danger" title="删除 (Del)" aria-label="删除 (Del)" onClick={() => removeNode(id)}>
              <IcTrash size={16} />
            </button>
          </>
        )}
      </div>
      {children}
      {status === "error" && error ? <div className="mnode-err nodrag nowheel">{compactError(error)}</div> : null}
    </div>
  );
}

/** 运行中的停止按钮：走 runControl 的中止通道（请求与轮询随之中断，节点回到待机） */
function StopTool({ id }: { id: string }) {
  // 订阅任务表：任务结束（endTask）后按钮即时消失，不用等节点状态刷新
  const registered = useRunTasks((s) => !!s.tasks[id]);
  if (!registered) return null;
  return (
    <button
      className="nt-btn danger"
      title="停止生成（已提交到服务商的任务无法追回，可能仍会计费）"
      onClick={() => abortNode(id)}
    >
      <IcStop size={14} /> 停止
    </button>
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

/**
 * 统一端口（端口不分类型）：输入左中、输出右中，均垂直居中，任意输出可接任意输入。
 * 圆点统一单色（canvas.css 里 .port 设 --pc: var(--accent)）；隐藏→悬停弹出→拖线吸附光晕动效不变。
 */
export const PortIn = (_props?: { top?: number }) => (
  <Handle type="target" position={Position.Left} id="in" data-lab="输入" title="输入 · 接任意上游节点" className="port" />
);
export const PortOut = (_props?: { kind?: "text" | "image" | "video" | "audio"; top?: number }) => (
  <Handle type="source" position={Position.Right} id="out" data-lab="输出" title="输出 · 接任意下游节点" className="port" />
);
/* 旧名保留为 PortIn 别名，便于单口节点零改动；多口节点务必改用单个 <PortIn/>（同节点多个 id="in" 会冲突） */
export const PortTextIn = PortIn;
export const PortImageIn = PortIn;
export const PortVideoIn = PortIn;
export const PortAudioIn = PortIn;
