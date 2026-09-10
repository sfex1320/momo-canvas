import { prepareNodeDrag } from "../../core/nodeDrag";
/**
 * 智能画布 — 单一画布范式：
 *  移动工具（V，默认）：左键拖空白平移 · 点击选择 · 长按节点拖动
 *  框选模式：左键框选（Ctrl+框选可选中连线批量删）· 中键或空格平移
 *  滚轮缩放 · 右键空白/节点弹快捷菜单 · 双击空白添加节点 · 拖线到空白快速建节点 · 拖入图片/文本 · Ctrl+V 粘贴
 *  拖节点时鼠标悬到目标节点上自动连线（左半=作上游，右半=作下游，虚线框预告）· G 建组 · I 忽略 · Ctrl+Z/Y 撤销重做
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  SelectionMode,
  useReactFlow,
  useStore,
  ViewportPortal,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type NodeTypes,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas.css";

import { useBoard, outPortType, findProximityPair, wouldCycle, NODE_INPUTS } from "../../core/stores/boardStore";
import { useTemplates } from "../../core/stores/templateStore";
import { getNativeDragAsset } from "../assets/dragState";
import { toast, useUi } from "../../core/stores/uiStore";
import { useSettings } from "../../core/stores/settingsStore";
import { useAssets } from "../../core/stores/assetStore";
import { assetToDataUrl, assetUrl } from "../../core/services/assetFiles";
import { videoDuration } from "../../core/videoEdit";
import { AudioConfigPanel, CharConfigPanel, EcomConfigPanel, GenConfigPanel, VideoConfigPanel } from "./GenConfigPanel";
import { ComfyConfigPanel } from "./ComfyConfigPanel";
import { EnhanceConfigPanel, VectorizeConfigPanel } from "./EditPanels";
import { isVoiceCallActive, startVoiceCall, stopVoiceCall } from "../../core/voiceChat";
import type { AppNode, BoardTemplate, GroupData, NodeKind } from "../../core/types";
import { errMsg, fileToDataUrl, matchHotkey } from "../../core/utils";
import { NODE_CATALOG } from "./nodeCatalog";
import { FlowEdge } from "./FlowEdge";
import { AddNodeMenu } from "./AddNodeMenu";
import { CanvasSearch, Spotlight } from "./CanvasPalette";
import { AiWirePanel } from "./AiWirePanel";
import { SysMonitor } from "./SysMonitor";
import { RUNNABLE_KINDS, runAllFlows, runFlow, runTailSequence } from "../../core/runner";
import { nodeMainImage } from "../../core/nodeEdit";
import { layerGroupForExport } from "../../core/elementSplit";
import { exportLayeredPsd, exportLayeredTiff } from "../../core/layering";
import { elementComposePrompt } from "../../core/editPrompts";
import { abortAll, abortNode, useRunTasks } from "../../core/runControl";
import { ContextMenu, type CmItem } from "./ContextMenu";
import { IcBulb, IcClapper, IcCopy, IcCursor, IcEcom, IcEyeOff, IcFit, IcGrid, IcGroup, IcLayers, IcLock, IcLogo, IcOrbit, IcPlay, IcPlus, IcMin, IcTrash, IcUndo, IcRedo, IcUpscale, IcVector, IcWand } from "../../ui/icons";
import { ErrorBoundary } from "../../ui/ErrorBoundary";

import { ImageNode } from "./nodes/ImageNode";
import { PromptNode } from "./nodes/PromptNode";
import { ChatNode } from "./nodes/ChatNode";
import { ImageGenNode } from "./nodes/ImageGenNode";
import { VideoGenNode } from "./nodes/VideoGenNode";
import { ComfyNode } from "./nodes/ComfyNode";
import { LlmTextNode } from "./nodes/LlmTextNode";
import { CombineNode } from "./nodes/CombineNode";
import { StylePresetNode } from "./nodes/StylePresetNode";
import { NoteNode } from "./nodes/NoteNode";
import { GroupNode } from "./nodes/GroupNode";
import { RelightNode } from "./nodes/RelightNode";
import { MultiAngleNode } from "./nodes/MultiAngleNode";
import { CharCardNode } from "./nodes/CharCardNode";
import { StoryboardNode } from "./nodes/StoryboardNode";
import { VideoNode, importVideoFile } from "./nodes/VideoNode";
import { AudioNode, importAudioFile } from "./nodes/AudioNode";
import { AudioGenNode } from "./nodes/AudioGenNode";
import { VideoDubNode } from "./nodes/VideoDubNode";
import { EnhanceLocalNode } from "./nodes/EnhanceLocalNode";
import { VectorizeNode } from "./nodes/VectorizeNode";
import { EcomImageNode } from "./nodes/EcomImageNode";
import { DirectorNode } from "./nodes/DirectorNode";

/** 一键清空画布：首次点击进入确认态（2.5 秒内再点执行），入撤销历史可 Ctrl+Z 恢复 */
function ClearAllBtn() {
  const [arm, setArm] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <button
      className={`tb-btn ${arm ? "arm-danger" : ""}`}
      title={arm ? "再点一次确认清空整个画布（Ctrl+Z 可撤销）" : "一键清空画布：移除全部节点与连线（需点两次确认，可撤销）"}
      onClick={() => {
        if (!arm) {
          setArm(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setArm(false), 2500);
          return;
        }
        if (timer.current) clearTimeout(timer.current);
        setArm(false);
        useBoard.getState().clearAll();
        toast("画布已清空（Ctrl+Z 可整体恢复）", "ok");
      }}
    >
      <IcTrash size={18} />
    </button>
  );
}

const nodeTypes: NodeTypes = {
  image: ImageNode,
  video: VideoNode,
  audio: AudioNode,
  audioGen: AudioGenNode,
  videoDub: VideoDubNode,
  prompt: PromptNode,
  chat: ChatNode,
  imageGen: ImageGenNode,
  videoGen: VideoGenNode,
  comfy: ComfyNode,
  llmText: LlmTextNode,
  combine: CombineNode,
  stylePreset: StylePresetNode,
  note: NoteNode,
  group: GroupNode,
  relight: RelightNode,
  multiAngle: MultiAngleNode,
  charCard: CharCardNode,
  storyboard: StoryboardNode,
  enhanceLocal: EnhanceLocalNode,
  vectorize: VectorizeNode,
  ecomImage: EcomImageNode,
  director: DirectorNode,
};

/** 统一走自定义边：端点内伸贴框 + 悬停剪刀 + 选中脉冲 */
const edgeTypes = { momo: FlowEdge };

/** 应用内部发起了拖拽（dragstart 于本窗口内）：onDrop 时据此跳过"文字落地建节点" */
let internalTextDrag = false;

/** Ctrl + 框选结束后，把与选框相交的连线也选中（便于批量删除连线） */
function EdgeBoxSelect() {
  const rect = useStore((s) => s.userSelectionRect);
  const domNode = useStore((s) => s.domNode);
  const { screenToFlowPosition } = useReactFlow();
  const lastRect = useRef(rect);
  const ctrlHeld = useRef(false);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.key === "Control") ctrlHeld.current = true;
    };
    const ku = (e: KeyboardEvent) => {
      if (e.key === "Control") ctrlHeld.current = false;
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", () => (ctrlHeld.current = false));
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  useEffect(() => {
    const prev = lastRect.current;
    lastRect.current = rect;
    if (!prev || rect || !ctrlHeld.current) return; // 选框刚结束且按着 Ctrl
    if (prev.width < 4 || prev.height < 4) return;
    const b = domNode?.getBoundingClientRect();
    if (!b) return;
    const p1 = screenToFlowPosition({ x: b.left + prev.x, y: b.top + prev.y });
    const p2 = screenToFlowPosition({ x: b.left + prev.x + prev.width, y: b.top + prev.y + prev.height });
    useBoard.getState().selectEdgesInRect({
      x: Math.min(p1.x, p2.x),
      y: Math.min(p1.y, p2.y),
      w: Math.abs(p2.x - p1.x),
      h: Math.abs(p2.y - p1.y),
    });
  }, [rect, domNode, screenToFlowPosition]);
  return null;
}

