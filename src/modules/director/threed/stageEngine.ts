import { sampleMotion } from "../../../core/previzMotion";
/**
 * 3D 导演台 · three.js 场景引擎（非 React 封装）
 *
 * React 侧只持有实体数据（project.threedEntities），本引擎做单向同步：
 *   syncEntities() 按 id diff 增删/重建/写变换；TransformControls 拖动结束时
 *   通过 onTransformCommit 一次性写回 store（拖动中不写，避免高频持久化）。
 */
import * as THREE from "three";
import { stageFrame } from "./stageFraming";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SkeletalRig } from "./skeletalRig";
import type { PrevizEntity } from "../../../core/types";
import { assetUrl } from "../../../core/services/assetFiles";
import { applyPose, buildEntity, entityPos, entityRotY, type BuiltEntity } from "./mannequin";

export type GizmoMode = "translate" | "rotate" | "scale";
export type ViewMode = "director" | "camera";

export type LabelInfo = { id: string; x: number; y: number; visible: boolean };
export type AxisInfo = { x: [number, number]; y: [number, number]; z: [number, number]; zBack: boolean };

type Callbacks = {
  /** 点击实体/空白（带位移阈值，排除环绕拖动误触） */
  onPick: (id: string | null) => void;
  /** gizmo 拖动结束，把最终变换写回 store */
  onTransformCommit: (id: string, t: { pos: [number, number, number]; rotDeg: [number, number, number]; scale: [number, number, number] }) => void;
  /** 拖动中实时回调（右面板数值跟随，不写 store） */
  onTransformLive?: () => void;
  /** 每帧回调：名牌屏幕坐标 + 轴向指示（React 用 ref 直改 DOM，不走 setState） */
  onFrame?: (labels: LabelInfo[], axes: AxisInfo) => void;
  onError?: (msg: string) => void;
};

const deg = (d: number) => (d * Math.PI) / 180;
const rad = (r: number) => (r * 180) / Math.PI;

/** 结构签名：这些字段变了才重建 three 对象（颜色/名称/变换走热更新） */
function structKey(e: PrevizEntity): string {
  return [e.kind, e.preset ?? "", e.modelAssetPath ?? "", e.appearance ?? "", e.preset?.startsWith("crowd") ? e.color : ""].join("|");
}

