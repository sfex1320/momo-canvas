import type {MomoSkill} from "./skillTypes";

/** 删除标记同时过滤内置种子与历史保存项，更新、重启不能复活被删技能。 */
export function mergeSkillCatalog(builtins:MomoSkill[],installed:MomoSkill[],deletedBuiltinIds:string[]):MomoSkill[]{
  const removed=new Set(deletedBuiltinIds),merged=builtins.filter(s=>!removed.has(s.id));
  for(const s of installed){
    if(removed.has(s.id))continue;
    const index=merged.findIndex(b=>b.id===s.id);
    if(index<0){merged.push(s);continue;}
    const seed=merged[index];
    merged[index]=s.id==="builtin-element-decompose"&&s.source==="builtin"&&s.name==="元素拆解"&&s.version==="1.0.0"
      ? {...s,name:seed.name,version:seed.version,description:seed.description}:s;
    // 仅同步内置项的旧界面名称，保留用户改名、指令与启停设置。
    if(s.source==="builtin"){
      const current=merged[index];
      const name=s.id==="builtin-planar-sheet"&&current.name==="效果图转平面总稿"?seed.name:current.name;
      const description=current.description.replace(/元素抠图与分层/g,"元素分层");
      if(name!==current.name||description!==current.description)merged[index]={...current,name,description};
    }
  }
  return merged;
}