/** 拖动吸附对齐的参考线（flow 坐标系内画，横/竖贯穿视口） */
function AlignGuides() {
  const g = useUi((s) => s.alignGuides);
  if (!g) return null;
  const SPAN = 100000;
  return (
    <ViewportPortal>
      {g.x !== null ? (
        <div className="align-guide v" style={{ transform: `translate(${g.x}px, ${-SPAN / 2}px)`, height: SPAN }} />
      ) : null}
      {g.y !== null ? (
        <div className="align-guide h" style={{ transform: `translate(${-SPAN / 2}px, ${g.y}px)`, width: SPAN }} />
      ) : null}
    </ViewportPortal>
  );
}

/** 拖线松手命中节点时的强吸附连接（端口统一后：单口只要"能出→能入"即可连，查重、防环），不必对准端口点 */
function snapConnection(
  from: AppNode,
  fromHandle: { id?: string | null; type?: string | null },
  hit: AppNode,
  nodes: AppNode[],
  edges: Edge[],
): Connection | null {
  const canOut = (n: AppNode): boolean =>
    n.type === "group"
      ? nodes.some((m) => m.parentId === n.id)
      : !!outPortType(n.type as NodeKind, n.data as Record<string, unknown>);
  const canIn = (n: AppNode): boolean => {
    if (n.type === "group" || n.type === "note") return false; // 组/备注不能作下游
    const ins = NODE_INPUTS[n.type as NodeKind];
    return !!ins && Object.keys(ins).length > 0;
  };
  if (fromHandle.type === "source") {
    // 从 from 输出口拖 → from 作上游、hit 作下游
    if (!canOut(from) || !canIn(hit)) return null;
    if (edges.some((e) => e.source === from.id && e.target === hit.id)) return null;
    if (wouldCycle(edges, from.id, hit.id)) return null;
    return { source: from.id, target: hit.id, sourceHandle: fromHandle.id ?? "out", targetHandle: "in" };
  }
  // 从 from 输入口反向拖 → hit 作上游、from 作下游
  if (!canOut(hit) || !canIn(from)) return null;
  if (edges.some((e) => e.source === hit.id && e.target === from.id)) return null;
  if (wouldCycle(edges, hit.id, from.id)) return null;
  return { source: hit.id, target: from.id, sourceHandle: "out", targetHandle: "in" };
}

/** 可运行节点类型集合（模块级常量，来自 runner 的 RUNNABLE_KINDS 单一来源） */
const RUNNABLE_KINDS_SET = new Set(RUNNABLE_KINDS);

/** 图层组导出：成员按 y 序（=层序）读取 → 本地合成预览 → 分层 PSD / 多页 TIFF */
async function exportLayerGroupAs(groupId: string, format: "psd" | "tiff") {
  try {
    const data = await layerGroupForExport(groupId);
    if (!data || data.layers.length < 2) {
      toast("图层组里至少需要 2 张图才能导出分层文件", "err");
      return;
    }
    const path =
      format === "psd"
        ? await exportLayeredPsd({ width: data.width, height: data.height, composite: data.composite, layers: data.layers })
        : await exportLayeredTiff(data.layers);
    toast(`分层文件已导出 → ${path}`, "ok");
  } catch (e) {
    if (errMsg(e) !== "已取消导出") toast(`导出失败：${errMsg(e)}`, "err");
  }
}

/** 图层组 AI 合成：建一个连好组的 imageGen 节点（模板提示词已填好）；不自动运行，费用确认交给生成按钮的预算闸 */
function spawnComposeNode(groupId: string) {
  const s = useBoard.getState();
  const group = s.nodes.find((n) => n.id === groupId);
  if (!group) return;
  const nid = s.addNode(
    "imageGen",
    { x: group.position.x + (group.measured?.width ?? 640) + 160, y: group.position.y },
    { status: "idle", prompt: elementComposePrompt(), results: [], picked: 0, count: 1 },
  );
  s.connectNodes(groupId, nid, "in", "out");
  toast("已建好 AI 合成节点并接上图层组（参考图按层序聚合）：检查参数后点「生成」", "ok");
}

