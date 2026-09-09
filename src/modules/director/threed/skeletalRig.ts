import * as THREE from "three";
import type { PrevizEntity } from "../../../core/types";

type Angles = [number, number, number];
/** 每个实例独立的骨骼与混合器，拖动时间轴时确定性采样，禁止共享骨骼。 */
export class SkeletalRig {
  readonly bones: Array<{ key: string; name: string; bone: THREE.Bone; rest: THREE.Quaternion }> = [];
  readonly mixer: THREE.AnimationMixer;
  private action?: THREE.AnimationAction;
  private clip = "";
  constructor(readonly root: THREE.Object3D, readonly clips: THREE.AnimationClip[]) {
    root.traverse(o => { if (o instanceof THREE.Bone) this.bones.push({ key: String(this.bones.length), name: o.name || `骨骼 ${this.bones.length + 1}`, bone: o, rest: o.quaternion.clone() }); });
    this.mixer = new THREE.AnimationMixer(root);
  }
  sample(e: PrevizEntity) {
    const s = e.skeletal, time = Math.max(0, e.animationTime ?? 0), name = s?.clip ?? "";
    if (this.clip !== name) {
      this.mixer.stopAllAction(); this.action = undefined; this.clip = name;
      const clip = this.clips.find(c => c.name === name);
      if (clip) this.action = this.mixer.clipAction(clip).play();
    }
    for (const b of this.bones) b.bone.quaternion.copy(b.rest);
    if (this.action) {
      this.action.setLoop(s?.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      this.action.clampWhenFinished = true; this.action.enabled = true; this.action.paused = false;
      const t = time * Math.max(0.05, Math.min(4, s?.speed ?? 1));
      this.mixer.setTime(s?.loop === false ? Math.min(t, this.action.getClip().duration) : t);
    }
    const poses = sampleBoneKeys(s, time);
    for (const b of this.bones) {
      const p = poses[b.key]; if (!p) continue;
      b.bone.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.map(THREE.MathUtils.degToRad) as Angles)));
    }
    this.root.updateMatrixWorld(true);
  }
  dispose() { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.root); }
}

export function sampleBoneKeys(s: PrevizEntity["skeletal"], time: number): Record<string, Angles> {
  const base = s?.bones ?? {}, keys = [{time: 0, bones: base}, ...(s?.keys ?? [])].filter(k => Number.isFinite(k.time) && k.time >= 0).sort((a,b) => a.time-b.time);
  let a = keys[0], b = keys[keys.length-1];
  for (const k of keys) { if (k.time <= time) a = k; else { b = k; break; } }
  const t = b.time > a.time ? Math.max(0, Math.min(1, (time-a.time)/(b.time-a.time))) : 0;
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(a.bones), ...Object.keys(b.bones)])].map(key => {
    const x = a.bones[key] ?? base[key] ?? [0,0,0], y = b.bones[key] ?? base[key] ?? [0,0,0];
    return [key, x.map((v,i) => v + (((y[i]-v)%360+540)%360-180)*t) as Angles];
  }));
}
