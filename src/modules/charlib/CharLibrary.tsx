/**
 * 角色库 — 内置风格统一的人物预设（写实棚拍基调）
 *  上：所选预设详情（档案 / 配色 / 将产出的素材）；下：预设横向卡片列表
 *  预设自带完整档案与提示词；预览图用你配置的绘画模型生成一次后落盘缓存（charPreviews.json）
 *  「应用至画布」= 在视图中心放一个已装好档案与提示词的角色卡节点，点生成即可产出整套素材
 */
import { useEffect, useMemo, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { useBoard } from "../../core/stores/boardStore";
import { resolveModelCard } from "../../core/stores/settingsStore";
import { pushError, toast, useUi } from "../../core/stores/uiStore";
import { generateImage } from "../../core/services/imageGen";
import {
  assetUrl,
  deleteAssetFile,
  extFromMime,
  fetchBytes,
  storeAssetFile,
} from "../../core/services/assetFiles";
import { loadJSON, saveJSON } from "../../core/persist";
import { errMsg } from "../../core/utils";
import { CHAR_DELIVERABLES, CHAR_PRESETS, type CharPreset } from "../../core/charPresets";
import { IcClose, IcLoading, IcPlus, IcRefresh, IcSparkles, IcUsers } from "../../ui/icons";
import "./charlib.css";

/** 预设预览图缓存：presetId → 落盘路径（生成一次，之后一直复用） */
type PreviewMap = Record<string, { path: string; thumb?: string }>;

/** 预设头像：有缓存的真实预览图就用图，否则用预设配色的剪影占位 */
function PresetAvatar({
  preset,
  size = 64,
  preview,
  busy,
}: {
  preset: CharPreset;
  size?: number;
  preview?: { path: string; thumb?: string };
  busy?: boolean;
}) {
  const [c1, c2] = [preset.profile.palette[0] ?? "#8aa8d8", preset.profile.palette[1] ?? "#d8c8e8"];
  return (
    <div
      className={`cp-avatar ${busy ? "busy" : ""}`}
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${c1}, ${c2})` }}
    >
      {preview ? (
        <img src={assetUrl(preview.thumb || preview.path)} alt={preset.name} />
      ) : (
        <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="rgba(255,255,255,0.88)" aria-hidden>
          <circle cx="12" cy="8.6" r="4" />
          <path d="M4 21c.8-4.4 4-6.8 8-6.8s7.2 2.4 8 6.8H4Z" />
        </svg>
      )}
      {busy ? (
        <span className="cp-busy">
          <IcLoading size={Math.round(size * 0.3)} />
        </span>
      ) : null}
    </div>
  );
}

export function CharLibrary() {
  const open = useUi((s) => s.charLibOpen);
  const setOpen = useUi((s) => s.setCharLibOpen);
  const addNode = useBoard((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();
  const [selId, setSelId] = useState(CHAR_PRESETS[0].id);
  const [filter, setFilter] = useState<string | null>(null);
  const [previews, setPreviews] = useState<PreviewMap>({});
  const [genBusy, setGenBusy] = useState<string | null>(null);

  const allTags = useMemo(() => [...new Set(CHAR_PRESETS.flatMap((p) => p.tags))], []);
  const list = filter ? CHAR_PRESETS.filter((p) => p.tags.includes(filter)) : CHAR_PRESETS;
  const sel = CHAR_PRESETS.find((p) => p.id === selId) ?? CHAR_PRESETS[0];

  /* 载入预览图缓存 */
  useEffect(() => {
    if (!open) return;
    void loadJSON<PreviewMap>("charPreviews.json", "v1").then((m) => setPreviews(m ?? {}));
  }, [open]);

  /** 用绘画模型生成该预设的预览图（立绘提示词），落盘缓存复用 */
  const genPreview = async (p: CharPreset) => {
    if (genBusy) return;
    setGenBusy(p.id);
    try {
      const card = resolveModelCard("image");
      const [img] = await generateImage(card, { prompt: p.prompts.portrait, n: 1 });
      const { bytes, mime } = await fetchBytes(img);
      const stored = await storeAssetFile(bytes, extFromMime(mime), "image");
      const old = previews[p.id];
      if (old) void deleteAssetFile(old.path, old.thumb);
      const next = { ...previews, [p.id]: { path: stored.path, thumb: stored.thumb } };
      setPreviews(next);
      void saveJSON("charPreviews.json", "v1", next);
      toast(`「${p.name}」预览图已生成并缓存`, "ok");
    } catch (e) {
      pushError("角色库", errMsg(e));
    } finally {
      setGenBusy(null);
    }
  };

  /* Esc 关闭 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const apply = (p: CharPreset = sel) => {
    const pos = screenToFlowPosition({ x: window.innerWidth / 2 - 190, y: window.innerHeight / 2 - 240 });
    addNode("charCard", pos, {
      profile: p.profile,
      prompts: p.prompts,
      presetName: p.name,
      status: "idle",
    });
    setOpen(false);
    toast(`已添加「${p.name}」角色卡：点节点上的「生成整套素材」开始产出`, "ok");
  };

  return (
    <div className="charlib-mask" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="charlib glass">
        <div className="cl-head">
          <IcUsers size={21} />
          <b>角色库</b>
          <span className="cl-hint">内置风格统一的人物预设 · 应用后用你配置的绘画模型生成整套素材（自动收录进资产库）</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" title="关闭 (Esc)" onClick={() => setOpen(false)}>
            <IcClose size={18} />
          </button>
        </div>

        {/* 所选预设详情 */}
        <div className="cl-detail">
          <div className="cl-avatar-col">
            <PresetAvatar preset={sel} size={128} preview={previews[sel.id]} busy={genBusy === sel.id} />
            <button
              className="btn sm"
              disabled={!!genBusy}
              title="用你配置的绘画模型按该预设的立绘提示词生成一张预览图（消耗一次生图额度，之后一直缓存复用）"
              onClick={() => void genPreview(sel)}
            >
              {previews[sel.id] ? <IcRefresh size={14} /> : <IcSparkles size={14} />}
              {previews[sel.id] ? "重生预览" : "生成预览图"}
            </button>
          </div>
          <div className="cl-info">
            <div className="cl-name">
              <b>{sel.name}</b>
              {sel.profile.nameEn ? <i>{sel.profile.nameEn}</i> : null}
              {sel.tags.map((t) => (
                <span key={t} className="cl-tag">
                  {t}
                </span>
              ))}
            </div>
            <p className="cl-desc">{sel.desc}</p>
            <div className="cl-facts">
              <div>
                <span>外貌</span>
                {sel.profile.appearance.join("；")}
              </div>
              <div>
                <span>服装</span>
                {sel.profile.outfit.join("；")}
              </div>
              {sel.profile.accessories?.length ? (
                <div>
                  <span>配饰</span>
                  {sel.profile.accessories.join("；")}
                </div>
              ) : null}
              <div>
                <span>气质</span>
                {sel.profile.keywords.join(" · ")}
              </div>
            </div>
            <div className="cl-palette">
              {sel.profile.palette.map((c, i) => (
                <i key={i} style={{ background: c }} title={c} />
              ))}
            </div>
            <div className="cl-delivs">
              将产出：
              {CHAR_DELIVERABLES.map((d) => (
                <span key={d.value} title={d.desc}>
                  {d.label}
                </span>
              ))}
            </div>
          </div>
          <button className="btn primary cl-apply" onClick={() => apply()}>
            <IcPlus size={16} /> 应用至画布
          </button>
        </div>

        {/* 预设列表 */}
        <div className="cl-filter">
          <button className={`chip ${filter === null ? "on" : ""}`} onClick={() => setFilter(null)}>
            全部
          </button>
          {allTags.map((t) => (
            <button key={t} className={`chip ${filter === t ? "on" : ""}`} onClick={() => setFilter(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="cl-strip">
          {list.map((p) => (
            <button
              key={p.id}
              className={`cl-card ${p.id === selId ? "on" : ""}`}
              title={p.desc}
              onClick={() => setSelId(p.id)}
              onDoubleClick={() => apply(p)}
            >
              <PresetAvatar preset={p} size={72} preview={previews[p.id]} busy={genBusy === p.id} />
              <span>{p.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
