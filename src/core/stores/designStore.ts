import { create } from "zustand";
import { loadJSON, saveJSON } from "../persist";
import { pushError } from "./uiStore";
import type { BrandKit } from "../types";

export const emptyBrand = (): BrandKit => ({ name: "", colors: [], fonts: "", rules: "", forbidden: "", logoAssetIds: [], enabled: false });
let writes = Promise.resolve();
export const useDesign = create<{ brands: Record<string, BrandKit>; init: () => Promise<void>; save: (boardId: string, kit: BrandKit) => void }>((set,get) => ({
  brands: {},
  init: async () => { const brands = await loadJSON<Record<string,BrandKit>>("design-kits.json","v1"); if (brands && typeof brands==="object") set({brands:Object.fromEntries(Object.entries(brands).filter(([,b])=>b && Array.isArray(b.colors) && Array.isArray(b.logoAssetIds)).map(([id,b])=>[id,{...emptyBrand(),...b}]))}); },
  save: (boardId,kit) => {
    const brands = {...get().brands,[boardId]:kit}; set({brands});
    writes = writes.catch(()=>{}).then(()=>saveJSON("design-kits.json","v1",brands)).catch(e=>pushError("品牌包保存",String(e)));
  },
}));

export function brandPrompt(boardId: string, prompt: string) {
  const b=useDesign.getState().brands[boardId];
  if(!b?.enabled) return prompt;
  return `${prompt}\n\n【品牌规范：${b.name || "当前画布"}】\n标准色：${b.colors.join("、") || "沿用参考"}\n字体要求：${b.fonts || "沿用原设计"}\n${b.rules}\n禁止：${b.forbidden || "不添加无关标志或文字"}`;
}
