/** 隔离来源的真实工位验收，不加载用户项目或配置，不提交生成任务。 */
import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/theme.css";
import "../../src/styles/base.css";
import { StudioShell } from "../../src/modules/studio/StudioShell";
import { useDirector } from "../../src/core/stores/directorStore";
import { useDirectorCtx } from "../../src/core/directorContext";

if (location.hostname !== "[::1]") throw Error("验收限定独立 [::1] 来源");
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const project = useDirector.getState().createProject("qa-studio", "qa-studio", "山海之间 · 品牌短片");
if (params.has("sample")) {
  useDirector.getState().updateProject(project.id, {
    script: "以山川、手作与日常为线索，讲述人与自然相互陪伴的故事。",
    scenes: [{ id: "qa-scene", location: "山间 · 清晨", segments: ["晨雾中，山脊被第一束阳光照亮", "手作匠人在窗边整理器物", "镜头跟随脚步，穿过山间小径", "回到庭院，热茶升起白雾", "人物抬头望向远山", "品牌落版：在日常，与自然相遇"].map((summary, i) => ({ id: `qa-segment-${i}`, sceneId: "qa-scene", durationSec: 12, summary, dialogue: [], shots: [], takes: [] })) }],
  });
  useDirectorCtx.getState().setSeg("qa-segment-0");
}
function App() {
  const current = useDirector((s) => s.projects.find((p) => p.id === project.id)!);
  return <StudioShell project={current} />;
}
createRoot(document.getElementById("root")!).render(<App />);