/** 生成径向渐变地面纹理（中央微亮的舞台光晕） */
function groundTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(256, 256, 20, 256, 256, 256);
  g.addColorStop(0, "#1c2432");
  g.addColorStop(0.45, "#11161f");
  g.addColorStop(1, "#04060a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class StageEngine {
  private rigs = new WeakMap<THREE.Object3D, SkeletalRig>();
  rigInfo(id: string) {
    const root = this.entities.get(id)?.built.root;
    const rig = root && this.rigs.get(root);
    return rig ? { bones: rig.bones.map(b=>({key:b.key,name:b.name})), clips: rig.clips.map(c=>({name:c.name,duration:c.duration})) } : {bones:[],clips:[]};
  }
  private motionTrails = new THREE.Group();
  private recording = false;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private gizmo: TransformControls;
  private raycaster = new THREE.Raycaster();
  private canvas: HTMLCanvasElement;
  private cb: Callbacks;
  private raf = 0;
  private disposed = false;

  private entities = new Map<string, { built: BuiltEntity; skey: string; poseKey: string }>();
  private loading = new Map<string, symbol>();
  private latestEntities = new Map<string, PrevizEntity>();
  private selectedId: string | null = null;
  private dragging = false;
  private viewMode: ViewMode = "director";
  private savedView = { pos: new THREE.Vector3(5.5, 3.6, 7.5), target: new THREE.Vector3(0, 1, 0) };
  /** 机位视角下被透视（隐藏）的机位实体——渲染相机架在它内部，不隐藏会糊满镜头 */
  private hiddenCamRoot: THREE.Group | null = null;
  private grid: THREE.GridHelper;
  private ground: THREE.Mesh;
  private resizeObs: ResizeObserver;
  private downAt: { x: number; y: number } | null = null;
  private gltfLoader = new GLTFLoader();
  /** GLB 模型缓存：assetPath → 已归一化的场景对象 */
  private glbCache = new Map<string, THREE.Group>();

  constructor(canvas: HTMLCanvasElement, cb: Callbacks) {
    this.canvas = canvas;
    this.cb = cb;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.scene.add(this.motionTrails);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x04060a, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.fog = new THREE.Fog(0x04060a, 20, 52);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.camera.position.copy(this.savedView.pos);

    /* 灯光：半球天光 + 顶部聚光（投影）+ 背后补光 */
    const hemi = new THREE.HemisphereLight(0x8fa3c7, 0x14181f, 0.75);
    const spot = new THREE.SpotLight(0xdfe8ff, 160, 40, 0.62, 0.65, 1.4);
    spot.position.set(2.5, 10, 3);
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.camera.near = 2;
    spot.shadow.camera.far = 30;
    spot.shadow.bias = -0.0004;
    const fill = new THREE.DirectionalLight(0x7c8fb5, 0.5);
    fill.position.set(-6, 4, -6);
    this.scene.add(hemi, spot, spot.target, fill);

    /* 地面：径向渐变圆盘 + 网格 */
    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(16, 56),
      new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95, metalness: 0 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.grid = new THREE.GridHelper(28, 28, 0x3a4760, 0x1c2431);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.55;
    this.grid.position.y = 0.002;
    this.scene.add(this.grid);

    /* 控制器 */
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.savedView.target);
    this.controls.enableDamping = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 40;

    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.85);
    // r169+：TransformControls 不再是 Object3D，要加它的 helper
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.dragging = !!e.value;
      this.controls.enabled = !e.value && this.viewMode === "director";
      if (!e.value) this.commitDrag();
    });
    this.gizmo.addEventListener("objectChange", () => this.cb.onTransformLive?.());

    /* 拾取：按下/抬起位移 < 6px 才算点击 */
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);

    /* 尺寸自适应 */
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas.parentElement ?? canvas);
    this.resize();

    this.loop();
  }

  /* ---------- 生命周期 ---------- */

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.controls.dispose();
    for (const { built } of this.entities.values()) this.disposeObject(built.root);
    this.entities.clear();
    for (const cached of this.glbCache.values()) this.disposeObject(cached);
    this.glbCache.clear();
    this.loading.clear();
    this.latestEntities.clear();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material;
        (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
      }
    });
    this.clearMotionTrails();
    this.renderer.dispose();
  }

  private disposeObject(root: THREE.Object3D) {
    this.rigs.get(root)?.dispose(); this.rigs.delete(root);
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    root.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        geometries.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          materials.add(m);
          for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
  }

  private resize() {
    const el = this.canvas.parentElement;
    if (!el) return;
    const w = el.clientWidth || 2;
    const h = el.clientHeight || 2;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* ---------- 视图 ---------- */

  setViewMode(mode: ViewMode) {
    if(this.recording)return;
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    this.motionTrails.visible=mode==="director";
    if (mode === "camera") {
      // 进入机位视角：保存导演机位
      this.savedView.pos.copy(this.camera.position);
      this.savedView.target.copy(this.controls.target);
      this.controls.enabled = false;
    } else {
      this.camera.position.copy(this.savedView.pos);
      this.controls.target.copy(this.savedView.target);
      this.controls.enabled = true;
      this.controls.update();
      this.restoreHiddenCam();
    }
    this.refreshGizmo();
  }

  /** 按当前视角/选择状态重挂 gizmo：机位视角下不给机位实体挂（被透视的机位已隐藏，挂了会糊在镜头上） */
  private refreshGizmo() {
    const rec = this.selectedId ? this.entities.get(this.selectedId) : undefined;
    if (rec && !(this.viewMode === "camera" && rec.built.root.userData.kind === "camera")) {
      this.gizmo.attach(rec.built.root);
    } else {
      this.gizmo.detach();
    }
  }

  resetView() {
    this.savedView.pos.set(5.5, 3.6, 7.5);
    this.savedView.target.set(0, 1, 0);
    if (this.viewMode === "director") {
      this.camera.position.copy(this.savedView.pos);
      this.controls.target.copy(this.savedView.target);
      this.controls.update();
    }
  }

  /** 操作吸附：移动 10 cm / 旋转 15 度 / 缩放 0.1。 */
  setSnap(enabled: boolean) {
    this.gizmo.setTranslationSnap(enabled ? 0.1 : null);
    this.gizmo.setRotationSnap(enabled ? Math.PI / 12 : null);
    this.gizmo.setScaleSnap(enabled ? 0.1 : null);
  }

  focusEntity(id?: string) {
    this.setViewMode("director");
    const box = new THREE.Box3();
    for (const [key, rec] of this.entities) if (!id || key === id) box.expandByObject(rec.built.root);
    if (box.isEmpty()) { this.resetView(); return; }
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const distance = Math.max(2, size.length() * 1.5);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0.8, 0.45, 1).normalize().multiplyScalar(distance));
    this.controls.update();
  }

  groundEntity(id: string) {
    const rec = this.entities.get(id); if (!rec) return;
    // 朝向箭头不纳入包围盒，避免把它贴地而人物仍然悬空。
    const box = new THREE.Box3();
    rec.built.root.updateMatrixWorld(true);
    rec.built.root.traverse(o => { if (o instanceof THREE.Mesh && !o.parent?.userData.groundArrow) box.expandByObject(o); });
    if (box.isEmpty()) return;
    rec.built.root.position.y -= box.min.y;
    this.selectedId = id;
    this.commitDrag();
  }

  setGizmoMode(mode: GizmoMode) {
    this.gizmo.setMode(mode);
  }

  setSelected(id: string | null) {
    this.selectedId = id;
    this.refreshGizmo();
  }

  /* ---------- 实体同步 ---------- */

  peekLiveTransform(id:string) { return this.dragging && this.selectedId===id ? this.peekTransform(id) : null; }

  syncEntities(list: PrevizEntity[]) {
    if(this.disposed)return;
    this.latestEntities = new Map(list.map(e => [e.id, e]));
    const seen = new Set<string>();
    for (const e of list) {
      seen.add(e.id);
      const skey = structKey(e);
      let rec = this.entities.get(e.id);
      if (rec && rec.skey !== skey) {
        this.loading.delete(e.id);
        // 结构变化：重建
        if (this.selectedId === e.id) this.gizmo.detach();
        // 拖动中遇到重建（如 crowd 改色触发）：detach 不会发 dragging-changed 事件，
        // dragging 会卡在 true 让后续变换同步全被跳过，必须手动复位
        if (this.dragging) this.dragging = false;
        this.scene.remove(rec.built.root);
        this.disposeObject(rec.built.root);
        this.entities.delete(e.id);
        rec = undefined;
      }
      if (!rec) {
        if (e.preset === "glb" && e.modelAssetPath) {
          this.loadGlb(e, skey);
          continue; // 异步，加载完成后自行入列
        }
        const built = buildEntity(e);
        this.scene.add(built.root);
        rec = { built, skey, poseKey: "" };
        this.entities.set(e.id, rec);
        if (this.selectedId === e.id) this.refreshGizmo();
      }
      // 变换（拖动中的实体跳过，防止面板回写打架）
      if (!(this.dragging && this.selectedId === e.id)) {
        const [px, py, pz] = entityPos(e);
        rec.built.root.position.set(px, py, pz);
        const rx = e.rotDeg?.[0] ?? 0;
        const rz = e.rotDeg?.[2] ?? 0;
        rec.built.root.rotation.set(deg(rx), deg(entityRotY(e)), deg(rz));
        const s = e.scale3 ?? [1, 1, 1];
        rec.built.root.scale.set(s[0], s[1], s[2]);
      }
      // 颜色热更新
      for (const m of rec.built.mats) {
        const mat = m as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
        if (mat.color) mat.color.set(e.color);
      }
      const arrowMats = rec.built.root.userData.arrowMats as THREE.MeshBasicMaterial[] | undefined;
      arrowMats?.forEach((m) => m.color.set(e.color));
      // 光源强度/颜色
      const pt = rec.built.root.userData.light as THREE.PointLight | undefined;
      if (pt) {
        pt.color.set(e.color);
        pt.intensity = e.intensity ?? 26;
      }
      // 姿势
      this.rigs.get(rec.built.root)?.sample(e);
      const poseKey = JSON.stringify(e.pose ?? {});
      if (rec.poseKey !== poseKey) {
        applyPose(rec.built.root, e.pose);
        rec.poseKey = poseKey;
      }
    }
    // 删除
    for (const [id, rec] of [...this.entities]) {
      if (!seen.has(id)) {
        this.loading.delete(id);
        if (this.selectedId === id) {
          this.gizmo.detach();
          this.selectedId = null;
        }
        this.scene.remove(rec.built.root);
        this.disposeObject(rec.built.root);
        this.entities.delete(id);
      }
    }
  }

  /** GLB 模型异步加载（归一化到 1.7m 高、落地、居中） */
  private loadGlb(e: PrevizEntity, skey: string) {
    if (this.loading.has(e.id)) return;
    const token = Symbol(e.id);
    this.loading.set(e.id, token);
    const path = e.modelAssetPath!;
    const finish = (model: THREE.Group | null) => {
      const current = this.latestEntities.get(e.id);
      if (this.disposed || !model || !current || structKey(current) !== skey || this.loading.get(e.id) !== token) {
        if (model) this.disposeObject(model);
        return;
      }
      this.loading.delete(e.id);
      const old = this.entities.get(e.id);
      if (old) { this.scene.remove(old.built.root); this.disposeObject(old.built.root); this.entities.delete(e.id); }
      e = current;
      // 加载期间实体可能已被删除
      const holder = new THREE.Group();
      holder.add(model);
      holder.userData.entityId = e.id;
      holder.userData.kind = e.kind; // applyCameraView/refreshGizmo 靠 kind==="camera" 识别机位（GLB 机位也要能当机位用）
      const built: BuiltEntity = { root: holder, height: 1.7, mats: [] };
      const rig = new SkeletalRig(model, model.animations); this.rigs.set(holder, rig); rig.sample(e);
      this.scene.add(holder);
      this.entities.set(e.id, { built, skey, poseKey: "" });
      // 触发一次变换同步（位置/旋转/缩放）
      const [px, py, pz] = entityPos(e);
      holder.position.set(px, py, pz);
      holder.rotation.set(deg(e.rotDeg?.[0] ?? 0), deg(entityRotY(e)), deg(e.rotDeg?.[2] ?? 0));
      const s = e.scale3 ?? [1, 1, 1];
      holder.scale.set(s[0], s[1], s[2]);
      if (this.selectedId === e.id) this.refreshGizmo();
    };
    const applyCache = (src: THREE.Group) => {
      const inst = cloneSkeleton(src) as THREE.Group;
      inst.traverse(o => {
        if (o instanceof THREE.Mesh) {
          o.geometry = o.geometry.clone();
          const copy = (mat: THREE.Material) => {
            const m = mat.clone();
            for (const [key, value] of Object.entries(m)) if (value instanceof THREE.Texture) (m as unknown as Record<string, unknown>)[key] = value.clone();
            return m;
          };
          o.material = Array.isArray(o.material) ? o.material.map(copy) : copy(o.material);
        }
      });
      finish(inst);
    };
    const cached = this.glbCache.get(path);
    if (cached) {
      applyCache(cached);
      return;
    }
    // 占位盒（加载中可见）
    const ph = buildEntity({ ...e, preset: "box", kind: "prop" });
    ph.root.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.MeshStandardMaterial).wireframe = true;
    });
    this.scene.add(ph.root);
    this.entities.set(e.id, { built: ph, skey, poseKey: "" });

    const url = assetUrl(path);
    this.gltfLoader.load(
      url,
      (gltf) => {
        const model = gltf.scene;
        if (this.disposed) { this.disposeObject(model); return; }
        // 归一化：高度 → 1.7m，底部贴地，中心对齐
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const scale = 1.7 / Math.max(size.y, 0.001);
        const wrapper = new THREE.Group();
        wrapper.add(model);
        wrapper.scale.setScalar(scale);
        const box2 = new THREE.Box3().setFromObject(wrapper);
        const center = box2.getCenter(new THREE.Vector3());
        wrapper.position.sub(center);
        wrapper.position.y += (box2.max.y - box2.min.y) / 2;
        model.traverse((o) => {
          if (o instanceof THREE.Mesh) o.castShadow = true;
        });
        wrapper.animations = gltf.animations ?? [];
        const oldCache = this.glbCache.get(path);
        if (oldCache) this.disposeObject(oldCache);
        this.glbCache.set(path, wrapper);
        applyCache(wrapper);
      },
      undefined,
      () => {
        if (this.disposed || this.loading.get(e.id) !== token) return;
        this.loading.delete(e.id);
        // 加载失败：占位线框盒转正（写回正式 skey，不再每次同步都重试加载）
        const rec = this.entities.get(e.id);
        if (rec) rec.skey = skey;
        this.cb.onError?.(`模型「${e.name}」加载失败（文件可能已移动或格式不支持）`);
      },
    );
  }

  /* ---------- 拾取 ---------- */

  private onPointerDown = (ev: PointerEvent) => {
    this.downAt = { x: ev.clientX, y: ev.clientY };
  };

  private onPointerUp = (ev: PointerEvent) => {
    if (!this.downAt) return;
    const moved = Math.hypot(ev.clientX - this.downAt.x, ev.clientY - this.downAt.y);
    this.downAt = null;
    if (moved > 6 || this.dragging) return;
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    // 机位视角下被透视的机位是 invisible 的：three 的 Raycaster 不剔除不可见对象，
    // 不过滤的话点击「空气」会静默选中那台隐藏机位
    const roots = [...this.entities.values()].map((r) => r.built.root).filter((r) => r.visible);
    const hits = this.raycaster.intersectObjects(roots, true);
    let id: string | null = null;
    if (hits.length) {
      let o: THREE.Object3D | null = hits[0].object;
      while (o) {
        if (o.userData.entityId) {
          id = o.userData.entityId as string;
          break;
        }
        o = o.parent;
      }
    }
    this.cb.onPick(id);
  };

  /* ---------- 拖动写回 ---------- */

  private commitDrag() {
    const id = this.selectedId;
    if (!id) return;
    const rec = this.entities.get(id);
    if (!rec) return;
    const o = rec.built.root;
    const round = (n: number) => Math.round(n * 1000) / 1000;
    this.cb.onTransformCommit(id, {
      pos: [round(o.position.x), round(o.position.y), round(o.position.z)],
      rotDeg: [round(rad(o.rotation.x)), round(rad(o.rotation.y)), round(rad(o.rotation.z))],
      scale: [round(o.scale.x), round(o.scale.y), round(o.scale.z)],
    });
  }

  /* ---------- 帧循环 ---------- */

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if(this.recording)return;
    if (this.viewMode === "camera") this.applyCameraView();
    else this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.emitFrame();
  };

  /** 机位视角：把渲染相机贴到机位实体上（朝实体 +Z 方向看）；优先选中的机位 */
  private applyCameraView() {
    let camRoot: THREE.Group | undefined;
    for (const rec of this.entities.values()) {
      if (rec.built.root.userData.kind === "camera") {
        if (rec.built.root.userData.entityId === this.selectedId) {
          camRoot = rec.built.root;
          break;
        }
        camRoot ??= rec.built.root;
      }
    }
    if (!camRoot) {
      // 没有机位实体：退回自由环绕，避免视角被锁死
      this.restoreHiddenCam();
      this.controls.enabled = true;
      this.controls.update();
      return;
    }
    this.controls.enabled = false;
    // 渲染相机架在该机位实体内部：必须隐藏它自身的网格，
    // 否则机身/镜头在近平面内渲染成一团黑（此前「机位视角黑圆圈」的根因）
    if (this.hiddenCamRoot !== camRoot) {
      this.restoreHiddenCam();
      camRoot.visible = false;
      this.hiddenCamRoot = camRoot;
    }
    this.camera.position.copy(camRoot.position);
    this.camera.position.y += 0.05;
    this.camera.quaternion.copy(camRoot.quaternion);
    // 实体 forward = +Z；相机默认看 -Z → 绕 Y 转 180°
    this.camera.rotateY(Math.PI);
  }

  /** 恢复被机位视角隐藏的机位实体 */
  private restoreHiddenCam() {
    if (this.hiddenCamRoot) {
      this.hiddenCamRoot.visible = true;
      this.hiddenCamRoot = null;
    }
  }

  /** 拖动中的实时变换（面板数值跟随用，不写 store） */
  peekTransform(id: string): { pos: [number, number, number]; rotDeg: [number, number, number]; scale: [number, number, number] } | null {
    const rec = this.entities.get(id);
    if (!rec) return null;
    const o = rec.built.root;
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      pos: [round(o.position.x), round(o.position.y), round(o.position.z)],
      rotDeg: [round(rad(o.rotation.x)), round(rad(o.rotation.y)), round(rad(o.rotation.z))],
      scale: [round(o.scale.x), round(o.scale.y), round(o.scale.z)],
    };
  }

  private emitFrame() {
    if (!this.cb.onFrame) return;
    const rect = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector3();
    const labels: LabelInfo[] = [];
    for (const [id, rec] of this.entities) {
      // 隐藏的机位（机位视角下被透视的那台）与相机重合，投影会出 NaN/无限大，跳过
      if (!rec.built.root.visible) { labels.push({ id, x: 0, y: 0, visible: false }); continue; }
      v.copy(rec.built.root.position);
      v.y += rec.built.height * (rec.built.root.scale.y || 1) + 0.28;
      v.project(this.camera);
      const visible = v.z >= -1 && v.z <= 1 && Number.isFinite(v.x) && Number.isFinite(v.y);
      labels.push({
        id,
        x: (v.x * 0.5 + 0.5) * rect.width,
        y: (-v.y * 0.5 + 0.5) * rect.height,
        visible,
      });
    }
    const q = this.camera.quaternion.clone().invert();
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const ay = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const az = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    this.cb.onFrame(labels, {
      x: [ax.x, -ax.y],
      y: [ay.x, -ay.y],
      z: [az.x, -az.y],
      zBack: az.z > 0,
    });
  }

  /* ---------- 导出 ---------- */

  private clearMotionTrails() {
    for(const child of [...this.motionTrails.children]){this.motionTrails.remove(child);const line=child as THREE.Line;line.geometry?.dispose();if(!Array.isArray(line.material))line.material?.dispose();}
  }
  setMotionTrails(entities:PrevizEntity[]) {
    this.clearMotionTrails();
    for(const e of entities){if(!e.motion?.length)continue;
      const keys=sampleMotion([e],0)[0];
      const points=[new THREE.Vector3(...(keys.pos??[0,0,0])),...e.motion.map(k=>new THREE.Vector3(...k.pos))];
      this.motionTrails.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:e.color,depthTest:false,transparent:true,opacity:0.75})));
    }
    this.motionTrails.visible=this.viewMode==="director";
  }
  /** 实时录制明确的时间采样；不修改项目，只输出当前取景框。 */
  async recordMotion(entities:PrevizEntity[],duration:number,aspect:string,signal:AbortSignal,onProgress:(pct:number)=>void):Promise<Blob>{
    if(this.recording)throw new Error("正在录制预演");
    if(this.loading.size)throw new Error("模型仍在加载，请加载完成后录制");
    if(!Number.isFinite(duration)||duration<=0||duration>120)throw new Error("预演时长须为1至120秒");
    signal.throwIfAborted();
    const mime=["video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm"].find(m=>MediaRecorder.isTypeSupported(m));
    if(!mime)throw new Error("当前环境不支持 WebM 录制");
    const output=document.createElement("canvas"),r=stageFrame(this.canvas.width,this.canvas.height,aspect);
    const scale=Math.min(1,1920/Math.max(r.w,r.h));output.width=Math.round(r.w*scale);output.height=Math.round(r.h*scale);
    const ctx=output.getContext("2d")!,stream=output.captureStream(30),rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:6_000_000});
    const parts:Blob[]=[];rec.ondataavailable=e=>{if(e.data.size)parts.push(e.data);};
    let recorderError:Error|undefined;
    const done=new Promise<void>(resolve=>{rec.onstop=()=>resolve();rec.onerror=()=>{recorderError=new Error("录制编码失败");resolve();};});
    this.recording=true;this.controls.enabled=false;this.gizmo.enabled=false;
    let raf=0,started=false;
    try{
      rec.start(200);started=true;
      await new Promise<void>((resolve,reject)=>{
        const start=performance.now();
        const abort=()=>{cancelAnimationFrame(raf);signal.removeEventListener("abort",abort);reject(new DOMException("已取消","AbortError"));};
        signal.addEventListener("abort",abort,{once:true});
        const tick=()=>{try{
          if(this.disposed)throw new Error("3D 视口已关闭");
          signal.throwIfAborted();if(recorderError)throw recorderError;
          const t=Math.min(duration,(performance.now()-start)/1000);this.syncEntities(sampleMotion(entities,t));
          if(this.viewMode==="camera")this.applyCameraView();this.renderClean(false);
          ctx.drawImage(this.canvas,r.x,r.y,r.w,r.h,0,0,output.width,output.height);onProgress(Math.round(t/duration*100));
          if(t>=duration){signal.removeEventListener("abort",abort);resolve();}else raf=requestAnimationFrame(tick);
        }catch(e){signal.removeEventListener("abort",abort);reject(e);}};tick();
      });
    }finally{
      cancelAnimationFrame(raf);if(rec.state!=="inactive")rec.stop();if(started)await done;stream.getTracks().forEach(t=>t.stop());
      this.recording=false;this.gizmo.enabled=true;this.controls.enabled=this.viewMode==="director";
      if(!this.disposed)this.syncEntities(entities);
    }
    if(recorderError)throw recorderError;
    return new Blob(parts,{type:"video/webm"});
  }

  /** 当前视角彩色截图 */
  exportImage(aspect?: string): string {
    this.renderClean(false);
    return this.captureFrame(aspect);
  }

  /** 深度参考图（近亮远暗，供 ControlNet 粗略参考） */
  exportDepth(aspect?: string): string {
    const oldBg = this.scene.background;
    const oldFog = this.scene.fog;
    const depthMat = new THREE.MeshDepthMaterial();
    this.scene.overrideMaterial = depthMat;
    this.scene.background = new THREE.Color(0x000000);
    this.scene.fog = null;
    this.setHelpersVisible(false);
    this.renderer.render(this.scene, this.camera);
    const url = this.captureFrame(aspect);
    this.scene.overrideMaterial = null;
    depthMat.dispose();
    this.scene.background = oldBg;
    this.scene.fog = oldFog;
    this.setHelpersVisible(true);
    this.renderer.render(this.scene, this.camera);
    return url;
  }

  /** 语义分区图（每个实体一块纯色，其余纯黑，供 ControlNet 分区控制） */
  exportSegment(colorOf: (id: string) => string, aspect?: string): string {
    const oldBg = this.scene.background;
    const oldFog = this.scene.fog;
    this.scene.background = new THREE.Color(0x000000);
    this.scene.fog = null;
    this.setHelpersVisible(false);
    this.ground.visible = false;
    // 记录并替换材质（flat 一次性，渲染完销毁；原材质换回）
    const swapped: { mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] = [];
    const flats = new Set<THREE.Material>();
    for (const [id, rec] of this.entities) {
      const flat = new THREE.MeshBasicMaterial({ color: colorOf(id) });
      flats.add(flat);
      rec.built.root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          swapped.push({ mesh: o, mat: o.material });
          o.material = flat;
        }
      });
    }
    this.renderer.render(this.scene, this.camera);
    const url = this.captureFrame(aspect);
    for (const s of swapped) s.mesh.material = s.mat;
    flats.forEach((m) => m.dispose());
    this.ground.visible = true;
    this.scene.background = oldBg;
    this.scene.fog = oldFog;
    this.setHelpersVisible(true);
    this.renderer.render(this.scene, this.camera);
    return url;
  }

  private captureFrame(aspect?: string) {
    const source = this.renderer.domElement;
    if (!aspect) return source.toDataURL("image/png");
    const rect = stageFrame(source.width, source.height, aspect);
    const out = document.createElement("canvas"); out.width = rect.w; out.height = rect.h;
    const ctx = out.getContext("2d"); if (!ctx) throw new Error("无法导出取景画面");
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    return out.toDataURL("image/png");
  }

  private renderClean(hideGround: boolean) {
    this.setHelpersVisible(false);
    if (hideGround) this.ground.visible = false;
    this.renderer.render(this.scene, this.camera);
    this.setHelpersVisible(true);
    if (hideGround) this.ground.visible = true;
  }

  private setHelpersVisible(v: boolean) {
    this.motionTrails.visible=v && this.viewMode==="director";
    this.grid.visible = v;
    this.gizmo.getHelper().visible = v;
    // 朝向箭头也藏起来（它是 UI 提示不是画面内容）
    for (const rec of this.entities.values()) {
      rec.built.root.traverse((o) => {
        if (o.userData.arrowMats) o.visible = v;
      });
    }
  }
}
