/**
 * 导演台·3D 导演台 — three.js 实时 3D 站位（复刻 LibLib 三体导演台交互）
 *
 * 布局（对照 LibLib 三体导演台）：
 *  - 中央全幅 3D 视口（暗色舞台 + 网格 + 木偶人 + 变换 gizmo）
 *  - 左侧：图标栏（实体/角色/机位/光源/导出）+ 添加面板（角色预设/群众/几何模型/本地上传）
 *  - 顶部中央：导演视角 / 机位视角 切换
 *  - 右上角：轴向指示器 + 重置视角
 *  - 右侧：角色属性面板（属性/姿势两个页签）
 *  - 底部：变换模式工具条 + 语音输入 + AI 场景描述输入框
 *
 * 数据：实体存 project.threedEntities（types.ts PrevizEntity，3D 字段可选，旧 2D 数据自动映射）。
 */
import { MotionPanel } from "./threed/MotionPanel";
import { motionFrame, putMotionKey, sampleMotion } from "../../core/previzMotion";
import * as THREE from "three";
import { stageFrame } from "./threed/stageFraming";
import { createScenePreset, SCENE_PRESETS } from "./threed/scenePresets";
import { useBoard } from "../../core/stores/boardStore";
import { useDirectorCtx } from "../../core/directorContext";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import "./ds3d.css";
import { useDirector } from "../../core/stores/directorStore";
import { useAssets } from "../../core/stores/assetStore";
import { resolveModelCard } from "../../core/stores/settingsStore";
import { toast } from "../../core/stores/uiStore";
import { uid, errMsg } from "../../core/utils";
import { chatOnce } from "../../core/services/llm";
import { transcribe } from "../../core/services/asr";
import { StageEngine, type GizmoMode, type ViewMode, type AxisInfo } from "./threed/stageEngine";
import { BODY_PRESETS, PROP_PRESETS, POSE_PRESETS, JOINT_LABEL, entityPos, entityRotY, type JointName } from "./threed/mannequin";
import {
  IcCopy, IcBox, IcBulb, IcCamera, IcChevronD, IcClose, IcCursor, IcDownload, IcLayers, IcLoading,
  IcMic, IcMove, IcPerson, IcPlus, IcPose, IcRefresh, IcRotate, IcSend, IcTrash, IcUpload,
} from "../../ui/icons";
import type { DirectorProject, PrevizEntity } from "../../core/types";

/* ---------- 常量 ---------- */

const KIND_LABEL: Record<PrevizEntity["kind"], string> = {
  character: "角色",
  camera: "机位",
  light: "光源",
  prop: "道具",
};

const CROWD_PRESETS = [
  { key: "crowd33", label: "群众 3×3（9 人）" },
  { key: "crowd22", label: "小组 2×2（4 人）" },
  { key: "crowdLine", label: "一字队列（5 人）" },
];

const PALETTE = ["#4F8EF7", "#3FB56A", "#E25A8A", "#8A5CF6", "#E0A228", "#3FC5C9"];

/** 默认场景：一个角色 + 主摄影机 + 主光（对齐三体导演台开箱形态） */
function defaultEntities(): PrevizEntity[] {
  return [
    {
      id: uid(6), kind: "character", name: "角色A", preset: "male", appearance: "costume",
      x: 50, y: 50, angle: 0, color: "#4F8EF7",
      pos: [0, 0, 0], rotDeg: [0, 0, 0], scale3: [1, 1, 1],
    },
    {
      id: uid(6), kind: "camera", name: "主摄影机",
      x: 50, y: 85, angle: 0, color: "#E0A228",
      pos: [0, 1.6, 6.5], rotDeg: [0, 180, 0], scale3: [1, 1, 1],
    },
    {
      id: uid(6), kind: "light", name: "主光",
      x: 62, y: 40, angle: 0, color: "#FFF1D6",
      pos: [2.5, 3, 2], rotDeg: [0, 0, 0], scale3: [1, 1, 1], intensity: 26,
    },
  ];
}

/** 由 3D 字段反推旧 2D 坐标（保持旧字段一致，其它读取方不错乱） */
function legacyXY(pos: [number, number, number], rotY: number): { x: number; y: number; angle: number } {
  return {
    x: Math.round(50 + pos[0] / 0.24),
    y: Math.round(50 + pos[2] / 0.24),
    angle: Math.round(((180 - rotY) % 360 + 360) % 360),
  };
}

/* ---------- 主组件 ---------- */

/** 机位预设：相对拍摄主体的偏移与朝向（影片站位参考：一键摆机位 → 取景 → 导出站位图） */
const CAM_PRESETS: { key: string; label: string; off: [number, number, number]; rotY: number }[] = [
  { key: "wide", label: "全景", off: [0, 2.4, 11], rotY: 180 },
  { key: "medium", label: "中景", off: [0, 1.7, 5.5], rotY: 180 },
  { key: "close", label: "特写", off: [0, 1.5, 2.1], rotY: 180 },
  { key: "front", label: "正打", off: [0, 1.6, 4], rotY: 180 },
  { key: "reverse", label: "反打", off: [0, 1.6, -4], rotY: 0 },
  { key: "side", label: "侧面", off: [6, 1.6, 0], rotY: -90 },
  { key: "top", label: "俯拍", off: [0, 8.5, 1.4], rotY: 180 },
];

export function ThreeDPage({ project }: { project: DirectorProject }) {
  return <ThreeDWorkspace key={project.id} project={project} />;
}