export function SmartCanvas() {
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  const rawOnNodesChange = useBoard((s) => s.onNodesChange);
  // 点击节点内的交互控件不应选中节点、不应弹出底部生成面板：
  // canvas-wrap 的 onClickCapture 会打标记，这里把那次点击产生的 select 变更滤掉，保持节点原选中状态
  const onNodesChange = useCallback(
    (changes: NodeChange<AppNode>[]) => {
      if (clickOnControl.current) {
        clickOnControl.current = false;
        rawOnNodesChange(changes.filter((c) => c.type !== "select"));
        return;
      }
      rawOnNodesChange(changes);
    },
    [rawOnNodesChange],
  );
  const onEdgesChange = useBoard((s) => s.onEdgesChange);
  const onConnect = useBoard((s) => s.onConnect);
  const addNode = useBoard((s) => s.addNode);
  const duplicateNode = useBoard((s) => s.duplicateNode);
  const proximityConnect = useBoard((s) => s.proximityConnect);
  const groupSelected = useBoard((s) => s.groupSelected);
  const groupInRect = useBoard((s) => s.groupInRect);
  const toggleIgnoreSelected = useBoard((s) => s.toggleIgnoreSelected);
  const snapshot = useBoard((s) => s.snapshot);
  const undo = useBoard((s) => s.undo);
  const redo = useBoard((s) => s.redo);
  const canUndo = useBoard((s) => s.canUndo);
  const canRedo = useBoard((s) => s.canRedo);

  const zen = useUi((s) => s.zen);
  const galleryOpen = useUi((s) => s.galleryOpen);
  const toggleZen = useUi((s) => s.toggleZen);
  const setAddMenu = useUi((s) => s.setAddMenu);
  const tool = useUi((s) => s.tool);
  const toggleTool = useUi((s) => s.toggleTool);
  const groupDraw = useUi((s) => s.groupDraw);
  const setGroupDraw = useUi((s) => s.setGroupDraw);
  const popLock = useUi((s) => s.popLock);
  const aiWireOpen = useUi((s) => s.aiWireOpen);
  const togglePopLock = useUi((s) => s.togglePopLock);
  const hotkeys = useSettings((s) => s.settings.hotkeys);
  const dockShift = galleryOpen && !zen ? 304 : 0;

  const { screenToFlowPosition, getIntersectingNodes, zoomIn, zoomOut, fitView, setViewport: applyViewport } = useReactFlow();
  const activeId = useBoard((s) => s.activeId);
  const [zoomPct, setZoomPct] = useState(100);
  const [largeMinimap,setLargeMinimap]=useState(false);

  /* ---- 视图位置记忆：进入画布时恢复上次的位置/缩放，没有记录才自适应 ---- */
  useEffect(() => {
    const vp = useBoard.getState().boards[activeId]?.meta.viewport;
    if (vp) {
      void applyViewport(vp);
      setZoomPct(Math.round(vp.zoom * 100));
    } else {
      const timer=setTimeout(() => void fitView({ padding: 0.15, maxZoom: 1 }), 60);
      return ()=>clearTimeout(timer);
    }
  }, [activeId, applyViewport, fitView]);
  const [drawRect, setDrawRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // 点击节点内的交互控件（按钮/输入/选择/富文本编辑器）时置 true：阻止这次点击选中节点 / 弹出底部面板
  const clickOnControl = useRef(false);

  /* ---- 标记"应用内部发起的拖拽"：提示词里选中一段文字往外拖这类操作，drop 时不再生成新节点；
         外部应用拖文字/文件进来不受影响（外部拖拽不会在本窗口触发 dragstart） ---- */
  useEffect(() => {
    const onStart = () => {
      internalTextDrag = true;
    };
    const onEnd = () => {
      internalTextDrag = false;
    };
    window.addEventListener("dragstart", onStart, true);
    window.addEventListener("dragend", onEnd, true);
    return () => {
      window.removeEventListener("dragstart", onStart, true);
      window.removeEventListener("dragend", onEnd, true);
    };
  }, []);

  /* ---- Ctrl 框选中：被框住的节点之间的连线高亮（多选才亮，单击不亮）；所有连线统一换自定义边类型 ---- */
  const displayEdges = useMemo(() => {
    const sel = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    return edges.map((e) =>
      sel.size >= 2 && sel.has(e.source) && sel.has(e.target)
        ? { ...e, type: "momo", className: `${e.className ?? ""} hl`.trim() }
        : { ...e, type: "momo" },
    );
  }, [nodes, edges]);

  /* ---- 连线校验：端口统一后不再按类型拒连，只防"同对重复边"和"成环" ---- */
  const isValidConnection = useCallback((conn: Edge | Connection) => {
    const s = useBoard.getState();
    if (!conn.source || !conn.target || conn.source === conn.target) return false;
    if (s.edges.some((e) => e.source === conn.source && e.target === conn.target)) return false;
    if (wouldCycle(s.edges, conn.source, conn.target, s.nodes)) return false;
    return true;
  }, []);

  /* ---- 拖线松手：落在节点身上 → 强吸附自动连线；落在空白 → 快速添加并自动连线 ---- */
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode || !state.fromHandle) return;
      const client =
        "clientX" in event
          ? { x: event.clientX, y: event.clientY }
          : { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
      const flow = screenToFlowPosition(client);

      // 强吸附：线头落在目标节点范围内即自动接到匹配类型的端口，不必对准端口点（组内成员优先于组框）
      const s = useBoard.getState();
      const hits = getIntersectingNodes({ x: flow.x - 1, y: flow.y - 1, width: 2, height: 2 }).filter(
        (n) => n.id !== state.fromNode!.id,
      ) as AppNode[];
      const hit = hits.find((n) => n.type !== "group" && n.type !== "note") ?? hits.find((n) => n.type === "group");
      if (hit) {
        const conn = snapConnection(state.fromNode as AppNode, state.fromHandle, hit, s.nodes, s.edges);
        if (conn) s.onConnect(conn);
        return; // 命中节点：能连就连；连不上也不在节点上叠加添加菜单
      }

      if (state.fromHandle.type !== "source") return;
      // 端口统一后：菜单不再按类型过滤候选，sourcePort 仅作提示（组混合输出 → undefined）
      const pt =
        state.fromNode.type === "group"
          ? null
          : outPortType(state.fromNode.type as NodeKind, state.fromNode.data as Record<string, unknown>);
      if (!pt && state.fromNode.type !== "group") return;
      setAddMenu({
        flowX: flow.x,
        flowY: flow.y,
        screenX: client.x,
        screenY: client.y,
        sourceNode: state.fromNode.id,
        sourcePort: pt ?? undefined,
      });
    },
    [screenToFlowPosition, getIntersectingNodes, setAddMenu],
  );

  /* ---- 双击空白 → 添加菜单 ---- */
  const onPaneClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.detail === 2) {
        const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        setAddMenu({ flowX: flow.x, flowY: flow.y, screenX: e.clientX, screenY: e.clientY });
      } else {
        setAddMenu(null);
      }
    },
    [screenToFlowPosition, setAddMenu],
  );

  /* ---- 右键菜单：画布空白 / 节点 各一套 ---- */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: CmItem[] } | null>(null);

  const GROUP_LABEL: Record<string, string> = {
    输入: "素材 / 文字",
    智能: "智能加工",
    生成: "生成",
    编辑: "编辑处理",
    视频: "视频",
    角色: "角色",
  };
  /** 空白处右键：就近添加各类节点 + 画布级动作 */
  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | { clientX: number; clientY: number; preventDefault: () => void }) => {
      e.preventDefault();
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const addItems: CmItem[] = NODE_CATALOG.filter((c) => c.kind !== "chat" && c.kind !== "llmText").map((c) => ({
        label: c.label,
        icon: c.icon,
        group: GROUP_LABEL[c.group] ?? c.group,
        onClick: () => {
          useUi.getState().setGenPanelSuppressed(false);
          const id = useBoard.getState().addNode(c.kind, { x: flow.x - 40, y: flow.y - 30 });
          window.setTimeout(() => useBoard.getState().proximityConnect(id, flow), 220);
        },
      }));
      const hasTasks = Object.keys(useRunTasks.getState().tasks).length > 0;
      const items: CmItem[] = [
        ...addItems,
        { sep: true },
        { group: "画布", label: "适应全部", onClick: () => void fitView({ duration: 250, padding: 0.15, maxZoom: 1 }) },
        {
          group: "画布",
          label: "导出当前画布…",
          onClick: () => {
            const b = useBoard.getState();
            const name = b.boards[b.activeId]?.meta.name ?? "画布";
            const withMedia = window.confirm(
              "是否包含画布上的图片/视频素材？\n\n• 确定 = 含素材：对方导入即用（文件较大）\n• 取消 = 仅结构：只导出工作流连线与参数，素材需对方自行替换",
            );
            void useTemplates
              .getState()
              .exportBoard(name, b.nodes, b.edges, withMedia)
              .then((p) => p && toast(`已导出当前画布 → ${p}`, "ok"))
              .catch((e) => toast(`导出失败：${errMsg(e)}`, "err"));
          },
        },
        { group: "画布", label: "全部运行", onClick: () => void runAllFlows() },
        ...(hasTasks ? [{ group: "画布" as const, label: "全部停止", danger: true as const, onClick: () => toast(`已停止 ${abortAll()} 个任务`, "ok") }] : []),
        { group: "画布", label: "撤销", disabled: !useBoard.getState().canUndo, onClick: () => useBoard.getState().undo() },
        { group: "画布", label: "重做", disabled: !useBoard.getState().canRedo, onClick: () => useBoard.getState().redo() },
        { sep: true },
        { label: "清空画布…", danger: true, onClick: () => useBoard.getState().clearAll() },
      ];
      setCtxMenu({ x: e.clientX, y: e.clientY, items });
    },
    [screenToFlowPosition, fitView],
  );

  /** 节点右键：复制 / 删除 / 运行 / 停止 / 编辑处理 / 存资产库 / 忽略 / 建组 */
  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: AppNode) => {
      e.preventDefault();
      e.stopPropagation();
      const b = useBoard.getState();
      const sel = b.nodes.filter((n) => n.selected);
      // 右键的节点没在选区里 → 以它单独为操作对象
      const single = sel.find((n) => n.id === node.id) ? null : node;
      const targets = single ? [single] : sel.length > 1 ? sel : [node];
      const ids = targets.map((n) => n.id);
      const multi = targets.length > 1;
      const kind = node.type as NodeKind;
      const d = (node.data ?? {}) as Record<string, unknown>;
      const runState = String(d.status ?? "");
      const isRunning = runState === "running" || !!useRunTasks.getState().tasks[node.id];
      // 可运行判断单一来源：RUNNABLE_KINDS 直接取自 runner 的 RUNNERS 表（勿手抄第二张表，两表漂移曾出 bug）
      const RUNNABLE = RUNNABLE_KINDS_SET;
      const MEDIA = new Set(["image", "video", "audio"]);
      const isIgnored = !!d.ignored;

      const items: CmItem[] = [];
      if (RUNNABLE.has(kind)) {
        if (isRunning)
          items.push({ group: "运行", label: "停止生成", danger: true, onClick: () => abortNode(node.id) });
        else {
          const hasOut = Array.isArray(d.results) && d.results.length > 0;
          items.push({ group: "运行", label: hasOut ? "重新生成" : "运行此节点", onClick: () => void runFlow(node.id) });
        }
      }
      if (!multi && kind === "group") {
        const members = b.nodes.filter((n) => n.parentId === node.id && !(n.data as Record<string, unknown>).ignored);
        const runningN = members.filter((m) => useRunTasks.getState().tasks[m.id]).length;
        if (runningN)
          items.push({
            group: "运行",
            label: `组内全部停止（${runningN} 个在跑）`,
            danger: true,
            onClick: () => members.forEach((m) => abortNode(m.id)),
          });
        else if (members.length)
          items.push({
            group: "运行",
            label: `组内全部运行（${members.length} 个）`,
            onClick: () => members.forEach((m) => void runFlow(m.id)),
          });
        // 图层组（元素工坊拆解产物）：按成员序导出分层文件 / 一键建 AI 合成节点
        if ((node.data as GroupData).layerGroup && members.length >= 2) {
          items.push({
            group: "图层组",
            label: "导出分层 PSD",
            icon: <IcLayers size={15} />,
            onClick: () => void exportLayerGroupAs(node.id, "psd"),
          });
          items.push({
            group: "图层组",
            label: "导出分层 TIFF",
            icon: <IcLayers size={15} />,
            onClick: () => void exportLayerGroupAs(node.id, "tiff"),
          });
          items.push({
            group: "图层组",
            label: "AI 合成海报",
            icon: <IcWand size={15} />,
            onClick: () => spawnComposeNode(node.id),
          });
        }
      }
      if (!multi && kind === "director" && d.projectId) {
        items.push({
          group: "运行",
          label: "打开导演台",
          icon: <IcClapper size={15} />,
          onClick: () => {
            useUi.setState({ directorNodeId: node.id, directorProjectId: (node.data as { projectId?: string }).projectId ?? null });
            useUi.getState().setDirectorOpen(true);
          },
        });
      }
      if (!multi && (kind === "prompt" || kind === "note")) {
        const t = String(d.text ?? "").trim();
        if (t)
          items.push({
            group: "运行",
            label: "复制文本",
            icon: <IcCopy size={15} />,
            onClick: () => void navigator.clipboard.writeText(t).then(() => toast("已复制", "ok")),
          });
      }
      if (MEDIA.has(kind) && !multi) {
        const src = String(d.src ?? "");
        if (src)
          items.push({
            group: "运行",
            label: "保存到资产库",
            onClick: () =>
              void useAssets.getState().collect({ src, kind: kind as "image" | "video" | "audio", name: String(d.name ?? "") }),
          });
      }
      if (!multi && (kind === "image" || kind === "imageGen")) {
        items.push({ group: "编辑处理", label: "打光", icon: <IcBulb size={15} />, onClick: () => b.spawnEdit(node.id, "relight") });
        items.push({ group: "编辑处理", label: "多角度", icon: <IcOrbit size={15} />, onClick: () => b.spawnEdit(node.id, "multiAngle") });
        items.push({ group: "编辑处理", label: "超清放大", icon: <IcUpscale size={15} />, onClick: () => b.spawnEdit(node.id, "enhanceLocal") });
        items.push({ group: "编辑处理", label: "智能矢量", icon: <IcVector size={15} />, onClick: () => b.spawnEdit(node.id, "vectorize") });
      }
      if (!multi && kind === "image") {
        items.push({ group: "编辑处理", label: "电商长图", icon: <IcEcom size={15} />, onClick: () => b.spawnEdit(node.id, "ecomImage") });
      }
      // 首尾帧连拍：多选的全部节点都带主图（宫格切片/生成结果/任意图片节点）即可用；画布位置即时间序
      if (multi && targets.every((n) => !!nodeMainImage(n))) {
        items.push({
          group: "运行",
          label: `首尾帧连拍（${targets.length - 1} 段）`,
          icon: <IcGrid size={15} />,
          onClick: () => void runTailSequence(ids),
        });
      }
      items.push({ sep: true });
      items.push({ group: "节点", label: multi ? `复制 ${targets.length} 个` : "复制节点", onClick: () => b.cloneNodes(ids) });
      items.push({ group: "节点", label: multi ? `删除 ${targets.length} 个` : "删除节点", danger: true, onClick: () => ids.forEach((id) => b.removeNode(id)) });
      items.push({ group: "节点", label: isIgnored ? "取消忽略" : "忽略", onClick: () => b.toggleIgnoreSelected() });
      if (targets.length >= 2) {
        const allGrouped = targets.every((n) => n.parentId);
        items.push({ group: "节点", label: allGrouped ? "取消分组" : "打成一组", onClick: () => b.groupSelected() });
      }
      items.push({ sep: true });
      items.push({ group: "节点", label: "适应到此节点", onClick: () => void fitView({ duration: 250, padding: 0.3, maxZoom: 1.2, nodes: ids.map((id) => ({ id })) }) });
      setCtxMenu({ x: e.clientX, y: e.clientY, items });
    },
    [fitView],
  );

  /** 连线右键：删除连线 / 从源头运行到下游（把该链路上游可运行节点跑一遍再跑下游） */
  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "删除连线", danger: true, onClick: () => useBoard.getState().onEdgesChange([{ id: edge.id, type: "remove" }]) },
          { label: "沿此线运行", onClick: () => void runFlow(edge.target) },
        ],
      });
    },
    [],
  );

  /* ---- 拖放：图片文件 / 文本 / 坞上的节点；落点贴近已有节点时自动连线 ---- */
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // 落点即鼠标位置：等节点完成测量后按鼠标命中判定自动连线
      const autoLink = (nid: string) => window.setTimeout(() => useBoard.getState().proximityConnect(nid, pos), 220);

      const kind = e.dataTransfer.getData("momo/node-kind") as NodeKind | "";
      if (kind) {
        useUi.getState().setGenPanelSuppressed(false);
        autoLink(addNode(kind, pos));
        return;
      }

      // 从资产库拖出的资产 → 节点（读成 dataURL，与其余图片来源约定一致）
      // Tauri 下资产卡走原生拖拽（HTML5 拿不到自定义数据），从拖拽状态里补回资产 id；
      // 多选拖拽时负载是逗号拼接的 id 列表，逐个建节点、阶梯排开
      const rawAssetIds = e.dataTransfer.getData("momo/asset-id") || getNativeDragAsset() || "";
      const assetIds = rawAssetIds.split(",").filter(Boolean);
      if (assetIds.length) {
        const all = useAssets.getState().items;
        const list = assetIds
          .map((id) => all.find((x) => x.id === id))
          .filter((x): x is NonNullable<typeof x> => !!x);
        if (!list.length) return;
        const bad = list.filter((it) => it.kind !== "image" && it.kind !== "video" && it.kind !== "audio");
        if (bad.length === list.length) {
          toast("目前仅支持把图片/视频/音频资产拖入画布", "err");
          return;
        }
        try {
          let placed = 0;
          for (const it of list) {
            if (it.kind !== "image" && it.kind !== "video" && it.kind !== "audio") continue;
            const p = { x: pos.x + placed * 48, y: pos.y + placed * 48 };
            if (it.kind === "video") {
              // 视频资产 → 视频节点（直接用磁盘文件的 asset: URL，重启依然有效）
              const src = assetUrl(it.path);
              autoLink(addNode("video", p, { src, name: it.name, status: "done", dur: await videoDuration(src) }));
            } else if (it.kind === "audio") {
              autoLink(addNode("audio", p, { src: assetUrl(it.path), name: it.name, status: "done" }));
            } else {
              const src = await assetToDataUrl(it.path, it.mime);
              autoLink(addNode("image", p, { src, name: it.name, status: "done" }));
            }
            placed++;
          }
          if (bad.length) toast(`已跳过 ${bad.length} 个非图片/视频/音频资产`, "info");
          // 落到画布成功 → 收起资产库，让用户看到新节点
          useAssets.getState().setOpen(false);
        } catch (err) {
          toast(`读取资产失败：${errMsg(err)}`, "err");
        }
        return;
      }

      // 拖入视频文件 → 视频节点（先落进资产库拿持久地址）
      const allFiles = Array.from(e.dataTransfer.files ?? []);
      const videoFiles = allFiles.filter((f) => f.type.startsWith("video/") || /\.(mp4|webm|mov|mkv|m4v)$/i.test(f.name));
      if (videoFiles.length) {
        for (let i = 0; i < videoFiles.length; i++) {
          const nid = addNode("video", { x: pos.x + i * 36, y: pos.y + i * 36 }, { status: "running", name: videoFiles[i].name });
          try {
            const { src, dur } = await importVideoFile(videoFiles[i]);
            useBoard.getState().updateData(nid, { src, dur, status: "done" });
            autoLink(nid);
          } catch (err) {
            useBoard.getState().updateData(nid, { status: "error", error: errMsg(err) });
          }
        }
        return;
      }

      // 拖入音频文件 → 音频节点
      const audioFiles = allFiles.filter((f) => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(f.name));
      if (audioFiles.length) {
        for (let i = 0; i < audioFiles.length; i++) {
          const nid = addNode("audio", { x: pos.x + i * 36, y: pos.y + i * 36 }, { status: "running", name: audioFiles[i].name });
          try {
            const { src } = await importAudioFile(audioFiles[i]);
            useBoard.getState().updateData(nid, { src, status: "done" });
            autoLink(nid);
          } catch (err) {
            useBoard.getState().updateData(nid, { status: "error", error: errMsg(err) });
          }
        }
        return;
      }

      const files = allFiles.filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        // 落点在一个空的图片节点上 → 直接放进该节点，而不是新建
        const s = useBoard.getState();
        const hit = s.nodes.find((n) => {
          if (n.type !== "image" || (n.data as Record<string, unknown>).src || !n.measured?.width) return false;
          const parent = n.parentId ? s.nodes.find((x) => x.id === n.parentId) : undefined;
          const ax = n.position.x + (parent?.position.x ?? 0);
          const ay = n.position.y + (parent?.position.y ?? 0);
          return pos.x >= ax && pos.x <= ax + (n.measured.width ?? 0) && pos.y >= ay && pos.y <= ay + (n.measured.height ?? 0);
        });
        let i = 0;
        if (hit) {
          const src = await fileToDataUrl(files[0]);
          s.updateData(hit.id, { src, name: files[0].name, status: "done" });
          i = 1;
        }
        for (; i < files.length; i++) {
          const src = await fileToDataUrl(files[i]);
          autoLink(addNode("image", { x: pos.x + i * 36, y: pos.y + i * 36 }, { src, name: files[i].name, status: "done" }));
        }
        return;
      }

      // 外部应用拖入文字 → 提示词节点；应用内部发起的文本拖拽（如提示词里选中一段往外拖）不建节点
      const text = e.dataTransfer.getData("text/plain")?.trim();
      if (text && !internalTextDrag) autoLink(addNode("prompt", pos, { text }));
    },
    [screenToFlowPosition, addNode],
  );

  /* ---- 粘贴 ---- */
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      // 导演台工位打开时粘贴归工位管（剧本/素材入库），画布不劫持
      if (useUi.getState().directorOpen) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      // 资产库/角色库等弹层打开时不劫持粘贴
      if (useUi.getState().settingsOpen || useUi.getState().templateMgrOpen || useUi.getState().charLibOpen) return;
      const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const items = Array.from(e.clipboardData?.items ?? []);
      for (const it of items) {
        if (it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) {
            const src = await fileToDataUrl(f);
            addNode("image", center, { src, name: "粘贴的图片", status: "done" });
          }
          return;
        }
        if (it.type.startsWith("video/")) {
          const f = it.getAsFile();
          if (f) {
            const nid = addNode("video", center, { status: "running", name: f.name || "粘贴的视频" });
            try {
              const { src, dur } = await importVideoFile(f);
              useBoard.getState().updateData(nid, { src, dur, status: "done" });
            } catch (err) {
              useBoard.getState().updateData(nid, { status: "error", error: errMsg(err) });
            }
          }
          return;
        }
      }
      const text = e.clipboardData?.getData("text")?.trim();
      if (text) addNode("prompt", center, { text });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [screenToFlowPosition, addNode]);

  /* ---- 连接点微吸附：鼠标靠近"已弹出"的端口时，端口朝鼠标方向挪一小段（增加拖线命中率）。
         只改 CSS 变量 --mx/--my（写到 handle 外层 DOM 上），不进 React/Zustand 状态、不触发重渲染；
         位移由 ::before 的 translate 属性叠加外探量消费，避开 transform（三态动效在用）---- */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const RANGE = 36; // 触发半径（屏幕 px）
    const PULL = 8; // 最大偏移量
    let raf = 0;
    let mx = 0;
    let my = 0;
    const write = (h: HTMLElement, x: number, y: number) => {
      const xs = `${x}px`;
      const ys = `${y}px`;
      // 值没变就不写，避免每帧把 100+ 个 handle 的样式标脏触发无谓重排
      if (h.style.getPropertyValue("--mx") !== xs) h.style.setProperty("--mx", xs);
      if (h.style.getPropertyValue("--my") !== ys) h.style.setProperty("--my", ys);
    };
    const apply = (h: HTMLElement) => {
      const node = h.closest(".react-flow__node") as HTMLElement | null;
      // 只影响已弹出的端口：节点被悬停/选中、端口自身被悬停、或处于拖线吸附态
      const popped =
        (!!node && (node.matches(":hover") || node.classList.contains("sel"))) ||
        h.matches(":hover") ||
        h.classList.contains("connectingto") ||
        h.classList.contains("connectingfrom");
      if (!popped) {
        write(h, 0, 0);
        return;
      }
      const r = h.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = mx - cx;
      const dy = my - cy;
      const d = Math.hypot(dx, dy);
      if (!isFinite(d) || d <= 0 || d >= RANGE) {
        write(h, 0, 0);
        return;
      }
      const mag = ((RANGE - d) / RANGE) * PULL; // 越近拉得越远，最大 PULL
      write(h, (dx / d) * mag, (dy / d) * mag);
    };
    const tick = () => {
      raf = 0;
      wrap.querySelectorAll<HTMLElement>(".react-flow__handle.port").forEach(apply);
    };
    const onMove = (e: PointerEvent) => {
      mx = e.clientX;
      my = e.clientY;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const resetAll = () => {
      mx = 0;
      my = 0;
      wrap.querySelectorAll<HTMLElement>(".react-flow__handle.port").forEach((h) => write(h, 0, 0));
    };
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerleave", resetAll);
    window.addEventListener("blur", resetAll, true);
    return () => {
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", resetAll);
      window.removeEventListener("blur", resetAll, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  /* ---- 建组/解组：选中有组则解散；多选则打包；否则进入框画模式 ---- */
  const groupAction = useCallback(() => {
    const s = useBoard.getState();
    if (s.nodes.some((n) => n.selected && n.type === "group")) {
      s.ungroupSelected();
      return;
    }
    const sel = s.nodes.filter((n) => n.selected && n.type !== "group" && !n.parentId);
    if (sel.length >= 2) groupSelected();
    else useUi.getState().setGroupDraw(true);
  }, [groupSelected]);

  /* ---- 坞点击添加（当前视图正中心）；也是「添加节点」快捷键的落点 ---- */
  const addAtCenter = useCallback(
    (kind: NodeKind) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      const cx = (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2;
      const cy = (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2;
      // 新节点会被自动选中：解除面板抑制，生成类节点的底部面板立即可用
      useUi.getState().setGenPanelSuppressed(false);
      addNode(kind, screenToFlowPosition({ x: cx, y: cy }));
    },
    [addNode, screenToFlowPosition],
  );

  /* ---- 画布模板实例化到视图中心（Spotlight 选中模板时） ---- */
  const insertTemplateAtCenter = useCallback(
    (tpl: BoardTemplate) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      const cx = (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2;
      const cy = (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2;
      const pos = screenToFlowPosition({ x: cx, y: cy });
      useTemplates.getState().instantiate(tpl, { x: pos.x - 320, y: pos.y - 140 });
    },
    [screenToFlowPosition],
  );

  /* ---- 快捷键（可在设置 → 快捷键 自定义） ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable))
        return;
      const hk = useSettings.getState().settings.hotkeys;
      const hit = (a: keyof typeof hk) => matchHotkey(e, hk[a]);
      // 导演台全屏打开时画布快捷键全部让位（监看器有自己的 J/K/L、←→、Space 等，方案 §7.3），
      // 只保留「打开/关闭导演台」这一个出口
      if (useUi.getState().directorOpen) {
        if (hit("director")) {
          e.preventDefault();
          useUi.getState().setDirectorOpen(false);
        }
        return;
      }
      if (e.key === "Escape" && useUi.getState().groupDraw) {
        useUi.getState().setGroupDraw(false);
        setDrawRect(null);
        return;
      }
      if (hit("zen")) {
        e.preventDefault();
        toggleZen();
      } else if (hit("undo")) {
        e.preventDefault();
        undo();
      } else if (hit("redo") || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")) {
        e.preventDefault();
        redo();
      } else if (hit("duplicate")) {
        e.preventDefault();
        for (const n of useBoard.getState().nodes.filter((n) => n.selected)) duplicateNode(n.id);
      } else if (hit("runAll")) {
        e.preventDefault();
        void runAllFlows();
      } else if (hit("runSelected")) {
        // 焦点不在输入框（顶部已拦截）/按钮上时，回车运行当前选中节点（多选则全部运行）
        if (el?.tagName !== "BUTTON" && !el?.closest("button")) {
          const sel = useBoard.getState().nodes.filter((n) => n.selected);
          if (sel.length) {
            e.preventDefault();
            for (const n of sel) void runFlow(n.id);
          }
        }
      } else if (hit("fitView")) {
        void fitView({ duration: 300, padding: 0.15, maxZoom: 1 });
      } else if (hit("zoomIn")) {
        void zoomIn({ duration: 150 });
      } else if (hit("zoomOut")) {
        void zoomOut({ duration: 150 });
      } else if (hit("assets")) {
        const a = useAssets.getState();
        a.setOpen(!a.open);
      } else if (hit("gallery")) {
        const u = useUi.getState();
        u.setGalleryOpen(!u.galleryOpen);
      } else if (hit("search")) {
        e.preventDefault();
        useUi.getState().setSearchOpen(true);
      } else if (hit("spotlight")) {
        e.preventDefault();
        useUi.getState().setSpotlightOpen(true);
      } else if (hit("moveTool")) {
        toggleTool();
      } else if (hit("group")) {
        groupAction();
      } else if (hit("ignore")) {
        toggleIgnoreSelected();
      } else if (hit("popLock")) {
        useUi.getState().togglePopLock();
      } else if (hit("align")) {
        useBoard.getState().alignSelected();
      } else if (hit("agent")) {
        e.preventDefault();
        const u = useUi.getState();
        u.setAgentOpen(!u.agentOpen);
      } else if (hit("charLib")) {
        e.preventDefault();
        const u = useUi.getState();
        u.setCharLibOpen(!u.charLibOpen);
      } else if (hit("settings")) {
        e.preventDefault();
        useUi.getState().openSettings();
      } else if (hit("errCenter")) {
        e.preventDefault();
        const u = useUi.getState();
        u.setErrlogOpen(!u.errlogOpen);
      } else if (hit("runLog")) {
        e.preventDefault();
        useUi.getState().setRunLogOpen(!useUi.getState().runLogOpen);
      } else if (hit("theme")) {
        e.preventDefault();
        const st = useSettings.getState();
        const t = st.settings.theme;
        st.update("theme", t === "light" ? "dark" : t === "dark" ? "black" : "light");
      } else if (hit("newBoard")) {
        e.preventDefault();
        useBoard.getState().newBoard();
      } else if (hit("voiceCall")) {
        e.preventDefault();
        useUi.getState().setAgentOpen(true);
        if (isVoiceCallActive()) stopVoiceCall();
        else void startVoiceCall();
      } else if (hit("director")) {
        e.preventDefault();
        const u = useUi.getState();
        u.setDirectorOpen(!u.directorOpen);
      } else {
        // 下方工具坞的「添加节点」快捷键（每个节点类型都可在设置里自定义）
        const item = NODE_CATALOG.find((i) => matchHotkey(e, hk[i.hotkey]));
        if (item) {
          e.preventDefault();
          addAtCenter(item.kind);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleZen, duplicateNode, fitView, zoomIn, zoomOut, undo, redo, toggleTool, groupAction, toggleIgnoreSelected, addAtCenter]);

  /* ---- 拖拽事件的指针画布坐标（鼠标/触摸通吃） ---- */
  const dragMouse = useCallback(
    (e: MouseEvent | TouchEvent) => {
      const p = "clientX" in e ? e : (e.touches[0] ?? e.changedTouches[0]);
      return screenToFlowPosition({ x: p.clientX, y: p.clientY });
    },
    [screenToFlowPosition],
  );

  /* ---- 拖拽中：预告将要自动连线的两个节点（以鼠标位置命中目标为准） ---- */
  const onNodeDrag = useCallback(
    (e: MouseEvent | TouchEvent, node: AppNode) => {
      const s = useBoard.getState();
      const pair = findProximityPair(s.nodes, s.edges, node.id, dragMouse(e));
      useUi.getState().setProxHint(pair ? [pair.up.id, pair.down.id] : null);
    },
    [dragMouse],
  );

  /* ---- 拖拽结束：鼠标命中/贴近 自动连线 ---- */
  const onNodeDragStop = useCallback(
    (e: MouseEvent | TouchEvent, node: AppNode) => {
      proximityConnect(node.id, dragMouse(e));
      useUi.getState().setProxHint(null);
      // 成员拖完后重排所属组（组框按成员新位置自适应）
      const parentId = useBoard.getState().nodes.find((n) => n.id === node.id)?.parentId;
      if (parentId) useBoard.getState().relayoutGroup(parentId);
    },
    [proximityConnect, dragMouse],
  );

  /* ---- 建组框画 ---- */
  const finishGroupDraw = () => {
    if (!drawRect) {
      setGroupDraw(false);
      return;
    }
    const w = Math.abs(drawRect.x2 - drawRect.x1);
    const h = Math.abs(drawRect.y2 - drawRect.y1);
    setDrawRect(null);
    setGroupDraw(false);
    if (w < 24 || h < 24) return;
    const p1 = screenToFlowPosition({ x: Math.min(drawRect.x1, drawRect.x2), y: Math.min(drawRect.y1, drawRect.y2) });
    const p2 = screenToFlowPosition({ x: Math.max(drawRect.x1, drawRect.x2), y: Math.max(drawRect.y1, drawRect.y2) });
    groupInRect({ x: p1.x, y: p1.y, w: p2.x - p1.x, h: p2.y - p1.y });
  };

  /* ---- Alt+拖拽复制：按住 Alt 在节点上起拖 → 复制选集（含组成员、内部连线保留），副本跟手、原节点不动 ---- */
  const startCloneDrag = useCallback(
    (grabId: string, start: { x: number; y: number }) => {
      let ctx: {
        startPos: Map<string, { x: number; y: number }>;
        origin: { x: number; y: number };
        off: { x: number; y: number };
        cloneGrabId: string;
      } | null = null;
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
      };
      // 超过 4px 才认定是拖拽（纯 Alt+点击不复制）
      const begin = (ev: PointerEvent): boolean => {
        const s = useBoard.getState();
        const grabbed = s.nodes.find((n) => n.id === grabId);
        if (!grabbed) return false;
        // 抓取的节点在选集内 → 复制整个选集；否则只复制它一个
        const base = grabbed.selected ? s.nodes.filter((n) => n.selected).map((n) => n.id) : [grabId];
        const map = s.cloneNodes(base);
        if (!map.size) return false;
        const after = useBoard.getState();
        const startPos = new Map<string, { x: number; y: number }>();
        for (const newId of map.values()) {
          const n = after.nodes.find((x) => x.id === newId);
          if (n && !n.parentId) startPos.set(newId, { ...n.position });
        }
        if (!startPos.size) return false;
        const cloneGrabId = map.get(grabId) ?? "";
        const origin = (cloneGrabId && startPos.get(cloneGrabId)) || [...startPos.values()][0];
        const grabStart = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
        ctx = { startPos, origin, off: { x: grabStart.x - origin.x, y: grabStart.y - origin.y }, cloneGrabId };
        // 拖动期间不弹生成设置面板
        useUi.getState().setGenPanelSuppressed(true);
        document.body.style.cursor = "copy";
        return true;
      };
      const moveTo = (ev: PointerEvent, dragging: boolean) => {
        if (!ctx) return;
        const cur = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
        useBoard.getState().onNodesChange(
          [...ctx.startPos.entries()].map(([id, p]) => ({
            type: "position" as const,
            id,
            position: { x: cur.x - ctx!.off.x + (p.x - ctx!.origin.x), y: cur.y - ctx!.off.y + (p.y - ctx!.origin.y) },
            dragging,
          })),
        );
        return cur;
      };
      const onMove = (ev: PointerEvent) => {
        if (!ctx) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
          if (!begin(ev)) cleanup();
          return;
        }
        moveTo(ev, true);
      };
      const onUp = (ev: PointerEvent) => {
        const c = ctx;
        cleanup();
        if (!c) return;
        const cur = moveTo(ev, false);
        // 与正常拖动一致的收尾：贴近自动连线
        if (cur) useBoard.getState().proximityConnect(c.cloneGrabId, cur);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [screenToFlowPosition],
  );

  let lastGroup = "";
  return (
    <div
      className="canvas-wrap"
      ref={wrapRef}
      onTouchStartCapture={(e) => { prepareNodeDrag(e.target); }}
      onClickCapture={(e) => {
        const t = e.target as HTMLElement;
        clickOnControl.current = !!t.closest("button, select, textarea, input, [contenteditable]");
        // 标记只对「本次点击」有效：React 的 capture→bubble 在同一同步栈内跑完，
        // 微任务里复位即可；否则点了控件但没产生 select 变更时，标记会残留并吞掉下一次真正的选中
        queueMicrotask(() => (clickOnControl.current = false));
      }}
      onMouseDownCapture={(e) => {
        const onControl = prepareNodeDrag(e.target);
        // Alt+拖拽复制节点：拦截在 React Flow 拖动/框选之前（可交互控件上不抢）
        if (e.button !== 0 || !e.altKey) return;
        const t = e.target as HTMLElement;
        if (onControl) return;
        let id = (t.closest(".react-flow__node") as HTMLElement | null)?.getAttribute("data-id");
        if (!id && t.closest(".react-flow__nodesselection")) {
          // 多选时落点常在多选框遮罩（nodesselection-rect）上而非节点本体：拿第一个选中节点当抓手
          id = useBoard.getState().nodes.find((n) => n.selected)?.id;
        }
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        startCloneDrag(id, { x: e.clientX, y: e.clientY });
      }}
      onDrop={(e) => void onDrop(e)}
      onDragOver={(e) => e.preventDefault()}
    >
      <ReactFlow
        nodes={nodes}
        onlyRenderVisibleElements={nodes.length > 250}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onNodeDragStart={(_e, _node) => {
          snapshot();
          // 拖动期间不弹生成设置面板（点击节点后才显示）
          useUi.getState().setGenPanelSuppressed(true);
        }}
        onNodeClick={(e) => {
          // 点的是节点里的按钮/输入控件（如「生成」）→ 不弹设置面板；点节点本体才弹
          const t = e.target as HTMLElement;
          if (t.closest("button, select, textarea, input")) return;
          useUi.getState().setGenPanelSuppressed(false);
        }}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        isValidConnection={isValidConnection}
        connectionRadius={80}
        proOptions={{ hideAttribution: true }}
        minZoom={0.15}
        maxZoom={2.5}
        noDragClassName="momo-node-control"
        panOnDrag={tool === "move" ? [0, 1] : [1]}
        selectionOnDrag={tool !== "move"}
        selectionKeyCode={["Shift", "Control"]}
        selectionMode={SelectionMode.Partial}
        panActivationKeyCode="Space"
        zoomOnDoubleClick={false}
        deleteKeyCode={hotkeys.delete.includes("+") ? ["Backspace"] : [hotkeys.delete, "Backspace"]}
        multiSelectionKeyCode={["Shift", "Control"]}
        onMove={(_, vp) => setZoomPct(Math.round(vp.zoom * 100))}
        onMoveEnd={(_, vp) => {
          setZoomPct(Math.round(vp.zoom * 100));
          useBoard.getState().setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom });
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={30} size={1.2} color="var(--dot)" />
        <EdgeBoxSelect />
        <AlignGuides />
      {!zen && nodes.length > 3 && (nodes.length <= 2000 || largeMinimap) ? (
          // 小地图收在右下，给右侧资产库展开留出平移量
          <MiniMap pannable zoomable position="bottom-right" style={{ marginBottom: 16, marginRight: 16 + dockShift }} />
        ) : null}
      </ReactFlow>
      {!zen && nodes.length>2000&&<button className="btn sm" style={{position:"absolute",right:16+dockShift,bottom:largeMinimap?175:16,zIndex:8}} onClick={()=>setLargeMinimap(v=>!v)}>{largeMinimap?"收起小地图":"展开小地图"} · {nodes.length} 节点</button>}

      {ctxMenu ? <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} /> : null}

      {nodes.length === 0 ? (
        <div className="empty-guide">
          <div className="eg-logo">
            <IcLogo size={64} />
          </div>
          <h2>MOMO 智能画布</h2>
          <p>
            双击空白处 或 从下方工具坞添加节点开始创作
            <br />
            <kbd>拖入图片</kbd> <kbd>Ctrl+V 粘贴</kbd> <kbd>V 移动工具</kbd> <kbd>滚轮 缩放</kbd> <kbd>Tab 沉浸</kbd>
            <br />
            拖动节点、把鼠标移到另一个节点上松手即自动连线（指针在左半边作上游、右半边作下游）
          </p>
        </div>
      ) : null}

      {/* 系统资源仪表盘：CPU/内存/GPU/显存，右上；右侧生成记录坞打开时随 dockShift 左移 */}
      {!zen ? <SysMonitor shift={dockShift} /> : null}

      {!zen ? (
        <div className="tool-bar glass">
          <button
            className="tb-btn tb-add"
            title="添加节点：在画布中心打开快速添加菜单（也可双击空白处）"
            onClick={() => {
              const rect = wrapRef.current?.getBoundingClientRect();
              const cx = (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2;
              const cy = (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2;
              const flow = screenToFlowPosition({ x: cx, y: cy });
              setAddMenu({ flowX: flow.x, flowY: flow.y, screenX: cx, screenY: cy });
            }}
          >
            <IcPlus size={20} />
          </button>
          <button
            className={`tb-btn ${tool === "move" ? "on" : ""}`}
            title={`移动工具（${hotkeys.moveTool.toUpperCase()}）：左键拖空白平移 · 点击选择 · 再点一次回到框选模式`}
            onClick={toggleTool}
          >
            <IcCursor size={18} />
          </button>
          <button
            className={`tb-btn ${groupDraw ? "on" : ""}`}
            title={`建组/解组（${hotkeys.group.toUpperCase()}）：选中组时解散；多选节点时打包成组并自动排布；否则框画区域建组`}
            onClick={groupAction}
          >
            <IcGroup size={18} />
          </button>
          <button
            className="tb-btn"
            title={`忽略/恢复所选节点（${hotkeys.ignore.toUpperCase()}）：忽略的节点半透明且不向下游传递`}
            onClick={toggleIgnoreSelected}
          >
            <IcEyeOff size={18} />
          </button>
          <button
            className={`tb-btn ${popLock ? "on" : ""}`}
            title={`弹窗锁定（${hotkeys.popLock.toUpperCase()}）：开启后「上游传入」预览弹窗不会因点击画布或其他节点而收起（内容仍会跟随上游变化实时更新）`}
            onClick={togglePopLock}
          >
            <IcLock size={18} />
          </button>
          <button
            className={`tb-btn ${aiWireOpen ? "on" : ""}`}
            title="AI 布线助手：一句话描述意图，自动规划并连好一套工作流（方案先预览、确认才落画布）；再点一次关闭"
            onClick={() => useUi.getState().setAiWireOpen(!useUi.getState().aiWireOpen)}
          >
            <IcWand size={18} />
          </button>
          <ClearAllBtn />
        </div>
      ) : null}

      {!zen ? (
        <div className="dock glass">
          {NODE_CATALOG.filter((i) => !i.dockHidden).map((i) => {
            const sep = i.group !== lastGroup && lastGroup !== "";
            lastGroup = i.group;
            return (
              <div key={i.kind} style={{ display: "contents" }}>
                {sep ? <div className="dock-sep" /> : null}
                <div
                  className="dock-item"
                  title={`${i.desc}（快捷键 ${(hotkeys[i.hotkey] || "未绑定").toUpperCase()} · 点击添加到视图中心，或拖到画布任意位置）`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("momo/node-kind", i.kind);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => addAtCenter(i.kind)}
                >
                  <span className="di-ic">{i.icon}</span>
                  {i.label}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {!zen ? (
        <div className="view-ctrl glass">
          <button
            className="run-all-btn"
            title="一键运行：画布内所有工作流都从头按顺序运行"
            onClick={() => void runAllFlows()}
          >
            <IcPlay size={15} /> 运行全部
          </button>
          <div className="vc-sep" />
          <button className="icon-btn" title="撤销 (Ctrl+Z)" disabled={!canUndo} style={{ opacity: canUndo ? 1 : 0.35 }} onClick={undo}>
            <IcUndo size={17} />
          </button>
          <button className="icon-btn" title="重做 (Ctrl+Y)" disabled={!canRedo} style={{ opacity: canRedo ? 1 : 0.35 }} onClick={redo}>
            <IcRedo size={17} />
          </button>
          <div className="vc-sep" />
          <button className="icon-btn" title="放大" onClick={() => void zoomIn({ duration: 150 })}>
            <IcPlus size={17} />
          </button>
          <div className="zoom-pct">{zoomPct}%</div>
          <button className="icon-btn" title="缩小" onClick={() => void zoomOut({ duration: 150 })}>
            <IcMin size={17} />
          </button>
          <button
            className="icon-btn"
            title={`适应全部 (${hotkeys.fitView.toUpperCase()})`}
            onClick={() => void fitView({ duration: 300, padding: 0.15, maxZoom: 1 })}
          >
            <IcFit size={17} />
          </button>
        </div>
      ) : null}

      {groupDraw ? (
        <div
          className="group-draw"
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            setDrawRect({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
          }}
          onMouseMove={(e) => {
            if (drawRect) setDrawRect({ ...drawRect, x2: e.clientX, y2: e.clientY });
          }}
          onMouseUp={finishGroupDraw}
        >
          <div className="gd-hint">拖动框画一个区域建立组（区域内节点自动入组并排布）· Esc 取消</div>
          {drawRect ? (
            <div
              className="gd-rect"
              style={{
                left: Math.min(drawRect.x1, drawRect.x2),
                top: Math.min(drawRect.y1, drawRect.y2),
                width: Math.abs(drawRect.x2 - drawRect.x1),
                height: Math.abs(drawRect.y2 - drawRect.y1),
              }}
            />
          ) : null}
        </div>
      ) : null}

      {/* 底部参数栏整体兜在 ErrorBoundary 里：任何面板渲染异常只坏面板本身，不整窗白屏 */}
      {!zen ? (
        <ErrorBoundary name="底部参数栏">
          <GenConfigPanel />
          <VideoConfigPanel />
          <AudioConfigPanel />
          <CharConfigPanel />
          <EcomConfigPanel />
          <ComfyConfigPanel />
          <EnhanceConfigPanel />
          <VectorizeConfigPanel />
        </ErrorBoundary>
      ) : null}

      <AddNodeMenu />
      <CanvasSearch />
      <Spotlight onPick={addAtCenter} onPickTemplate={insertTemplateAtCenter} />
      <AiWirePanel />
    </div>
  );
}
