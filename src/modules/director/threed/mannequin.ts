/**
 * 3D 导演台 · 程序化人偶与道具构建器
 *
 * 不依赖外部模型文件：用胶囊/球体拼出带关节的木偶人（球关节木偶质感），
 * 体型差异通过 BodySpec 比例参数表达（健硕=bulk 大、二头身=head 大…）。
 * 每个角色 root 的 userData.joints 保存关节 Group，供姿势系统按名旋转。
 */
import * as THREE from "three";
import type { PrevizEntity } from "../../../core/types";

/* ---------- 体型预设 ---------- */

export type BodySpec = {
  /** 总身高（米） */
  height: number;
  /** 头部比例（1 = 正常） */
  head: number;
  /** 肩宽系数 */
  shoulder: number;
  /** 四肢/躯干粗细系数 */
  bulk: number;
};

export const BODY_PRESETS: Record<string, { label: string; spec: BodySpec }> = {
  male: { label: "标准男性", spec: { height: 1.8, head: 1, shoulder: 1, bulk: 1 } },
  female: { label: "标准女性", spec: { height: 1.68, head: 1, shoulder: 0.86, bulk: 0.85 } },
  strong: { label: "健硕", spec: { height: 1.86, head: 0.95, shoulder: 1.24, bulk: 1.5 } },
  slim: { label: "纤细", spec: { height: 1.74, head: 1, shoulder: 0.84, bulk: 0.7 } },
  teen: { label: "少年", spec: { height: 1.52, head: 1.08, shoulder: 0.9, bulk: 0.8 } },
  child: { label: "儿童", spec: { height: 1.18, head: 1.3, shoulder: 0.85, bulk: 0.72 } },
  wide: { label: "宽厚", spec: { height: 1.74, head: 1, shoulder: 1.38, bulk: 1.55 } },
  chibi: { label: "二头身", spec: { height: 1.05, head: 2.3, shoulder: 0.95, bulk: 0.95 } },
};

/* ---------- 道具几何体预设 ---------- */

export const PROP_PRESETS: Record<string, { label: string; make: () => THREE.BufferGeometry }> = {
  wall: { label: "文化墙", make: () => new THREE.BoxGeometry(6, 3, 0.16) },
  platform: { label: "展示台", make: () => new THREE.CylinderGeometry(1.1, 1.1, 0.6, 48) },
  panel: { label: "立牌", make: () => new THREE.BoxGeometry(1, 2, 0.08) },
  box: { label: "立方体", make: () => new THREE.BoxGeometry(0.8, 0.8, 0.8) },
  sphere: { label: "球体", make: () => new THREE.SphereGeometry(0.45, 32, 24) },
  cylinder: { label: "圆柱", make: () => new THREE.CylinderGeometry(0.36, 0.36, 0.9, 32) },
  cone: { label: "圆锥", make: () => new THREE.ConeGeometry(0.42, 0.9, 32) },
  torus: { label: "圆环", make: () => new THREE.TorusGeometry(0.36, 0.13, 20, 40) },
  capsule: { label: "胶囊", make: () => new THREE.CapsuleGeometry(0.26, 0.44, 8, 20) },
};

/** 道具默认落地高度（几何体中心 y），让道具默认贴地 */
const PROP_GROUND_Y: Record<string, number> = {
  wall: 1.5, platform: 0.3, panel: 1,
  box: 0.4,
  sphere: 0.45,
  cylinder: 0.45,
  cone: 0.45,
  torus: 0.13,
  capsule: 0.48,
};

/* ---------- 关节与姿势 ---------- */

export type JointName =
  | "waist" | "chest" | "neck"
  | "shoulderL" | "shoulderR" | "elbowL" | "elbowR"
  | "hipL" | "hipR" | "kneeL" | "kneeR";

export const JOINT_LABEL: Record<JointName, string> = {
  waist: "腰部",
  chest: "胸部",
  neck: "颈部",
  shoulderL: "左肩",
  shoulderR: "右肩",
  elbowL: "左肘",
  elbowR: "右肘",
  hipL: "左髋",
  hipR: "右髋",
  kneeL: "左膝",
  kneeR: "右膝",
};