function ThreeDWorkspace({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  const entities: PrevizEntity[] = useMemo(() => project.threedEntities ?? [], [project.threedEntities]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<StageEngine | null>(null);
  const entitiesRef = useRef(entities);
  entitiesRef.current = entities;

  const [motionTime,setMotionTime]=useState(0);
  const motionTimeRef=useRef(0);motionTimeRef.current=motionTime;
  const [motionOpen,setMotionOpen]=useState(false);
  const motionRecording=useRef(false);
  const [recording,setRecording]=useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const selIdRef = useRef(selId);
  selIdRef.current = selId;
  const [viewMode, setViewMode] = useState<ViewMode>("director");
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>("translate");
  const [railPanel, setRailPanel] = useState<"entities" | "character" | "export" | "camPreset" | "scene" | null>("scene");
  const [liveTick, setLiveTick] = useState(0);
  const [snap, setSnap] = useState(false);
  const history = useRef<{ undo: PrevizEntity[][]; redo: PrevizEntity[][] }>({ undo: [], redo: [] });
  const currentSegmentId = useDirectorCtx(s => s.segId);
  const currentSegment = project.scenes.flatMap(s => s.segments).find(s => s.id === currentSegmentId);
  const [historyTick, setHistoryTick] = useState(0);
  void historyTick;

  const labelRefs = useRef(new Map<string, HTMLDivElement>());
  const axisRef = useRef<AxisGizmoHandle>(null);

  /* 首次打开播种默认场景（undefined = 从未初始化；[] = 用户删光了，尊重） */
  useEffect(() => {
    if (project.threedEntities === undefined) {
      updateProject(project.id, { threedEntities: defaultEntities() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const setEntities = (next: PrevizEntity[]) => {
    if(motionRecording.current)return;
    history.current.undo = [...history.current.undo.slice(-39), entitiesRef.current];
    history.current.redo = [];
    entitiesRef.current = next;
    updateProject(project.id, { threedEntities: next });
    setHistoryTick(n => n + 1);
  };
  const travel = (direction: "undo" | "redo") => {
    if(motionRecording.current)return;
    const value = history.current[direction].pop(); if (!value) return;
    history.current[direction === "undo" ? "redo" : "undo"].push(entitiesRef.current);
    entitiesRef.current = value;
    updateProject(project.id, { threedEntities: value });
    setHistoryTick(n => n + 1);
  };

  const updateEntity = (id: string, patch: Partial<PrevizEntity>) => {
    setEntities(entitiesRef.current.map((e) => {
      if(e.id!==id)return e;
      if((motionTimeRef.current>0 || e.motion?.length) && (patch.pos||patch.rotDeg||patch.scale3)){
        const frame=motionFrame(e,motionTimeRef.current);
        return putMotionKey({...e,...patch,pos:e.pos,rotDeg:e.rotDeg,scale3:e.scale3,x:e.x,y:e.y,angle:e.angle}, {...frame,pos:patch.pos??frame.pos,rotDeg:patch.rotDeg??frame.rotDeg,scale3:patch.scale3??frame.scale3});
      }
      return {...e,...patch};
    }));
  };

  /* 引擎生命周期 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new StageEngine(canvas, {
      onPick: (id) => setSelId(id),
      onTransformCommit: (id, t) => {
        const legacy = legacyXY(t.pos, t.rotDeg[1]);
        updateEntity(id, { pos: t.pos, rotDeg: t.rotDeg, scale3: t.scale, ...legacy });
      },
      onTransformLive: () => setLiveTick((n) => n + 1),
      onFrame: (labels, axes) => {
        for (const l of labels) {
          const el = labelRefs.current.get(l.id);
          if (el) {
            el.style.transform = `translate(-50%, -100%) translate(${l.x}px, ${l.y}px)`;
            el.style.opacity = l.visible ? "1" : "0";
          }
        }
        axisRef.current?.setAxes(axes);
      },
      onError: (msg) => toast(msg, "err"),
    });
    engineRef.current = engine;
    engine.syncEntities(entitiesRef.current);
    return () => {
      engineRef.current = null;
      engine.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 数据 → 引擎同步 */
  useEffect(() => {
    engineRef.current?.syncEntities(sampleMotion(entities,motionTime));
  }, [entities,motionTime]);
  useEffect(()=>{engineRef.current?.setMotionTrails(motionOpen?entities:[]);},[entities,motionOpen]);
  useEffect(() => {
    engineRef.current?.setSelected(selId);
  }, [selId, entities.length]);
  useEffect(() => {
    engineRef.current?.setGizmoMode(gizmoMode);
  }, [gizmoMode]);
  useEffect(() => { engineRef.current?.setSnap(snap); }, [snap]);

  const selectedEntity = entities.find((e) => e.id === selId);
  const sel = selectedEntity ? sampleMotion([selectedEntity],motionTime)[0] : null;

  /* ---------- 实体操作 ---------- */
  const addScene = (kind: typeof SCENE_PRESETS[number]["id"]) => {
    const existing = entitiesRef.current;
    const offset = existing.length ? Math.max(...existing.map(e => entityPos(e)[0])) + 7 : 0;
    const next = createScenePreset(kind, () => uid(8), offset);
    setEntities([...existing, ...next]);
    const camera = next.find(e => e.kind === "camera")!;
    setSelId(camera.id);
    engineRef.current?.syncEntities([...existing, ...next]);
    engineRef.current?.setSelected(camera.id);
    switchView("camera");
    toast("场景已添加，原场景保留；可撤销整套模板", "ok");
  };

  const spawnPos = (): [number, number, number] => {
    // 新实体放在原点附近的空位（按数量错开，避免叠在一起）
    const n = entitiesRef.current.length;
    const r = 1.2 + (n % 4) * 0.9;
    const a = (n * 2.4) % (Math.PI * 2);
    return [Math.round(Math.cos(a) * r * 10) / 10, 0, Math.round(Math.sin(a) * r * 10) / 10];
  };

  const addEntity = (kind: PrevizEntity["kind"], preset: string | undefined, name: string) => {
    const sp = spawnPos();
    const pos: [number, number, number] = kind === "camera" ? [sp[0], 1.6, sp[2] + 2] : kind === "light" ? [sp[0], 2.6, sp[2]] : sp;
    const rotY = kind === "camera" ? 180 : 0;
    const e: PrevizEntity = {
      id: uid(6),
      kind,
      name,
      preset,
      ...(kind === "character" ? { appearance: "costume" as const } : {}),
      color: kind === "camera" ? "#E0A228" : kind === "light" ? "#FFF1D6" : PALETTE[entitiesRef.current.length % PALETTE.length],
      ...legacyXY(pos, rotY),
      pos,
      rotDeg: [0, rotY, 0],
      scale3: [1, 1, 1],
      ...(kind === "light" ? { intensity: 26 } : {}),
    };
    setEntities([...entitiesRef.current, e]);
    setSelId(e.id);
    toast(`已添加「${name}」`, "ok");
  };

  const removeEntity = (id: string) => {
    const e = entitiesRef.current.find((x) => x.id === id);
    setEntities(entitiesRef.current.filter((x) => x.id !== id));
    if (selId === id) setSelId(null);
    if (e) toast(`已删除「${e.name}」`, "info");
  };

  /** 本地上传 GLB/GLTF：落资产库换持久地址 */
  const uploadModel = async (f: File) => {
    try {
      const item = await useAssets.getState().importFileGetItem(f);
      if (!item) throw new Error("文件入库失败");
      const pos = spawnPos();
      const e: PrevizEntity = {
        id: uid(6), kind: "prop", name: f.name.replace(/\.(glb|gltf)$/i, ""), preset: "glb",
        color: "#9AA7BD",
        ...legacyXY(pos, 0),
        pos,
        rotDeg: [0, 0, 0],
        scale3: [1, 1, 1],
        modelAssetPath: item.path,
      };
      setEntities([...entitiesRef.current, e]);
      setSelId(e.id);
      toast(`模型「${e.name}」已导入`, "ok");
    } catch (err) {
      toast(`模型导入失败：${errMsg(err)}`, "err");
    }
  };

  /* ---------- 视角 ---------- */

  const switchView = (m: ViewMode) => {
    setViewMode(m);
    engineRef.current?.setViewMode(m);
  };

  /** 机位预设：相对拍摄主体（第一个角色实体，没有则原点）的偏移与朝向——影片站位参考的核心动作 */
  const applyCamPreset = (p: (typeof CAM_PRESETS)[number]) => {
    const subj = entitiesRef.current.find(e => e.id === selId && e.kind === "character") ?? entitiesRef.current.find((e) => e.kind === "character");
    const base = subj?.pos ?? ([0, 0, 0] as [number, number, number]);
    const pos: [number, number, number] = [base[0] + p.off[0], base[1] + p.off[1], base[2] + p.off[2]];
    const aim = new THREE.Object3D(); aim.position.fromArray(pos);
    aim.lookAt(new THREE.Vector3(base[0], base[1] + (p.key === "wide" ? 0.9 : 1.3), base[2]));
    const rotDeg: [number, number, number] = [aim.rotation.x, aim.rotation.y, aim.rotation.z].map(THREE.MathUtils.radToDeg) as [number, number, number];
    const cam = entitiesRef.current.find(e => e.id === selId && e.kind === "camera") ?? entitiesRef.current.find((e) => e.kind === "camera");
    if (cam) {
      setEntities(
        entitiesRef.current.map((e) =>
          e.id === cam.id ? { ...e, pos, rotDeg, ...legacyXY(pos, rotDeg[1]) } : e,
        ),
      );
      setSelId(cam.id);
    } else {
      const e: PrevizEntity = {
        id: uid(6),
        kind: "camera",
        name: `机位·${p.label}`,
        preset: undefined,
        color: "#E0A228",
        ...legacyXY(pos, rotDeg[1]),
        pos,
        rotDeg,
        scale3: [1, 1, 1],
      };
      setEntities([...entitiesRef.current, e]);
      setSelId(e.id);
    }
    setRailPanel(null);
    switchView("camera");
    toast(`已应用机位「${p.label}」（切到取景视角）`, "ok");
  };

  /* ---------- 导出 ---------- */

  const doExport = async (kind: "image" | "depth" | "segment", destination: "assets" | "canvas" | "shot" = "assets") => {
    const engine = engineRef.current;
    if (!engine) return;
    const label = kind === "image" ? "站位图" : kind === "depth" ? "深度参考图" : "分区参考图";
    try {
      const dataUrl =
        kind === "image" ? engine.exportImage(viewMode === "camera" ? project.aspect : undefined) : kind === "depth" ? engine.exportDepth(viewMode === "camera" ? project.aspect : undefined) : engine.exportSegment((id) => entitiesRef.current.find((e) => e.id === id)?.color ?? "#888888", viewMode === "camera" ? project.aspect : undefined);
      const asset = await useAssets.getState().collect({
        src: dataUrl,
        kind: "image",
        prompt: `${project.name} 3D ${label}`,
        model: "3D 导演台导出",
      });
      if (!asset) throw new Error("参考图未能保存到资产库");
      if (destination === "canvas") {
        const state = useBoard.getState();
        if (state.activeId !== project.boardId) throw new Error("参考图已入库，请切回项目所在画布再发送");
        const anchor = state.nodes.find(n => n.id === project.nodeId);
        state.addNode("image", { x: (anchor?.position.x ?? 0) + 400, y: anchor?.position.y ?? 0 }, { src: dataUrl, status: "done", name: `${project.name} · 3D ${label}` });
      }
      if (destination === "shot") {
        const fresh = useDirector.getState().getById(project.id)?.scenes.flatMap(s => s.segments).find(s => s.id === currentSegmentId);
        if (!fresh) throw new Error("请先在分镜列表选中本项目的片段，参考图已保存在资产库");
        useDirector.getState().patchSegment(project.id, fresh.id, { slots: [...(fresh.slots ?? []), { semantic: "layoutGuide", assetIds: [asset.id], auto: false, referenceRole: "spatialLayout", label: "3D 站位参考" }] });
      }
      toast(`${destination === "shot" ? "已送入当前分镜；" : destination === "canvas" ? "已送到画布；" : ""}${label}已导出到资产库${asset ? `（${asset.name}）` : ""}`, "ok");
    } catch (e) {
      toast(`${label}导出失败：${errMsg(e)}`, "err");
    }
  };

  /* ---------- 渲染 ---------- */

  return (
    <div className={`ds3d${recording?" recording":""}`} tabIndex={-1} onKeyDown={e => {
      if(motionRecording.current)return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "z") { e.preventDefault(); e.stopPropagation(); travel(e.shiftKey ? "redo" : "undo"); }
      if (key === "f") { e.preventDefault(); e.stopPropagation(); switchView("director"); engineRef.current?.focusEntity(selId ?? undefined); }
      if (!e.ctrlKey && !e.metaKey && ['w', 'e', 'r'].includes(key)) { e.preventDefault(); e.stopPropagation(); setGizmoMode(key === 'w' ? 'translate' : key === 'e' ? 'rotate' : 'scale'); }
    }}>
      <canvas ref={canvasRef} className="ds3d-canvas nodrag" tabIndex={0} aria-label="3D 场景，W 移动、E 旋转、R 缩放、F 聚焦" />

      {/* 名牌层（位置由引擎每帧直改 DOM） */}
      <div className="ds3d-labels">
        {entities.map((e) => (
          <div
            key={e.id}
            ref={(el) => {
              if (el) labelRefs.current.set(e.id, el);
              else labelRefs.current.delete(e.id);
            }}
            className={`ds3d-label ${selId === e.id ? "on" : ""}`}
            onClick={() => setSelId(e.id)}
          >
            {e.name}
          </div>
        ))}
      </div>

      {/* 机位取景框 */}
      {viewMode === "camera" ? <Viewfinder aspect={project.aspect} /> : null}

      {/* 左侧：图标栏 + 面板 */}
      <div className="ds3d-rail">
        <RailBtn icon={<IcLayers size={18} />} label="实体" on={railPanel === "entities"} onClick={() => setRailPanel(railPanel === "entities" ? null : "entities")} />
        <RailBtn icon={<IcPerson size={18} />} label="角色" on={railPanel === "character"} onClick={() => setRailPanel(railPanel === "character" ? null : "character")} />
        <RailBtn
          icon={<IcCamera size={18} />}
          label="机位"
          on={railPanel === "camPreset"}
          title="机位预设：以选中角色（未选时用首个角色）为主体一键摆机位（全景/中景/特写/正打/反打/侧面/俯拍）"
          onClick={() => setRailPanel(railPanel === "camPreset" ? null : "camPreset")}
        />
        <RailBtn icon={<IcBulb size={18} />} label="光源" on={false} onClick={() => addEntity("light", undefined, `光源 ${entities.filter((x) => x.kind === "light").length + 1}`)} />
        <RailBtn icon={<IcDownload size={18} />} label="导出" on={railPanel === "export"} onClick={() => setRailPanel(railPanel === "export" ? null : "export")} />
      </div>

      <div className={`ds3d-panel left ${railPanel ? "" : "hide"}`}>
        {railPanel === "scene" ? <div className="ds3d-panel">
          <div className="ds3d-panel-title">一键场景</div>
          <div className="ds3d-scene-presets">{SCENE_PRESETS.map(p => <button key={p.id} onClick={() => addScene(p.id)}><b>{p.name}</b><small>{p.detail}</small></button>)}</div>
          <p className="ds3d-export-hint">添加到现有场景旁，自动切入新机位。人物、道具和灯光都可继续调整；撤销一次即可移除整套模板。</p>
        </div> : railPanel === "entities" ? (
          <EntityList entities={entities} selId={selId} onSelect={setSelId} onRemove={removeEntity} />
        ) : railPanel === "character" ? (
          <AddCharacterPanel onAdd={(preset, name) => addEntity(preset === "glb" ? "prop" : preset?.startsWith("crowd") ? "character" : PROP_PRESETS[preset ?? ""] ? "prop" : "character", preset, name)} onUpload={uploadModel} />
        ) : railPanel === "export" ? (
          <><ExportPanel onExport={doExport} />
          {currentSegment ? <button className="btn sm primary" onClick={() => void doExport("image", "shot")}><IcPlus size={13} /> 送入当前分镜</button> : null}
          <button className="btn sm" onClick={() => void doExport("image", "canvas")}><IcPlus size={13} /> 发送到画布</button></>
        ) : railPanel === "camPreset" ? (
          <div className="ds3d-panel">
            <div className="ds3d-panel-title">机位预设（一键摆位）</div>
            <div className="ds3d-preset-grid">
              {CAM_PRESETS.map((p) => (
                <button key={p.key} className="ds3d-preset-btn" title={`${p.label}：以选中角色（未选时用首个角色）为主体`} onClick={() => applyCamPreset(p)}>
                  {p.label}
                </button>
              ))}
            </div>
            <p className="ds3d-export-hint">
              以选中角色（未选时用首个角色）为拍摄主体：自动放置/移动摄影机并切到取景视角；摆好站位后在「导出」里生成站位图。
            </p>
          </div>
        ) : null}
      </div>

      {/* 顶部中央：视角切换 */}
      <div className="ds3d-viewseg">
        <button className={railPanel === "scene" ? "on" : ""} onClick={() => setRailPanel(railPanel === "scene" ? null : "scene")}>场景模板</button>
        <button className={viewMode === "director" ? "on" : ""} onClick={() => switchView("director")}>
          导演视角
        </button>
        <button className={viewMode === "camera" ? "on" : ""} onClick={() => switchView("camera")}>
          机位视角
        </button>
      </div>

      {/* 右上：轴向指示 + 重置视角 */}
      <div className="ds3d-axisbox">
        <AxisGizmo ref={axisRef} />
        <button className="ds3d-reset" onClick={() => { switchView("director"); engineRef.current?.resetView(); }}>
          <IcRefresh size={12} /> 重置视角
        </button>
      </div>

      {/* 右侧：属性面板 */}
      <div className="ds3d-panel right">
        {sel ? (
          <Inspector
            key={sel.id}
            entity={sel}
            engineRef={engineRef}
            liveTick={liveTick}
            onPatch={(p) => updateEntity(sel.id, p)}
            onRemove={() => removeEntity(sel.id)}
          />
        ) : (
          <div className="ds3d-insp-empty">
            <IcOrbitHint />
            <p>点击场景中的实体进行编辑</p>
            <p className="dim">拖动坐标轴移动/旋转/缩放；左键环绕，右键平移，滚轮缩放</p>
          </div>
        )}
      </div>

      <div className="ds3d-bottom-tools">
      {motionOpen && <MotionPanel project={project} entities={entities} selected={selId} time={motionTime} onTime={setMotionTime} onChange={setEntities} engine={engineRef.current} segmentId={currentSegmentId} onRecording={value=>{motionRecording.current=value;setRecording(value);}}/>}
      <div className="ds3d-quickbar">
        <button className="btn sm" onClick={()=>setMotionOpen(!motionOpen)}>关键帧与轨迹</button>
        <button className="btn sm" disabled={!history.current.undo.length} onClick={() => travel("undo")} title="Ctrl+Z">撤销</button>
        <button className="btn sm" disabled={!history.current.redo.length} onClick={() => travel("redo")}>重做</button>
        <button className="btn sm" onClick={() => { switchView("director"); engineRef.current?.focusEntity(selId ?? undefined); }} title="F 聚焦选中；未选时显示全场景"><IcCursor size={13} /> 聚焦</button>
        <button className={`btn sm ${snap ? "primary" : ""}`} onClick={() => setSnap(v => !v)} title="移动10厘米 / 旋转15度">吸附{snap ? "开" : "关"}</button>
        <button className="btn sm" disabled={!sel} onClick={() => sel && engineRef.current?.groundEntity(sel.id)}>贴地</button>
        <button className="btn sm" disabled={!sel} onClick={() => { if (!sel) return; const pos = entityPos(sel); const copy = { ...sel, id: uid(6), name: `${sel.name} 副本`, pos: [pos[0] + 1, pos[1], pos[2]] as [number, number, number] }; setEntities([...entitiesRef.current, copy]); setSelId(copy.id); }}><IcCopy size={13} /> 复制</button>
        <span>W 移动 · E 旋转 · R 缩放 · 左键环绕 / 右键平移</span>
      </div>
      </div>
      {/* 底部：模式条 + 语音 + AI 输入 */}
      <BottomBar
        gizmoMode={gizmoMode}
        onGizmo={setGizmoMode}
        entities={entities}
        onApply={(next, msg) => {
          setEntities(next);
          toast(msg, "ok");
        }}
      />
    </div>
  );
}

/** 空态提示图标（简单环绕示意） */
function IcOrbitHint() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M20.4 9.6c.7.9.8 1.8.3 2.6-1.2 1.8-4.7 3.2-8.7 3.4s-7.3-.9-7.9-2.5c-.3-.8 0-1.7.8-2.5" />
    </svg>
  );
}

/* ---------- 左栏 ---------- */

function RailBtn({ icon, label, on, onClick, title }: { icon: ReactNode; label: string; on: boolean; onClick: () => void; title?: string }) {
  return (
    <button className={`ds3d-railbtn ${on ? "on" : ""}`} title={title ?? label} aria-label={label} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function EntityList({ entities, selId, onSelect, onRemove }: { entities: PrevizEntity[]; selId: string | null; onSelect: (id: string) => void; onRemove: (id: string) => void }) {
  return (
    <>
      <div className="ds3d-panel-title">场景实体（{entities.length}）</div>
      <div className="ds3d-list">
        {entities.map((e) => (
          <div key={e.id} className={`ds3d-entity ${selId === e.id ? "on" : ""}`} onClick={() => onSelect(e.id)}>
            <span className="ds3d-dot" style={{ background: e.color }} />
            <span className="ds3d-ename">{e.name}</span>
            <span className="ds3d-ebadge">{KIND_LABEL[e.kind]}</span>
            <button
              className="ds3d-edel"
              title={`删除 ${e.name}`}
              aria-label={`删除 ${e.name}`}
              onClick={(ev) => {
                ev.stopPropagation();
                onRemove(e.id);
              }}
            >
              <IcClose size={12} />
            </button>
          </div>
        ))}
        {!entities.length ? <div className="ds3d-list-empty">还没有实体，从「角色」面板添加</div> : null}
      </div>
    </>
  );
}

function AddCharacterPanel({ onAdd, onUpload }: { onAdd: (preset: string, name: string) => void; onUpload: (f: File) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [openSub, setOpenSub] = useState<"crowd" | "geo" | null>(null);
  return (
    <>
      <div className="ds3d-panel-title">添加角色</div>
      <div className="ds3d-list">
        <button className="ds3d-addrow" onClick={() => fileRef.current?.click()}>
          <IcUpload size={15} /> 本地上传
          <span className="ds3d-addrow-hint">GLB / GLTF</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".glb,.gltf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onUpload(f);
            e.target.value = "";
          }}
        />
        {Object.entries(BODY_PRESETS).map(([key, p]) => (
          <button key={key} className="ds3d-addrow" onClick={() => onAdd(key, p.label)}>
            <IcPerson size={15} /> {p.label}
          </button>
        ))}
        {/* 群众（子菜单） */}
        <button className={`ds3d-addrow sub ${openSub === "crowd" ? "open" : ""}`} onClick={() => setOpenSub(openSub === "crowd" ? null : "crowd")}>
          <IcPerson size={15} /> 群众编队
          <IcChevronD size={13} className="ds3d-subchev" />
        </button>
        {openSub === "crowd" ? (
          <div className="ds3d-sublist">
            {CROWD_PRESETS.map((c) => (
              <button key={c.key} className="ds3d-addrow subitem" onClick={() => onAdd(c.key, c.label)}>
                {c.label}
              </button>
            ))}
          </div>
        ) : null}
        {/* 几何模型（子菜单） */}
        <button className={`ds3d-addrow sub ${openSub === "geo" ? "open" : ""}`} onClick={() => setOpenSub(openSub === "geo" ? null : "geo")}>
          <IcBox size={15} /> 几何模型
          <IcChevronD size={13} className="ds3d-subchev" />
        </button>
        {openSub === "geo" ? (
          <div className="ds3d-sublist">
            {Object.entries(PROP_PRESETS).map(([key, p]) => (
              <button key={key} className="ds3d-addrow subitem" onClick={() => onAdd(key, p.label)}>
                {p.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

function ExportPanel({ onExport }: { onExport: (k: "image" | "depth" | "segment") => void }) {
  return (
    <>
      <div className="ds3d-panel-title">导出参考图</div>
      <div className="ds3d-export">
        <button className="btn sm primary" onClick={() => onExport("image")}>
          <IcCamera size={14} /> 导出彩色站位图
        </button>
        <button className="btn sm" onClick={() => onExport("depth")} title="灰度深度参考图（近=亮，远=暗），供 ControlNet 粗略参考">
          导出深度参考图
        </button>
        <button className="btn sm" onClick={() => onExport("segment")} title="语义分区图（每个实体不同色块），供 ControlNet 分区控制">
          导出分区参考图
        </button>
        <p className="ds3d-export-hint">导出当前视角画面；深度/分区图可绑到 ComfyUI 的 layoutGuide / poseGuide 语义槽。</p>
      </div>
    </>
  );
}

/* ---------- 右上轴向指示器 ---------- */

type AxisGizmoHandle = { setAxes: (a: AxisInfo) => void };

const AxisGizmo = forwardRef<AxisGizmoHandle>(function AxisGizmo(_, ref) {
  const [axes, setAxes] = useState<AxisInfo>({ x: [1, 0], y: [0, 1], z: [0, 0], zBack: false });
  useImperativeHandle(ref, () => ({ setAxes }), []);
  const R = 30;
  return (
    <svg className="ds3d-axis" width="76" height="76" viewBox="-40 -40 80 80" aria-hidden>
      <circle r="34" className="ds3d-axis-bg" />
      <line x1="0" y1="0" x2={axes.x[0] * R} y2={-axes.x[1] * R} stroke="#F2555A" strokeWidth="1.4" opacity="0.85" />
      <line x1="0" y1="0" x2={axes.y[0] * R} y2={-axes.y[1] * R} stroke="#3FD68F" strokeWidth="1.4" opacity="0.85" />
      <line x1="0" y1="0" x2={axes.z[0] * R} y2={-axes.z[1] * R} stroke="#4F8EF7" strokeWidth="1.4" opacity="0.85" />
      <circle cx={axes.x[0] * R} cy={-axes.x[1] * R} r="4.5" fill="#F2555A" />
      <circle cx={axes.y[0] * R} cy={-axes.y[1] * R} r="4.5" fill="#3FD68F" />
      <circle cx={axes.z[0] * R} cy={-axes.z[1] * R} r="4.5" fill="#4F8EF7" opacity={axes.zBack ? 0.45 : 1} />
      <text x={axes.x[0] * (R + 9)} y={-axes.x[1] * (R + 9) + 3} fill="#F2555A">X</text>
      <text x={axes.y[0] * (R + 9)} y={-axes.y[1] * (R + 9) + 3} fill="#3FD68F">Y</text>
      <text x={axes.z[0] * (R + 9)} y={-axes.z[1] * (R + 9) + 3} fill="#4F8EF7">Z</text>
      <circle r="2" fill="var(--d3-text-3)" />
    </svg>
  );
});

/* ---------- 机位取景框 ---------- */

function Viewfinder({ aspect }: { aspect: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const update = () => setSize(stageFrame(el.clientWidth, el.clientHeight, aspect));
    const observer = new ResizeObserver(update); observer.observe(el); update();
    return () => observer.disconnect();
  }, [aspect]);
  return (
    <div className="ds3d-vf" ref={ref}>
      <div className="ds3d-vf-frame" style={{ width: size.w, height: size.h }}>
        <i className="ds3d-vf-cross" />
        <span className="ds3d-vf-tag">机位视角 · {aspect}</span>
      </div>
    </div>
  );
}

/* ---------- 右侧属性检查器 ---------- */

function Inspector({ entity, engineRef, liveTick, onPatch, onRemove }: {
  entity: PrevizEntity;
  engineRef: React.RefObject<StageEngine | null>;
  liveTick: number;
  onPatch: (p: Partial<PrevizEntity>) => void;
  onRemove: () => void;
}) {
  const [tab, setTab] = useState<"attr" | "pose">("attr");
  const isChar = entity.kind === "character" && !entity.preset?.startsWith("crowd");
  // gizmo 拖动中 store 不回写（松手才提交），面板数值改读引擎实时变换
  void liveTick;
  const live = engineRef.current?.peekLiveTransform(entity.id);
  const pos = live?.pos ?? entityPos(entity);
  const rot: [number, number, number] = live?.rotDeg ?? [entity.rotDeg?.[0] ?? 0, entityRotY(entity), entity.rotDeg?.[2] ?? 0];
  const scl = live?.scale ?? entity.scale3 ?? [1, 1, 1];

  const setPos = (i: number, v: number) => {
    const next: [number, number, number] = [...pos];
    next[i] = v;
    onPatch({ pos: next, ...legacyXY(next, rot[1]) });
  };
  const setRot = (i: number, v: number) => {
    const next: [number, number, number] = [...rot];
    next[i] = v;
    onPatch({ rotDeg: next, ...legacyXY(pos, next[1]) });
  };
  const setScale = (i: number, v: number) => {
    const next: [number, number, number] = [...scl];
    next[i] = Math.max(0.05, v);
    onPatch({ scale3: next });
  };
  const uniform = scl[0];

  return (
    <>
      <div className="ds3d-panel-title">
        {KIND_LABEL[entity.kind]}
        <span className="ds3d-panel-sub">{entity.name}</span>
      </div>
      <div className="ds3d-tabs">
        <button className={tab === "attr" ? "on" : ""} onClick={() => setTab("attr")}>
          属性
        </button>
        {isChar ? (
          <button className={tab === "pose" ? "on" : ""} onClick={() => setTab("pose")}>
            姿势
          </button>
        ) : null}
      </div>

      {tab === "attr" ? (
        <div className="ds3d-insp">
          <label className="ds3d-field">
            <span>名称</span>
            <input className="input sm nodrag" value={entity.name} onChange={(e) => onPatch({ name: e.target.value })} />
          </label>
          {isChar ? <div className="ds3d-preset-grid" role="group" aria-label="人物风格">
            {([['mannequin', '素模'], ['clay', '哑光'], ['costume', '服装']] as const).map(([appearance, label]) => <button key={appearance} className={`ds3d-preset-btn ${(entity.appearance ?? 'mannequin') === appearance ? 'on' : ''}`} onClick={() => onPatch({ appearance })}>{label}</button>)}
          </div> : null}
          <Vec3Field label="位置" value={pos} onChange={setPos} step={0.1} />
          <Vec3Field label="旋转" value={rot} onChange={setRot} step={5} />
          <Vec3Field label="缩放" value={scl} onChange={setScale} step={0.05} />
          <label className="ds3d-field">
            <span>统一缩放</span>
            <span className="ds3d-sliderow">
              <input
                className="nodrag"
                type="range"
                min={0.2}
                max={3}
                step={0.01}
                value={uniform}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  onPatch({ scale3: [v, v, v] });
                }}
              />
              <b>{uniform.toFixed(2)}</b>
            </span>
          </label>
          <label className="ds3d-field">
            <span>颜色</span>
            <span className="ds3d-colorrow">
              <input
                type="color"
                className="nodrag"
                value={entity.color}
                onChange={(e) => onPatch({ color: e.target.value.toUpperCase() })}
                aria-label="实体颜色"
              />
              <input
                className="input sm nodrag"
                value={entity.color}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (/^#[0-9a-fA-F]{6}$/.test(v)) onPatch({ color: v.toUpperCase() });
                  else onPatch({ color: v });
                }}
              />
            </span>
          </label>
          {entity.kind === "light" ? (
            <label className="ds3d-field">
              <span>强度</span>
              <span className="ds3d-sliderow">
                <input
                  className="nodrag"
                  type="range"
                  min={0}
                  max={120}
                  step={1}
                  value={entity.intensity ?? 26}
                  onChange={(e) => onPatch({ intensity: Number(e.target.value) })}
                />
                <b>{entity.intensity ?? 26}</b>
              </span>
            </label>
          ) : null}
          <button className="btn sm danger ds3d-del" onClick={onRemove}>
            <IcTrash size={13} /> 删除实体
          </button>
        </div>
      ) : (
        <PosePanel entity={entity} onPatch={onPatch} />
      )}
    </>
  );
}

/** 三轴数值行（位置/旋转/缩放共用） */
function Vec3Field({ label, value, onChange, step }: { label: string; value: [number, number, number]; onChange: (i: number, v: number) => void; step: number }) {
  return (
    <div className="ds3d-field">
      <span>{label}</span>
      <div className="ds3d-vec3">
        {(["X", "Y", "Z"] as const).map((axis, i) => (
          <NumField
            key={axis}
            axis={axis}
            value={value[i]}
            step={step}
            onCommit={(v) => onChange(i, v)}
          />
        ))}
      </div>
    </div>
  );
}

/** 数值输入：本地草稿态，失焦/回车提交（避免受控输入打断键入） */
function NumField({ axis, value, step, onCommit }: { axis: string; value: number; step: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className={`ds3d-num ax-${axis.toLowerCase()}`}>
      <em>{axis}</em>
      <input
        className="nodrag"
        type="number"
        step={step}
        value={draft ?? Math.round(value * 100) / 100}
        onFocus={(e) => setDraft(e.target.value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onCommit(v);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

/** 姿势页签：预设 + 关节微调 */
function PosePanel({ entity, onPatch }: { entity: PrevizEntity; onPatch: (p: Partial<PrevizEntity>) => void }) {
  const pose = entity.pose ?? {};
  const setJoint = (j: JointName, axis: 0 | 1 | 2, v: number) => {
    const cur = pose[j] ?? [0, 0, 0];
    const next: [number, number, number] = [...cur];
    next[axis] = v;
    onPatch({ pose: { ...pose, [j]: next } });
  };
  return (
    <div className="ds3d-insp">
      <div className="ds3d-poses">
        {POSE_PRESETS.map((p) => (
          <button key={p.key} className="ds3d-posebtn" onClick={() => onPatch({ pose: p.pose as Record<string, [number, number, number]> })}>
            <IcPose size={14} />
            {p.label}
          </button>
        ))}
      </div>
      <button className="btn sm" onClick={() => onPatch({ pose: {} })}>
        重置姿势
      </button>
      <div className="ds3d-joints">
        {(Object.keys(JOINT_LABEL) as JointName[]).map((j) => (
          <div key={j} className="ds3d-joint">
            <span className="ds3d-jname">{JOINT_LABEL[j]}</span>
            <label>
              <em>前俯</em>
              <input
                className="nodrag"
                type="range"
                min={-120}
                max={120}
                step={1}
                value={pose[j]?.[0] ?? 0}
                onChange={(e) => setJoint(j, 0, Number(e.target.value))}
              />
              <b>{pose[j]?.[0] ?? 0}°</b>
            </label>
            {j === "shoulderL" || j === "shoulderR" ? (
              <label>
                <em>侧展</em>
                <input
                  className="nodrag"
                  type="range"
                  min={-170}
                  max={170}
                  step={1}
                  value={pose[j]?.[2] ?? 0}
                  onChange={(e) => setJoint(j, 2, Number(e.target.value))}
                />
                <b>{pose[j]?.[2] ?? 0}°</b>
              </label>
            ) : null}
            {j === "neck" || j === "chest" || j === "waist" ? (
              <label>
                <em>扭转</em>
                <input
                  className="nodrag"
                  type="range"
                  min={-90}
                  max={90}
                  step={1}
                  value={pose[j]?.[1] ?? 0}
                  onChange={(e) => setJoint(j, 1, Number(e.target.value))}
                />
                <b>{pose[j]?.[1] ?? 0}°</b>
              </label>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- 底部：变换模式 + 语音 + AI 场景描述 ---------- */

function BottomBar({ gizmoMode, onGizmo, entities, onApply }: {
  gizmoMode: GizmoMode;
  onGizmo: (m: GizmoMode) => void;
  entities: PrevizEntity[];
  onApply: (next: PrevizEntity[], msg: string) => void;
}) {
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  /* 组件卸载时停掉未结束的录音（切页签不泄漏麦克风） */
  useEffect(() => {
    return () => {
      if (recRef.current && recRef.current.state !== "inactive") {
        recRef.current.onstop = null; // 卸载后不再识别
        recRef.current.stop();
        recRef.current.stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  /** 语音输入：点一下开始录，再点一下停止并识别 */
  const toggleRecord = async () => {
    if (recording) {
      recRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 800) return; // 太短视为误触
        try {
          const card = resolveModelCard("asr");
          const text = await transcribe(card, { audio: blob, lang: "zh", hint: "3D 导演台场景搭建指令，角色、位置、颜色" });
          if (text) setAiText((prev) => (prev ? `${prev} ${text}` : text));
          else toast("没有识别到语音内容", "info");
        } catch (e) {
          toast(`语音识别失败：${errMsg(e)}`, "err");
        }
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      toast(`无法打开麦克风：${errMsg(e)}`, "err");
    }
  };

  /** AI 场景搭建：自然语言 → JSON 操作 → 应用 */
  const runAi = async () => {
    const text = aiText.trim();
    if (!text || aiBusy) return;
    setAiBusy(true);
    try {
      const card = resolveModelCard("chat");
      const sys = `你是 3D 导演台的布景助手。根据用户的自然语言描述，输出严格的 JSON（不要输出任何其他文字或解释）：
{"ops":[{"op":"add","preset":"预设","name":"显示名","x":0,"z":0,"rotY":0,"color":"#4F8EF7"},{"op":"move","name":"现有实体名","x":0,"z":0,"rotY":0},{"op":"remove","name":"实体名"},{"op":"clear"}]}
可用 preset：male 标准男性 / female 标准女性 / strong 健硕 / slim 纤细 / teen 少年 / child 儿童 / wide 宽厚 / chibi 二头身 / crowd33 群众3x3 / crowd22 群众2x2 / crowdLine 一字队列 / box 立方体 / sphere 球体 / cylinder 圆柱 / cone 圆锥 / torus 圆环 / capsule 胶囊。
规则：x/z 是地面坐标（米，-10 到 10）；rotY 是朝向角（度）；color 用十六进制；位置不要重叠（人与人至少间隔 0.8 米）；只输出 JSON。`;
      const user = `当前场景实体：${entities.map((e) => `${e.name}(${e.kind}${e.preset ? `/${e.preset}` : ""})`).join("、") || "（空）"}\n用户要求：${text}`;
      const raw = await chatOnce(card, sys, user);
      const m = raw.replace(/```(?:json)?/g, "").match(/\{[\s\S]*\}/);
      if (!m) throw new Error("模型没有返回有效 JSON");
      const parsed = JSON.parse(m[0]) as { ops?: Array<Record<string, unknown>> };
      const ops = parsed.ops;
      if (!Array.isArray(ops) || !ops.length) throw new Error("模型没有给出任何操作");

      let next = [...entities];
      let added = 0, moved = 0, removed = 0;
      const clamp = (n: unknown, d = 0) => Math.max(-10, Math.min(10, Number(n) || d));
      for (const op of ops) {
        if (op.op === "clear") {
          removed += next.filter((e) => e.kind !== "camera").length;
          next = next.filter((e) => e.kind === "camera");
        } else if (op.op === "add" && typeof op.preset === "string") {
          const isChar = !!BODY_PRESETS[op.preset] || op.preset.startsWith("crowd");
          const pos: [number, number, number] = [clamp(op.x), 0, clamp(op.z)];
          const rotY = Number(op.rotY) || 0;
          next.push({
            id: uid(6),
            kind: isChar ? "character" : "prop",
            name: typeof op.name === "string" && op.name.trim() ? op.name.trim() : `实体 ${next.length + 1}`,
            preset: op.preset,
            color: typeof op.color === "string" && /^#[0-9a-f]{6}$/i.test(op.color) ? op.color.toUpperCase() : PALETTE[next.length % PALETTE.length],
            ...legacyXY(pos, rotY),
            pos,
            rotDeg: [0, rotY, 0],
            scale3: [1, 1, 1],
          });
          added++;
        } else if ((op.op === "move" || op.op === "remove") && typeof op.name === "string") {
          const idx = next.findIndex((e) => e.name === op.name || e.name.includes(op.name as string));
          if (idx < 0) continue;
          if (op.op === "remove") {
            next = next.filter((_, i) => i !== idx);
            removed++;
          } else {
            const e = next[idx];
            const old = entityPos(e);
            const pos: [number, number, number] = [
              op.x !== undefined ? clamp(op.x) : old[0],
              old[1],
              op.z !== undefined ? clamp(op.z) : old[2],
            ];
            const rotY = op.rotY !== undefined ? Number(op.rotY) || 0 : entityRotY(e);
            next[idx] = { ...e, pos, rotDeg: [0, rotY, 0], ...legacyXY(pos, rotY) };
            moved++;
          }
        }
      }
      onApply(next, `AI 布景完成：新增 ${added} · 移动 ${moved} · 移除 ${removed}`);
      setAiText("");
    } catch (e) {
      toast(`AI 布景失败：${errMsg(e)}`, "err");
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="ds3d-bottom">
      <div className="ds3d-modes">
        <button className={gizmoMode === "translate" ? "on" : ""} title="移动（W）" aria-label="移动模式" onClick={() => onGizmo("translate")}>
          <IcMove size={16} />
        </button>
        <button className={gizmoMode === "rotate" ? "on" : ""} title="旋转（E）" aria-label="旋转模式" onClick={() => onGizmo("rotate")}>
          <IcRotate size={16} />
        </button>
        <button className={gizmoMode === "scale" ? "on" : ""} title="缩放（R）" aria-label="缩放模式" onClick={() => onGizmo("scale")}>
          <IcCursor size={16} style={{ transform: "scale(0.9) rotate(-8deg)" }} />
        </button>
      </div>
      <button className={`ds3d-voice ${recording ? "rec" : ""}`} title={recording ? "停止录音并识别" : "语音输入场景描述"} onClick={() => void toggleRecord()}>
        <IcMic size={14} />
        {recording ? (
          <span className="ds3d-recbars" aria-hidden>
            <i /><i /><i /><i /><i />
          </span>
        ) : (
          "语音输入"
        )}
      </button>
      <div className="ds3d-ai">
        <IcPlus size={15} className="ds3d-ai-plus" />
        <input
          className="nodrag"
          placeholder="描述想搭建的场景"
          value={aiText}
          disabled={aiBusy}
          onChange={(e) => setAiText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runAi();
          }}
        />
        <button className="ds3d-ai-send" title="AI 搭建场景" aria-label="AI 搭建场景" disabled={aiBusy || !aiText.trim()} onClick={() => void runAi()}>
          {aiBusy ? <IcLoading size={14} /> : <IcSend size={14} />}
        </button>
      </div>
    </div>
  );
}
