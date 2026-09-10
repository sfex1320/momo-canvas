import {invoke} from "@tauri-apps/api/core";
import {join,resourceDir} from "@tauri-apps/api/path";
import {open} from "@tauri-apps/plugin-dialog";
import {copyFile,mkdir,writeTextFile} from "@tauri-apps/plugin-fs";
import {useDirector} from "../stores/directorStore";
import {buildRenderPlan} from "../directorRender";
import {isTauri,uid} from "../utils";
import {loadJSON,saveJSON} from "../persist";
import {premiereXml} from "./editingExportCore";
import type {DirectorProject} from "../types";

export async function chooseEditingPython() {
  const path=await open({title:"选择已安装 pyJianYingDraft 0.3.0 的 Python",filters:[{name:"Python",extensions:["exe"]}]});
  if(typeof path==="string")await saveJSON("editing-tools.json","v1",{pythonPath:path});
}
export async function exportEditingProject(project:DirectorProject,preset:string,target:"premiere"|"jianying"):Promise<string|null> {
  if(!isTauri)throw Error("剪辑工程导出需要桌面端");
  const built=buildRenderPlan(project,preset);
  if(!built.plan.clips.length)throw Error("请先采用至少一个视频片段");
  if(built.missing.length)throw Error("部分采用素材缺失，请修复后再导出工程");
  let pythonPath="";
  if(target==="jianying") {
    pythonPath=(await loadJSON<{pythonPath:string}>("editing-tools.json","v1"))?.pythonPath??"";
    if(!pythonPath)pythonPath=(await invoke<string[]>("production_detect",{roots:[await resourceDir()]})).find(p=>p.includes("jianying"))??"";
    if(!pythonPath)throw Error("未找到剪映导出环境，请点“剪映环境”选择已安装 pyJianYingDraft 0.3.0 的 Python");
  }
  const folder=await open({directory:true,title:target==="premiere"?"选择工程交付目录":"选择剪映草稿根目录（全局设置 → 草稿位置）"});
  if(typeof folder!=="string")return null;
  const name=`${project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,"_").slice(0,60)||"MOMO"}-${uid(6)}`;
  const dest=await join(folder,name),media=await join(dest,"素材");
  await mkdir(media,{recursive:true});
  const plan=structuredClone(built.plan),paths=new Map<string,string>(),durations:Record<string,number>={},hasAudio:Record<string,boolean>={};
  for(const path of new Set([...plan.clips.map(c=>c.path),...plan.audio.map(a=>a.path),...plan.titles.map(t=>t.imagePath).filter((p):p is string=>!!p)])) {
    const out=await join(media,`${String(paths.size+1).padStart(3,"0")}_${path.split(/[\\/]/).pop()}`);
    await copyFile(path,out);paths.set(path,out);
    const info=await invoke<{durationSec?:number;hasAudio?:boolean}>("media_probe",{input:out,ffprobePath:useDirector.getState().mediaTool.ffprobePath??null});
    if(info.durationSec)durations[out]=info.durationSec;
    if(typeof info.hasAudio==="boolean")hasAudio[out]=info.hasAudio;
  }
  plan.clips=plan.clips.map(c=>({...c,path:paths.get(c.path)!}));plan.audio=plan.audio.map(a=>({...a,path:paths.get(a.path)!}));plan.titles=plan.titles.map(t=>({...t,imagePath:t.imagePath?paths.get(t.imagePath):undefined}));
  await writeTextFile(await join(dest,"时间线.json"),JSON.stringify({name,plan,durations},null,2));
  if(plan.srt)await writeTextFile(await join(dest,"字幕.srt"),plan.srt);
  if(target==="premiere")await writeTextFile(await join(dest,"Premiere.xml"),premiereXml(plan,project.name,durations,hasAudio));
  else await invoke("production_run",{taskId:uid(12),pythonPath,request:{op:"jianying",directory:dest,name,plan,durations}});
  await writeTextFile(await join(dest,"交接说明.txt"),target==="premiere"?"在 Premiere 中导入 Premiere.xml，字幕.srt 单独拖入。入出点、片段顺序、原声与分离音轨、音量已导出。XML 以项目帧率量化毫秒时间。转场、淡化、旋转、镜像和标题卡请在 PR 中重设；完整参数保存在时间线.json，MP4 导出保留这些效果。移动文件夹后可在 PR 重新链接素材目录。":"重新打开剪映，在草稿列表选择本工程。草稿由 pyJianYingDraft 0.3.0 创建，基础剪辑、配乐与字幕可继续编辑；实际兼容性以本机剪映版本为准。转场、淡化、旋转和镜像已按支持项写入；标题卡请在剪映补排。移动文件夹后需重连素材。时间线.json 保留原始剪辑参数。");
  return dest;
}