/** 姿势预设：关节 → 欧拉角（度）。x=前俯/后仰，z=侧展（手臂） */
export const POSE_PRESETS: { key: string; label: string; pose: Partial<Record<JointName, [number, number, number]>> }[] = [
  { key: "stand", label: "站立", pose: {} },
  {
    key: "relax", label: "放松",
    pose: {
      shoulderL: [4, 0, 9], shoulderR: [4, 0, -9],
      elbowL: [8, 0, 0], elbowR: [8, 0, 0],
      chest: [2, 4, 0], neck: [3, 0, 0],
    },
  },
  {
    key: "tpose", label: "T-Pose",
    pose: { shoulderL: [0, 0, 82], shoulderR: [0, 0, -82], elbowL: [0, 0, 0], elbowR: [0, 0, 0] },
  },
  {
    key: "sit", label: "坐下",
    pose: {
      hipL: [-88, 0, 0], hipR: [-88, 0, 0],
      kneeL: [88, 0, 0], kneeR: [88, 0, 0],
      chest: [4, 0, 0], shoulderL: [10, 0, 8], shoulderR: [10, 0, -8],
      elbowL: [20, 0, 0], elbowR: [20, 0, 0],
    },
  },
  {
    key: "walk", label: "走路",
    pose: {
      hipL: [-26, 0, 0], kneeL: [12, 0, 0],
      hipR: [18, 0, 0], kneeR: [30, 0, 0],
      shoulderL: [18, 0, 7], shoulderR: [-22, 0, -7],
      elbowL: [14, 0, 0], elbowR: [26, 0, 0],
      chest: [3, -4, 0],
    },
  },
  {
    key: "run", label: "跑步",
    pose: {
      hipL: [-48, 0, 0], kneeL: [30, 0, 0],
      hipR: [28, 0, 0], kneeR: [70, 0, 0],
      shoulderL: [36, 0, 8], shoulderR: [-40, 0, -8],
      elbowL: [70, 0, 0], elbowR: [75, 0, 0],
      chest: [12, 0, 0], neck: [-6, 0, 0],
    },
  },
  {
    key: "wave", label: "挥手",
    pose: {
      shoulderR: [0, 0, -160], elbowR: [0, 0, -24],
      shoulderL: [6, 0, 10], elbowL: [12, 0, 0],
      neck: [0, -8, 4], chest: [0, -4, 0],
    },
  },
  {
    key: "point", label: "指向",
    pose: {
      shoulderR: [86, 0, -6], elbowR: [4, 0, 0],
      shoulderL: [8, 0, 10], elbowL: [16, 0, 0],
      neck: [0, 6, 0],
    },
  },
  {
    key: "bow", label: "弯腰",
    pose: {
      waist: [46, 0, 0], chest: [18, 0, 0], neck: [-20, 0, 0],
      shoulderL: [12, 0, 8], shoulderR: [12, 0, -8],
      kneeL: [8, 0, 0], kneeR: [8, 0, 0],
    },
  },
];

/* ---------- 构建 ---------- */

export type BuiltEntity = {
  root: THREE.Group;
  /** 实体整体高度（米），名牌定位用 */
  height: number;
  /** 主材质（调色用）；GLB 模型可能多个 → 数组 */
  mats: THREE.Material[];
};

const deg = (d: number) => (d * Math.PI) / 180;

function capsule(r: number, len: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 18), mat);
  m.castShadow = true;
  return m;
}

function ball(r: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 22, 16), mat);
  m.castShadow = true;
  return m;
}

/** 朝向指示：脚下前方的扁平箭头（贴地，实体色） */
function facingArrow(color: string, dist: number): THREE.Group {
  const g = new THREE.Group();
  g.userData.groundArrow = true;
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const tri = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 3), mat);
  tri.rotation.x = Math.PI / 2; // 尖端朝 +Z
  tri.scale.y = 0.28; // 压扁贴地
  tri.position.set(0, 0.015, dist + 0.15);
  const stem = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.012, 0.2), mat);
  stem.position.set(0, 0.012, dist - 0.06);
  g.add(tri, stem);
  g.userData.arrowMats = [mat];
  return g;
}

