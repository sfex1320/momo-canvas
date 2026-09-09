/**
 * 角色库工位（导演台 3.0 · 方案 §6.3）— 角色是一级实体，不再只是 name + continuity
 *
 * 左：角色卡列表 · 中：角色档案编辑（身份 / 外貌锚点 / 服装组 / 分类参考图 / 声音）·
 * 右：出场片段反向索引 + 「角色来源已更新」传播（§7.3：不静默重写提示词）。
 * 修订机制：角色 rev 随保存 +1；片段「来源过期」= 角色更新晚于该段最近生成。
 * 锁定身份 / 锁定最终稿的片段只提示差异，不被角色同步覆盖。
 */
import { useMemo, useRef, useState } from "react";
import { useDirector } from "../../../core/stores/directorStore";
import { SI } from "../shared/selectIcons";
import { useAssets } from "../../../core/stores/assetStore";
import { useDirectorCtx } from "../../../core/directorContext";
import { assetUrl } from "../../../core/services/assetFiles";
import { buildObjectIndex, charactersInSegment } from "../../../core/studio/objectIndex";
import { uid } from "../../../core/utils";
import { removeCharacter } from "../../../core/directorEngine";
import { AskCard } from "../../director/AskCard";
import { DockPanel } from "../shared/DockPanel";
import { Thumb } from "../../../ui/Thumb";
import { PopSelect } from "../../../ui/PopSelect";
import { IcUsers, IcPlus, IcPerson, IcCheck, IcLock, IcUnlock, IcWarn, IcUpload, IcTrash } from "../../../ui/icons";
import type { DirectorProject } from "../../../core/types";

const REF_VIEWS: Array<{ key: string; label: string }> = [
  { key: "front", label: "正面" },
  { key: "side", label: "侧面" },
  { key: "full", label: "全身" },
  { key: "expression", label: "表情" },
  { key: "action", label: "动作" },
];

