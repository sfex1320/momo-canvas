/**
 * 智能画布 — 单一画布范式：
 *  移动工具（V，默认）：左键拖空白平移 · 点击选择 · 长按节点拖动
 *  框选模式：左键框选（Ctrl+框选可选中连线批量删）· 中/右键或空格平移
 *  滚轮缩放 · 双击空白添加节点 · 拖线到空白快速建节点 · 拖入图片/文本 · Ctrl+V 粘贴
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
  type Connection,
  type Edge,
  type FinalConnectionState,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas.css";

import { useBoard, outPortType, findProximityPair, wouldCycle } from "../../core/stores/boardStore";
import { useTemplates } from "../../core/stores/templateStore";
import { getNativeDragAsset } from "../assets/dragState";
import { toast, useUi } from "../../core/stores/uiStore";
import { useSettings } from "../../core/stores/settingsStore";
import { useAssets } from "../../core/stores/assetStore";
import { assetToDataUrl } from "../../core/services/assetFiles";
import { GenConfigPanel } from "./GenConfigPanel";
import type { AppNode, BoardTemplate, NodeKind } from "../../core/types";
import { errMsg, fileToDataUrl, matchHotkey } from "../../core/utils";
import { NODE_CATALOG } from "./nodeCatalog";
import { AddNodeMenu } from "./AddNodeMenu";
import { CanvasSearch, Spotlight } from "./CanvasPalette";
import { AiWirePanel } from "./AiWirePanel";
import { runAllFlows } from "../../core/runner";
import { IcCursor, IcEyeOff, IcFit, IcGroup, IcLock, IcLogo, IcPlay, IcPlus, IcMin, IcTrash, IcUndo, IcRedo, IcWand } from "../../ui/icons";

import { ImageNode } from "./nodes/ImageNode";
import { PromptNode } from "./nodes/PromptNode";
import { ChatNode } from "./nodes/ChatNode";
import { ImageGenNode } from "./nodes/ImageGenNode";
import { VideoGenNode } from "./nodes/VideoGenNode";
import { ComfyNode } from "./nodes/ComfyNode";
import { CaptionNode } from "./nodes/CaptionNode";
import { LlmTextNode } from "./nodes/LlmTextNode";
import { CombineNode } from "./nodes/CombineNode";
import { StylePresetNode } from "./nodes/StylePresetNode";
import { NoteNode } from "./nodes/NoteNode";
import { GroupNode } from "./nodes/GroupNode";
import { RelightNode } from "./nodes/RelightNode";
import { MultiAngleNode } from "./nodes/MultiAngleNode";
import { CharCardNode } from "./nodes/CharCardNode";
import { ResizeNode } from "./nodes/ResizeNode";
import { InpaintNode } from "./nodes/InpaintNode";
import { OutpaintNode } from "./nodes/OutpaintNode";
import { MattingNode } from "./nodes/MattingNode";
import { EnhanceNode } from "./nodes/EnhanceNode";
import { CropNode } from "./nodes/CropNode";

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
  prompt: PromptNode,
  chat: ChatNode,
  imageGen: ImageGenNode,
  videoGen: VideoGenNode,
  comfy: ComfyNode,
  caption: CaptionNode,
  llmText: LlmTextNode,
  combine: CombineNode,
  stylePreset: StylePresetNode,
  note: NoteNode,
  group: GroupNode,
  relight: RelightNode,
  multiAngle: MultiAngleNode,
  charCard: CharCardNode,
  resize: ResizeNode,
  inpaint: InpaintNode,
  outpaint: OutpaintNode,
  matting: MattingNode,
  enhance: EnhanceNode,
  crop: CropNode,
};

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

export function SmartCanvas() {
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  const onNodesChange = useBoard((s) => s.onNodesChange);
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
  const togglePopLock = useUi((s) => s.togglePopLock);
  const hotkeys = useSettings((s) => s.settings.hotkeys);
  const dockShift = galleryOpen && !zen ? 304 : 0;

  const { screenToFlowPosition, zoomIn, zoomOut, fitView, setViewport: applyViewport } = useReactFlow();
  const activeId = useBoard((s) => s.activeId);
  const [zoomPct, setZoomPct] = useState(100);

  /* ---- 视图位置记忆：进入画布时恢复上次的位置/缩放，没有记录才自适应 ---- */
  useEffect(() => {
    const vp = useBoard.getState().boards[activeId]?.meta.viewport;
    if (vp) {
      void applyViewport(vp);
      setZoomPct(Math.round(vp.zoom * 100));
    } else {
      setTimeout(() => void fitView({ padding: 0.15, maxZoom: 1 }), 60);
    }
  }, [activeId, applyViewport, fitView]);
  const [drawRect, setDrawRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  /* ---- Ctrl 框选中：被框住的节点之间的连线高亮（多选才亮，单击不亮） ---- */
  const displayEdges = useMemo(() => {
    const sel = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    if (sel.size < 2) return edges;
    return edges.map((e) =>
      sel.has(e.source) && sel.has(e.target)
        ? { ...e, className: `${e.className ?? ""} hl`.trim() }
        : e,
    );
  }, [nodes, edges]);

  /* ---- 连线校验 ---- */
  const isValidConnection = useCallback((conn: Edge | Connection) => {
    const s = useBoard.getState();
    if (!conn.source || !conn.target || conn.source === conn.target) return false;
    const src = s.nodes.find((n) => n.id === conn.source);
    if (!src) return false;
    const pt =
      src.type === "group"
        ? conn.sourceHandle === "out-image"
          ? "image"
          : conn.sourceHandle === "out-text"
            ? "text"
            : null
        : outPortType(src.type as NodeKind, src.data as Record<string, unknown>);
    if (!pt) return false;
    const want = conn.targetHandle === "in-text" ? "text" : conn.targetHandle === "in-image" ? "image" : null;
    if (want !== pt) return false;
    if (s.edges.some((e) => e.source === conn.source && e.target === conn.target && e.targetHandle === conn.targetHandle))
      return false;
    // 已是自己的上游就不能再接成自己的下游（禁止互连/成环）
    if (wouldCycle(s.edges, conn.source, conn.target)) return false;
    return true;
  }, []);

  /* ---- 拖线到空白 → 快速添加并自动连线 ---- */
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode || state.fromHandle?.type !== "source") return;
      const pt =
        state.fromNode.type === "group"
          ? state.fromHandle.id === "out-image"
            ? ("image" as const)
            : ("text" as const)
          : outPortType(state.fromNode.type as NodeKind, state.fromNode.data as Record<string, unknown>);
      if (!pt || pt === "video") return;
      const client =
        "clientX" in event
          ? { x: event.clientX, y: event.clientY }
          : { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
      const flow = screenToFlowPosition(client);
      setAddMenu({
        flowX: flow.x,
        flowY: flow.y,
        screenX: client.x,
        screenY: client.y,
        sourceNode: state.fromNode.id,
        sourcePort: pt,
      });
    },
    [screenToFlowPosition, setAddMenu],
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

  /* ---- 拖放：图片文件 / 文本 / 坞上的节点；落点贴近已有节点时自动连线 ---- */
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // 落点即鼠标位置：等节点完成测量后按鼠标命中判定自动连线
      const autoLink = (nid: string) => window.setTimeout(() => useBoard.getState().proximityConnect(nid, pos), 220);

      const kind = e.dataTransfer.getData("momo/node-kind") as NodeKind | "";
      if (kind) {
        autoLink(addNode(kind, pos));
        return;
      }

      // 从资产库拖出的图片资产 → 图片节点（读成 dataURL，与其余图片来源约定一致）
      // Tauri 下资产卡走原生拖拽（HTML5 拿不到自定义数据），从拖拽状态里补回资产 id
      const assetId = e.dataTransfer.getData("momo/asset-id") || getNativeDragAsset() || "";
      if (assetId) {
        const it = useAssets.getState().items.find((x) => x.id === assetId);
        if (!it) return;
        if (it.kind !== "image") {
          toast("目前仅支持把图片资产拖入画布", "err");
          return;
        }
        try {
          const src = await assetToDataUrl(it.path, it.mime);
          autoLink(addNode("image", pos, { src, name: it.name, status: "done" }));
          // 落到画布成功 → 收起资产库，让用户看到新节点
          useAssets.getState().setOpen(false);
        } catch (err) {
          toast(`读取资产失败：${errMsg(err)}`, "err");
        }
        return;
      }

      const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/"));
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

      // 外部拖入文字素材 → 提示词节点
      const text = e.dataTransfer.getData("text/plain")?.trim();
      if (text) autoLink(addNode("prompt", pos, { text }));
    },
    [screenToFlowPosition, addNode],
  );

  /* ---- 粘贴 ---- */
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
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
      }
      const text = e.clipboardData?.getData("text")?.trim();
      if (text) addNode("prompt", center, { text });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [screenToFlowPosition, addNode]);

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
      useUi.getState().setDupGhost(null);
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

  let lastGroup = "";
  return (
    <div className="canvas-wrap" ref={wrapRef} onDrop={(e) => void onDrop(e)} onDragOver={(e) => e.preventDefault()}>
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onPaneClick={onPaneClick}
        onNodeDragStart={(e, node) => {
          snapshot();
          // 拖动期间不弹生成设置面板（点击节点后才显示）
          useUi.getState().setGenPanelSuppressed(true);
          // Alt+拖拽 = 复制：原工作流原地保留，被拖走的是副本（虚线显示）
          if ((e as unknown as { altKey?: boolean }).altKey) {
            const ids = useBoard.getState().altDuplicateStart(node.id);
            if (ids) useUi.getState().setDupGhost(ids);
          }
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
        connectionRadius={36}
        proOptions={{ hideAttribution: true }}
        minZoom={0.15}
        maxZoom={2.5}
        panOnDrag={tool === "move" ? [0, 1, 2] : [1, 2]}
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
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} color="var(--dot)" />
        <EdgeBoxSelect />
        {!zen && nodes.length > 3 ? (
          <MiniMap pannable zoomable position="bottom-right" style={{ marginBottom: 74, marginRight: 10 + dockShift }} />
        ) : null}
      </ReactFlow>

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

      {!zen ? (
        <div className="tool-bar glass">
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
            className="tb-btn"
            title="AI 布线助手：一句话描述意图，自动规划并连好一套工作流（方案先预览、确认才落画布）"
            onClick={() => useUi.getState().setAiWireOpen(true)}
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
        <div className="view-ctrl glass" style={{ right: 16 + dockShift }}>
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

      {!zen ? <GenConfigPanel /> : null}

      <AddNodeMenu />
      <CanvasSearch />
      <Spotlight onPick={addAtCenter} onPickTemplate={insertTemplateAtCenter} />
      <AiWirePanel />
    </div>
  );
}