/** 构建带关节木偶人。root 原点在两脚之间地面 */
function buildMannequin(spec: BodySpec, color: string, appearance: PrevizEntity["appearance"] = "mannequin"): BuiltEntity {
  const h = spec.height;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: appearance === "clay" ? 1 : 0.7, metalness: 0 });
  const skin = appearance === "costume" ? new THREE.MeshStandardMaterial({ color: "#e7bda0", roughness: 0.9 }) : mat;
  const detail = new THREE.MeshStandardMaterial({ color: "#303846", roughness: 0.9 });
  const joints = new Map<string, THREE.Group>();

  // 比例分解（以正常人为基准，头大的体型压缩躯干腿）
  const headR = 0.066 * h * spec.head;
  const hipH = 0.53 * h * (spec.head > 1.6 ? 0.82 : 1);
  const shoulderHalf = 0.115 * h * spec.shoulder;
  const limbR = 0.036 * h * spec.bulk;
  const jointR = limbR * 1.18;
  const torsoR = 0.078 * h * spec.bulk;
  const neckY = 0.845 * h;
  const shoulderY = 0.8 * h;
  const upperArm = 0.165 * h;
  const forearm = 0.15 * h;
  const thigh = hipH * 0.48;
  const shin = hipH * 0.46;

  const root = new THREE.Group();

  // 腰（髋部中心）
  const waist = new THREE.Group();
  waist.position.y = hipH;
  root.add(waist);
  joints.set("waist", waist);

  // 骨盆
  const pelvis = capsule(torsoR * 0.92, shoulderHalf * 1.1, mat);
  pelvis.rotation.z = Math.PI / 2;
  waist.add(pelvis);

  // 胸（胸腔上移到肩）
  const chest = new THREE.Group();
  chest.position.y = 0.04 * h;
  waist.add(chest);
  joints.set("chest", chest);
  const chestLen = shoulderY - hipH - 0.06 * h;
  const torso = capsule(torsoR, Math.max(0.02, chestLen - torsoR * 1.4), mat);
  torso.position.y = chestLen / 2;
  chest.add(torso);

  // 颈 + 头
  const neck = new THREE.Group();
  neck.position.y = neckY - hipH - 0.04 * h;
  chest.add(neck);
  joints.set("neck", neck);
  const neckM = capsule(limbR * 0.62, 0.03 * h, mat);
  neckM.position.y = 0.02 * h;
  neck.add(neckM);
  const head = ball(headR, skin);
  head.position.y = 0.035 * h + headR;
  head.scale.y = 1.12; // 微椭圆更人形
  neck.add(head);
  // 眼、鼻、耳提供朝向与姿态读数；服装风格增加头发，仍保持中性的预演造型。
  for (const sign of [-1, 1]) {
    const eye = ball(headR * 0.075, detail); eye.position.set(sign * headR * 0.34, headR * 0.12, headR * 0.94); head.add(eye);
    const ear = ball(headR * 0.18, skin); ear.scale.set(0.45, 1, 0.7); ear.position.set(sign * headR * 0.98, 0, 0); head.add(ear);
  }
  const nose = ball(headR * 0.14, skin); nose.scale.z = 1.35; nose.position.set(0, -headR * 0.06, headR * 0.97); head.add(nose);
  if (appearance === "costume") {
    const hair = new THREE.Mesh(new THREE.SphereGeometry(headR * 1.04, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.47), detail);
    hair.position.y = headR * 0.05; hair.castShadow = true; head.add(hair);
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(torsoR * 1.03, torsoR * 1.03, h * 0.018, 28), detail);
    belt.position.y = h * 0.035; waist.add(belt);
  }

  // 手臂（挂在胸上，肩高）
  const armY = shoulderY - hipH - 0.04 * h;
  for (const side of ["L", "R"] as const) {
    const s = side === "L" ? -1 : 1;
    const sh = new THREE.Group();
    sh.position.set(s * (shoulderHalf + jointR * 0.4), armY, 0);
    chest.add(sh);
    joints.set(`shoulder${side}`, sh);
    sh.add(ball(jointR, mat));
    const ua = capsule(limbR, upperArm - jointR * 1.6, mat);
    ua.position.y = -upperArm / 2;
    sh.add(ua);
    // 肘
    const el = new THREE.Group();
    el.position.y = -upperArm;
    sh.add(el);
    joints.set(`elbow${side}`, el);
    el.add(ball(jointR * 0.88, mat));
    const fa = capsule(limbR * 0.86, forearm - jointR * 1.4, mat);
    fa.position.y = -forearm / 2;
    el.add(fa);
    const hand = ball(limbR * 1.05, skin);
    hand.position.y = -forearm - limbR * 0.6;
    hand.scale.y = 1.3;
    el.add(hand);
    // 自然下垂微张
    sh.rotation.z = s * deg(-7);
  }

  // 腿（挂在腰下）
  for (const side of ["L", "R"] as const) {
    const s = side === "L" ? -1 : 1;
    const hip = new THREE.Group();
    hip.position.set(s * shoulderHalf * 0.52, -0.02 * h, 0);
    waist.add(hip);
    joints.set(`hip${side}`, hip);
    hip.add(ball(jointR * 1.05, mat));
    const th = capsule(limbR * 1.12, thigh - jointR * 1.8, mat);
    th.position.y = -thigh / 2;
    hip.add(th);
    const knee = new THREE.Group();
    knee.position.y = -thigh;
    hip.add(knee);
    joints.set(`knee${side}`, knee);
    knee.add(ball(jointR * 0.95, mat));
    const sh2 = capsule(limbR * 0.94, shin - jointR * 1.6, mat);
    sh2.position.y = -shin / 2;
    knee.add(sh2);
    // 脚：向前的小方块
    const foot = new THREE.Mesh(new THREE.CapsuleGeometry(limbR * 0.65, limbR * 1.7, 6, 16), appearance === "costume" ? detail : mat);
    foot.rotation.x = Math.PI / 2;
    foot.scale.y = 0.8;
    foot.castShadow = true;
    foot.position.set(0, -(hipH - limbR * 0.5) + thigh + shin - 0, limbR * 0.9);
    // 简化：直接挂在膝下末端
    foot.position.y = -shin;
    knee.add(foot);
  }

  root.userData.joints = joints;
  root.add(facingArrow(color, torsoR + 0.42));
  return { root, height: h, mats: [mat] };
}

