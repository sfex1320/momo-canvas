/**
 * 智能画布 — 单一画布范式：
 *  左键框选 · 中/右键或空格平移 · 滚轮缩放 · 双击空白添加节点
 *  拖线到空白快速建节点 · 拖入图片文件 · Ctrl+V 粘贴 · Tab 沉浸模式
 *  拖拽贴近/叠放到节点上自动连线（拖拽中高亮预告） · Ctrl+Z/Y 撤销重做
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  SelectionMode,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas.css";

import { useBoard, outPortType, findProximityPair, wouldCycle } from "../../core/stores/boardStore";
import { GenConfigPanel } from "./GenConfigPanel";
import { useUi } from "../../core/stores/uiStore";
import type { AppNode, NodeKind } from "../../core/types";
import { fileToDataUrl } from "../../core/utils";
import { NODE_CATALOG } from "./nodeCatalog";
import { AddNodeMenu } from "./AddNodeMenu";
import { IcFit, IcLogo, IcPlus, IcMin, IcUndo, IcRedo } from "../../ui/icons";

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
};

export function SmartCanvas() {
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  const onNodesChange = useBoard((s) => s.onNodesChange);
  const onEdgesChange = useBoard((s) => s.onEdgesChange);
  const onConnect = useBoard((s) => s.onConnect);
  const addNode = useBoard((s) => s.addNode);
  const duplicateNode = useBoard((s) => s.duplicateNode);
  const proximityConnect = useBoard((s) => s.proximityConnect);
  const snapshot = useBoard((s) => s.snapshot);
  const undo = useBoard((s) => s.undo);
  const redo = useBoard((s) => s.redo);
  const canUndo = useBoard((s) => s.canUndo);
  const canRedo = useBoard((s) => s.canRedo);

  const zen = useUi((s) => s.zen);
  const galleryOpen = useUi((s) => s.galleryOpen);
  const toggleZen = useUi((s) => s.toggleZen);
  const setAddMenu = useUi((s) => s.setAddMenu);
  const dockShift = galleryOpen && !zen ? 304 : 0;

  const { screenToFlowPosition, zoomIn, zoomOut, fitView } = useReactFlow();
  const [zoomPct, setZoomPct] = useState(100);
  const wrapRef = useRef<HTMLDivElement>(null);

  /* ---- 连线校验 ---- */
  const isValidConnection = useCallback((conn: Edge | Connection) => {
    const s = useBoard.getState();
    if (!conn.source || !conn.target || conn.source === conn.target) return false;
    const src = s.nodes.find((n) => n.id === conn.source);
    if (!src) return false;
    const pt = outPortType(src.type as NodeKind);
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
      const pt = outPortType(state.fromNode.type as NodeKind);
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

  /* ---- 拖放：图片文件 / 坞上的节点 ---- */
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const kind = e.dataTransfer.getData("momo/node-kind") as NodeKind | "";
      if (kind) {
        addNode(kind, pos);
        return;
      }
      const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/"));
      for (let i = 0; i < files.length; i++) {
        const src = await fileToDataUrl(files[i]);
        addNode("image", { x: pos.x + i * 36, y: pos.y + i * 36 }, { src, name: files[i].name, status: "done" });
      }
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

  /* ---- 快捷键 ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable))
        return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Tab") {
        e.preventDefault();
        toggleZen();
      } else if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((mod && e.key.toLowerCase() === "y") || (mod && e.shiftKey && e.key.toLowerCase() === "z")) {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        for (const n of useBoard.getState().nodes.filter((n) => n.selected)) duplicateNode(n.id);
      } else if (e.key.toLowerCase() === "f" && !mod) {
        void fitView({ duration: 300, padding: 0.15, maxZoom: 1 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleZen, duplicateNode, fitView, undo, redo]);

  /* ---- 坞点击添加（画布中心偏移） ---- */
  const addAtCenter = (kind: NodeKind) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const cx = (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2;
    const cy = (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2;
    const pos = screenToFlowPosition({ x: cx + (Math.random() - 0.5) * 80, y: cy + (Math.random() - 0.5) * 60 });
    addNode(kind, pos);
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
    },
    [proximityConnect],
  );

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
        onNodeDragStart={() => snapshot()}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        isValidConnection={isValidConnection}
        connectionRadius={36}
        proOptions={{ hideAttribution: true }}
        minZoom={0.15}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
        panOnDrag={[1, 2]}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panActivationKeyCode="Space"
        zoomOnDoubleClick={false}
        deleteKeyCode={["Delete", "Backspace"]}
        multiSelectionKeyCode={["Shift", "Control"]}
        onMove={(_, vp) => setZoomPct(Math.round(vp.zoom * 100))}
        onMoveEnd={(_, vp) => setZoomPct(Math.round(vp.zoom * 100))}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} color="var(--dot)" />
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
            <kbd>拖入图片</kbd> <kbd>Ctrl+V 粘贴</kbd> <kbd>中/右键 平移</kbd> <kbd>滚轮 缩放</kbd> <kbd>Tab 沉浸</kbd>
            <br />
            把节点拖到另一个节点旁边（或直接叠上去）松手，会自动连线
          </p>
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
                  title={`${i.desc}（点击添加，或拖到画布任意位置）`}
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
            title="适应全部 (F)"
            onClick={() => void fitView({ duration: 300, padding: 0.15, maxZoom: 1 })}
          >
            <IcFit size={17} />
          </button>
        </div>
      ) : null}

      {!zen ? <GenConfigPanel /> : null}

      <AddNodeMenu />
    </div>
  );
}
