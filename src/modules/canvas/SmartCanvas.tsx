/**
 * 智能画布 — 单一画布范式：
 *  移动工具（V，默认）：左键拖空白平移 · 点击选择 · 长按节点拖动
 *  框选模式：左键框选（Ctrl+框选可选中连线批量删）· 中/右键或空格平移
 *  滚轮缩放 · 双击空白添加节点 · 拖线到空白快速建节点 · 拖入图片/文本 · Ctrl+V 粘贴
 *  拖拽贴近/叠放到节点上自动连线（虚线框预告） · G 建组 · I 忽略 · Ctrl+Z/Y 撤销重做
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
import { useUi } from "../../core/stores/uiStore";
import { useSettings } from "../../core/stores/settingsStore";
import { GenConfigPanel } from "./GenConfigPanel";
import type { AppNode, NodeKind } from "../../core/types";
import { fileToDataUrl } from "../../core/utils";
import { NODE_CATALOG } from "./nodeCatalog";
import { AddNodeMenu } from "./AddNodeMenu";
import { IcCursor, IcEyeOff, IcFit, IcGroup, IcLogo, IcPlus, IcMin, IcUndo, IcRedo } from "../../ui/icons";

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
  const hotkeys = useSettings((s) => s.settings.hotkeys);
  const dockShift = galleryOpen && !zen ? 304 : 0;

  const { screenToFlowPosition, zoomIn, zoomOut, fitView } = useReactFlow();
  const [zoomPct, setZoomPct] = useState(100);
  const [drawRect, setDrawRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

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
        : outPortType(src.type as NodeKind);
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
          : outPortType(state.fromNode.type as NodeKind);
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
      const autoLink = (nid: string) => window.setTimeout(() => useBoard.getState().proximityConnect(nid), 220);

      const kind = e.dataTransfer.getData("momo/node-kind") as NodeKind | "";
      if (kind) {
        autoLink(addNode(kind, pos));
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
      // 资产库等弹层打开时不劫持粘贴
      if (useUi.getState().settingsOpen || useUi.getState().templateMgrOpen) return;
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

  /* ---- 快捷键（可在设置 → 快捷键 自定义） ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable))
        return;
      const mod = e.ctrlKey || e.metaKey;
      const hk = useSettings.getState().settings.hotkeys;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (e.key === "Escape" && useUi.getState().groupDraw) {
        useUi.getState().setGroupDraw(false);
        setDrawRect(null);
        return;
      }
      if (!mod && key === hk.zen) {
        e.preventDefault();
        toggleZen();
      } else if (mod && key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((mod && key === "y") || (mod && e.shiftKey && key === "z")) {
        e.preventDefault();
        redo();
      } else if (mod && key === "d") {
        e.preventDefault();
        for (const n of useBoard.getState().nodes.filter((n) => n.selected)) duplicateNode(n.id);
      } else if (!mod && key === hk.fitView) {
        void fitView({ duration: 300, padding: 0.15, maxZoom: 1 });
      } else if (!mod && key === hk.moveTool) {
        toggleTool();
      } else if (!mod && key === hk.group) {
        groupAction();
      } else if (!mod && key === hk.ignore) {
        toggleIgnoreSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleZen, duplicateNode, fitView, undo, redo, toggleTool, groupAction, toggleIgnoreSelected]);

  /* ---- 坞点击添加（当前视图正中心） ---- */
  const addAtCenter = (kind: NodeKind) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const cx = (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2;
    const cy = (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2;
    addNode(kind, screenToFlowPosition({ x: cx, y: cy }));
  };

  /* ---- 拖拽中：预告将要自动连线的两个节点 ---- */
  const onNodeDrag = useCallback((_: unknown, node: AppNode) => {
    const s = useBoard.getState();
    const pair = findProximityPair(s.nodes, s.edges, node.id);
    useUi.getState().setProxHint(pair ? [pair.up.id, pair.down.id] : null);
  }, []);

  /* ---- 拖拽结束：贴近/覆盖 自动连线 ---- */
  const onNodeDragStop = useCallback(
    (_: unknown, node: AppNode) => {
      proximityConnect(node.id);
      useUi.getState().setProxHint(null);
      useUi.getState().setDupGhost(null);
    },
    [proximityConnect],
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
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onPaneClick={onPaneClick}
        onNodeDragStart={(e, node) => {
          snapshot();
          // Alt+拖拽 = 复制：原工作流原地保留，被拖走的是副本（虚线显示）
          if ((e as unknown as { altKey?: boolean }).altKey) {
            const ids = useBoard.getState().altDuplicateStart(node.id);
            if (ids) useUi.getState().setDupGhost(ids);
          }
        }}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        isValidConnection={isValidConnection}
        connectionRadius={36}
        proOptions={{ hideAttribution: true }}
        minZoom={0.15}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
        panOnDrag={tool === "move" ? [0, 1, 2] : [1, 2]}
        selectionOnDrag={tool !== "move"}
        selectionKeyCode={["Shift", "Control"]}
        selectionMode={SelectionMode.Partial}
        panActivationKeyCode="Space"
        zoomOnDoubleClick={false}
        deleteKeyCode={["Delete", "Backspace"]}
        multiSelectionKeyCode={["Shift", "Control"]}
        onMove={(_, vp) => setZoomPct(Math.round(vp.zoom * 100))}
        onMoveEnd={(_, vp) => setZoomPct(Math.round(vp.zoom * 100))}
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
            把节点拖到另一个节点旁边（或直接叠上去）松手，会自动连线
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
        </div>
      ) : null}

      {!zen ? (
        <div className="dock glass">
          {NODE_CATALOG.map((i) => {
            const sep = i.group !== lastGroup && lastGroup !== "";
            lastGroup = i.group;
            return (
              <div key={i.kind} style={{ display: "contents" }}>
                {sep ? <div className="dock-sep" /> : null}
                <div
                  className="dock-item"
                  title={`${i.desc}（点击添加到视图中心，或拖到画布任意位置）`}
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
          <button className="icon-btn" title="撤销 (Ctrl+Z)" disabled={!canUndo} style={{ opacity: canUndo ? 1 : 0.35 }} onClick={undo}>
            <IcUndo size={17} />
          </button>
          <button className="icon-btn" title="重做 (Ctrl+Y)" disabled={!canRedo} style={{ opacity: canRedo ? 1 : 0.35 }} onClick={redo}>
            <IcRedo size={17} />
          </button>
          <div style={{ width: 1, alignSelf: "stretch", background: "var(--panel-border)", margin: "5px 3px" }} />
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
    </div>
  );
}