/** 简化小人（群众演员用，无关节） */
function buildExtra(color: string, h: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.04 });
  const body = capsule(0.09 * h, 0.42 * h, mat);
  body.position.y = 0.52 * h;
  const head = ball(0.11 * h, mat);
  head.position.y = 0.86 * h;
  g.add(body, head);
  return g;
}

/** 群众方阵：rows×cols 简化小人 */
function buildCrowd(preset: string, color: string): BuiltEntity {
  const [rows, cols] = preset === "crowd22" ? [2, 2] : preset === "crowdLine" ? [1, 5] : [3, 3];
  const root = new THREE.Group();
  const gap = 0.78;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const shade = 0.82 + ((r * cols + c) % 5) * 0.045;
      const col = new THREE.Color(color).multiplyScalar(shade);
      const p = buildExtra(`#${col.getHexString()}`, 1.66 + ((r + c) % 3 - 1) * 0.05);
      p.position.set((c - (cols - 1) / 2) * gap, 0, (r - (rows - 1) / 2) * gap);
      root.add(p);
    }
  }
  return { root, height: 1.8, mats: [] };
}

/** 摄影机实体：半透明「虚拟机位」——淡色填充 + 线框描边 + 视野锥。
 *  机位视角下渲染相机架在实体原点、引擎会隐藏自身网格；半透明样式保证导演视角下
 *  机位可读但不笨重，也不会在遮挡关系上糊住身后的角色。 */
function buildCameraRig(color: string): BuiltEntity {
  const root = new THREE.Group();
  const fill = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.35,
    metalness: 0.05,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  const line = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });

  const bodyGeo = new THREE.BoxGeometry(0.4, 0.26, 0.52);
  const body = new THREE.Mesh(bodyGeo, fill);
  const bodyEdge = new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeo), line);
  root.add(body, bodyEdge);

  const lensGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.24, 24);
  const lens = new THREE.Mesh(lensGeo, fill);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = 0.36;
  const lensEdge = new THREE.LineSegments(new THREE.EdgesGeometry(lensGeo, 30), line);
  lensEdge.rotation.x = Math.PI / 2;
  lensEdge.position.z = 0.36;
  root.add(lens, lensEdge);

  // 视野锥（朝 +Z）
  const coneLen = 2.6;
  const coneGeo = new THREE.ConeGeometry(0.85, coneLen, 4, 1, true);
  const coneMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 });
  const cone = new THREE.LineSegments(new THREE.EdgesGeometry(coneGeo), coneMat);
  cone.rotation.x = -Math.PI / 2; // 锥尖朝 +Z
  cone.position.z = coneLen / 2;
  root.add(cone);

  root.add(facingArrow(color, 0.85));
  return { root, height: 0.5, mats: [fill, line, coneMat] };
}