export function CharacterLibraryStation({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  const assets = useAssets((s) => s.items);
  const setSeg = useDirectorCtx((s) => s.setSeg);
  const selectedId = project.studioUi?.characterId ?? project.characters[0]?.id ?? null;
  const ch = project.characters.find((c) => c.id === selectedId) ?? project.characters[0];
  const fileRef = useRef<HTMLInputElement>(null);
  const [viewKey, setViewKey] = useState<string>("front");
  const index = useMemo(() => buildObjectIndex(project), [project]);

  const [ask, setAsk] = useState<{ text: React.ReactNode; run: () => void } | null>(null);
  const patchCh = (patch: Partial<(typeof project.characters)[number]>) => {
    if (!ch) return;
    updateProject(project.id, {
      characters: project.characters.map((c) =>
        c.id === ch.id ? { ...c, ...patch, rev: (c.rev ?? 1) + (patch.continuity || patch.identity || patch.appearanceAnchors ? 1 : 0), updatedAt: Date.now() } : c,
      ),
    });
  };

  const newChar = () => {
    const c = { id: uid(8), name: "新角色", continuity: "", assetIds: [] };
    updateProject(project.id, { characters: [...project.characters, c], studioUi: { ...project.studioUi ?? { station: "h3" }, characterId: c.id } });
  };

  /** 出场片段反向索引 + 「角色来源已更新」判定（角色更新晚于该段最近一次生成） */
  const appearances = useMemo(() => {
    if (!ch) return [];
    return index.segments
      .filter((v) => charactersInSegment(project, v.segment).some((c) => c.id === ch.id))
      .map((v) => {
        const lastGen = Math.max(0, ...(v.segment.takes ?? []).map((t) => t.createdAt));
        return { ...v, staleSource: (ch.updatedAt ?? 0) > lastGen && lastGen > 0 };
      });
  }, [index.segments, ch, project]);

  const addRefFromFiles = async (files: FileList | null) => {
    if (!files?.length || !ch) return;
    const ids: string[] = [];
    for (const f of Array.from(files)) {
      const a = await useAssets.getState().importFileGetItem(f);
      if (a) ids.push(a.id);
    }
    if (!ids.length) return;
    patchCh({
      assetIds: [...(ch.assetIds ?? []), ...ids],
      refViews: { ...(ch.refViews ?? {}), [viewKey]: [...(ch.refViews?.[viewKey] ?? []), ...ids] },
    });
  };

  return (
    <>
      <DockPanel
        className="ch-left"
        title={`角色库（${project.characters.length}）`}
        projectId={project.id}
        widthKey="chLeft"
        width={project.studioUi?.panelWidths?.chLeft ?? 240}
        headExtra={
          <button className="st-btn sm" style={{ marginLeft: "auto" }} onClick={newChar}><IcPlus size={12} /> 新建</button>
        }
      >
        {project.characters.length === 0 ? (
          <div className="st-empty"><b>还没有角色</b>手动新建，或在剧本库送入项目后由拆分自动提取。</div>
        ) : null}
        {project.characters.map((c) => {
          const poster = (c.assetIds ?? []).length ? assets.find((a) => a.id === c.assetIds![0]) : undefined;
          return (
            <div key={c.id} className={`ch-card${ch?.id === c.id ? " on" : ""}`} onClick={() => updateProject(project.id, { studioUi: { ...project.studioUi ?? { station: "h3" }, characterId: c.id } })}>
              <div className="ch-avatar">
                {poster ? (poster.kind === "image" ? <Thumb src={assetUrl(poster.path)} style={{ width: "100%", height: "100%" }} /> : <IcPerson size={16} />) : <IcPerson size={16} />}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, display: "flex", gap: 4, alignItems: "center" }}>
                  {c.name} {c.locked ? <IcLock size={10} style={{ color: "var(--studio-text-3)" }} /> : null}
                </div>
                <div className="st-hint">{(c.assetIds ?? []).length} 张参考 · v{c.rev ?? 1}</div>
              </div>
            </div>
          );
        })}
      </DockPanel>

      {ch ? (
        <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--studio-panel)" }}>
          <div className="st-context">
            <input className="st-input" style={{ width: 140, fontWeight: 600 }} value={ch.name} onChange={(e) => patchCh({ name: e.target.value })} aria-label="角色名" />
            <span className="st-hint">修订 v{ch.rev ?? 1}{ch.updatedAt ? ` · ${new Date(ch.updatedAt).toLocaleString()}` : ""}</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button
                className="st-btn sm"
                title={ch.locked ? "解锁身份：允许后续同步操作触及该角色的片段" : "锁定身份：角色同步不会覆盖其出场片段提示词"}
                onClick={() => patchCh({ locked: !ch.locked })}
              >
                {ch.locked ? <IcLock size={12} /> : <IcUnlock size={12} />} {ch.locked ? "已锁定" : "未锁定"}
              </button>
              <button
                className="st-btn sm danger"
                title="删除这个角色档案（引用它生成的素材保留在资产库）"
                onClick={() =>
                  setAsk({
                    text: (
                      <>
                        删除角色档案 <b>「{ch.name}」</b>？
                        <div className="st-hint" style={{ marginTop: 4 }}>
                          只删除档案本身；引用它生成的图片/视频素材全部保留在资产库。此操作不可撤销。
                        </div>
                      </>
                    ),
                    run: () => removeCharacter(project.id, ch.id),
                  })
                }
              >
                <IcTrash size={12} /> 删除角色
              </button>
            </div>
          </div>
          <div className="st-panel-b" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="st-field">
              <label>基础身份（年龄 / 体型 / 气质一句话）</label>
              <input className="st-input" value={ch.identity ?? ""} onChange={(e) => patchCh({ identity: e.target.value })} placeholder="如：二十岁出头的瘦高少女，警觉而克制" />
            </div>
            <div className="st-field">
              <label>外貌锚点（固定特征，独立于服装——连续性的关键）</label>
              <textarea className="st-area" rows={2} value={ch.appearanceAnchors ?? ""} onChange={(e) => patchCh({ appearanceAnchors: e.target.value })} placeholder="发型 / 发色 / 眼睛 / 肤色 / 标志性配饰" />
            </div>
            <div className="st-field">
              <label>服装与外观说明（连续性约束，进提示词）</label>
              <textarea className="st-area" rows={3} value={ch.continuity} onChange={(e) => patchCh({ continuity: e.target.value })} />
            </div>
            <div className="st-field">
              <label>服装组（多套外观；每套独立说明与参考图）</label>
              {(ch.outfits ?? []).map((o) => (
                <div key={o.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input className="st-input" style={{ width: 90 }} value={o.name} onChange={(e) => patchCh({ outfits: (ch.outfits ?? []).map((x) => (x.id === o.id ? { ...x, name: e.target.value } : x)) })} />
                  <input className="st-input" style={{ flex: 1 }} value={o.desc} onChange={(e) => patchCh({ outfits: (ch.outfits ?? []).map((x) => (x.id === o.id ? { ...x, desc: e.target.value } : x)) })} />
                  <button className="st-iconbtn" title="删除此服装组" onClick={() => patchCh({ outfits: (ch.outfits ?? []).filter((x) => x.id !== o.id) })}><IcTrash size={13} /></button>
                </div>
              ))}
              <button className="st-btn sm" onClick={() => patchCh({ outfits: [...(ch.outfits ?? []), { id: uid(6), name: `服装 ${(ch.outfits ?? []).length + 1}`, desc: "" }] })}>
                <IcPlus size={11} /> 添加服装组
              </button>
            </div>
            <div className="st-field">
              <label>参考图（分类：正面 / 侧面 / 全身 / 表情 / 动作）</label>
              <div className="st-row">
                <PopSelect value={viewKey} onChange={(v) => setViewKey(String(v))} triggerIcon
                options={REF_VIEWS.map((r) => ({ value: r.key, label: r.label, icon: r.key === "action" ? SI.video : SI.image }))} />
                <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void addRefFromFiles(e.target.files)} />
                <button className="st-btn sm" onClick={() => fileRef.current?.click()}><IcUpload size={12} /> 添加到「{REF_VIEWS.find((r) => r.key === viewKey)?.label}」</button>
              </div>
              <div className="ch-refs">
                {((ch.refViews?.[viewKey] ?? []).length ? ch.refViews![viewKey] : ch.assetIds ?? []).map((id) => {
                  const a = assets.find((x) => x.id === id);
                  return (
                    <div key={id} className="ch-ref" title={a?.name}>
                      {a?.kind === "image" ? <Thumb src={assetUrl(a.path)} style={{ width: "100%", height: "100%" }} /> : <IcUsers size={16} />}
                      <button
                        className="rm"
                        title="移除参考"
                        onClick={() =>
                          patchCh({
                            assetIds: (ch.assetIds ?? []).filter((x) => x !== id),
                            refViews: Object.fromEntries(Object.entries(ch.refViews ?? {}).map(([k, v]) => [k, v.filter((x) => x !== id)])),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                {!(ch.assetIds ?? []).length ? <div className="ch-ref" style={{ borderStyle: "dashed" }}><IcPlus size={16} /></div> : null}
              </div>
            </div>
            <div className="st-row">
              <div className="st-field" style={{ flex: 1 }}>
                <label>声音参考说明</label>
                <input className="st-input" value={ch.voiceDesc ?? ""} onChange={(e) => patchCh({ voiceDesc: e.target.value })} placeholder="音色描述 / 演员参考" />
              </div>
              <div className="st-field" style={{ flex: 1 }}>
                <label>默认 TTS 音色</label>
                <input className="st-input" value={ch.ttsVoice ?? ""} onChange={(e) => patchCh({ ttsVoice: e.target.value })} placeholder="audio 模型的 voice 参数" />
              </div>
            </div>
          </div>
        </section>
      ) : (
        <div className="st-empty" style={{ flex: 1 }}><IcUsers size={30} /><b>选择或新建角色</b></div>
      )}

      {/* 右：受影响片段（§6.3 独立同步） */}
      <DockPanel className="ch-right" title="出场片段" projectId={project.id} widthKey="chRight" width={project.studioUi?.panelWidths?.chRight ?? 280}>
        {ch ? (
          <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="st-hint" style={{ lineHeight: 1.7 }}>
              修改角色后，这些片段下次生成会自动编译新外观；
              <b>锁定最终稿</b>的片段不会被改写，只在这里提示差异。
            </span>
            {appearances.length === 0 ? <span className="st-hint">该角色暂无出场片段（按名字在片段文案中命中）。</span> : null}
            {appearances.map((v) => (
              <div
                key={v.segment.id}
                className="st-seg"
                style={{ minHeight: 40 }}
                title={`跳到 H3 导演台的 ${v.segment.summary.slice(0, 30)}`}
                onClick={() => {
                  setSeg(v.segment.id);
                  updateProject(project.id, { studioUi: { ...project.studioUi ?? { station: "h3" }, station: "h3" } });
                }}
              >
                <div className="st-seg-main">
                  <div className="st-seg-t">{String(v.storyIndex + 1).padStart(2, "0")} {v.segment.summary.slice(0, 20)}</div>
                  <div className="st-seg-meta">
                    {v.staleSource ? <span className="st-pill warn"><IcWarn size={10} /> 角色来源已更新</span> : null}
                    {v.segment.promptFinalOverride ? <span className="st-pill accent">最终稿锁定</span> : null}
                    {v.status === "approved" ? <span className="st-pill ok">已采用</span> : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="st-empty"><IcCheck size={20} />选择角色后显示其出场片段</div>
        )}
      </DockPanel>
          {ask ? (
        <AskCard
          text={ask.text}
          okText="确认删除"
          danger
          onConfirm={() => {
            ask.run();
            setAsk(null);
          }}
          onCancel={() => setAsk(null)}
        />
      ) : null}
</>
  );
}