/** 光源实体：发光球 + 真实点光 */
function buildLightRig(color: string, intensity: number): BuiltEntity {
  const root = new THREE.Group();
  const bulbMat = new THREE.MeshBasicMaterial({ color });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), bulbMat);
  root.add(bulb);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 20, 14),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18 }),
  );
  root.add(halo);
  const pt = new THREE.PointLight(color, intensity, 18, 1.6);
  root.add(pt);
  root.userData.light = pt;
  root.userData.halo = halo;
  return { root, height: 0.3, mats: [bulbMat] };
}

/** 几何道具 */
function buildProp(preset: string, color: string): BuiltEntity {
  const def = PROP_PRESETS[preset] ?? PROP_PRESETS.box;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.08 });
  const mesh = new THREE.Mesh(def.make(), mat);
  mesh.castShadow = true;
  const root = new THREE.Group();
  mesh.position.y = PROP_GROUND_Y[preset] ?? 0.4;
  root.add(mesh);
  return { root, height: (PROP_GROUND_Y[preset] ?? 0.4) * 2, mats: [mat] };
}

/** 旧 2D 坐标（0-100 百分比）→ 3D 位置（24m 舞台） */
export function legacyPos(e: PrevizEntity): [number, number, number] {
  const y = e.kind === "camera" ? 1.6 : e.kind === "light" ? 2.6 : 0;
  return [(e.x - 50) * 0.24, y, (e.y - 50) * 0.24];
}

/** 实体世界位置（带旧数据回落） */
export function entityPos(e: PrevizEntity): [number, number, number] {
  return e.pos ?? legacyPos(e);
}

/** 实体偏航角（度，带旧数据回落：旧 angle 0=远方 → 3D rotY=180） */
export function entityRotY(e: PrevizEntity): number {
  return e.rotDeg?.[1] ?? 180 - e.angle;
}

/** 按实体定义构建 three 对象（GLB 由引擎异步处理，这里只走程序化类型） */
export function buildEntity(e: PrevizEntity): BuiltEntity {
  let built: BuiltEntity;
  if (e.kind === "character") {
    if (e.preset?.startsWith("crowd")) built = buildCrowd(e.preset, e.color);
    else built = buildMannequin(BODY_PRESETS[e.preset ?? "male"]?.spec ?? BODY_PRESETS.male.spec, e.color, e.appearance);
  } else if (e.kind === "camera") {
    built = buildCameraRig(e.color);
  } else if (e.kind === "light") {
    built = buildLightRig(e.color, e.intensity ?? 26);
  } else {
    built = buildProp(e.preset ?? "box", e.color);
  }
  built.root.userData.entityId = e.id;
  built.root.userData.kind = e.kind;
  return built;
}

/** 把姿势（关节角度表）应用到人偶关节 */
export function applyPose(root: THREE.Group, pose: Record<string, [number, number, number]> | undefined) {
  const joints = root.userData.joints as Map<string, THREE.Group> | undefined;
  if (!joints) return;
  for (const [name, g] of joints) {
    const base = g.userData.baseRot as [number, number, number] | undefined;
    if (!base) {
      g.userData.baseRot = [g.rotation.x, g.rotation.y, g.rotation.z];
    }
    const b = (g.userData.baseRot as [number, number, number]) ?? [0, 0, 0];
    const p = pose?.[name];
    g.rotation.set(
      b[0] + (p ? deg(p[0]) : 0),
      b[1] + (p ? deg(p[1]) : 0),
      b[2] + (p ? deg(p[2]) : 0),
    );
  }
}
