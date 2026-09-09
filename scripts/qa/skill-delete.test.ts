import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {useSkills,newSkill} from "../../src/core/stores/skillStore.ts";

const key="momo:skills.json:v1",data=new Map<string,string>();
if(process.env.MOMO_SKILL_TEST_STATE)data.set(key,process.env.MOMO_SKILL_TEST_STATE);
Object.defineProperty(globalThis,"localStorage",{value:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)},configurable:true});
await useSkills.getState().init();
if(process.argv[2]==="reload"){
  assert(!useSkills.getState().getById("builtin-planar-sheet"),"重新启动不能复活被删内置项");
  assert(useSkills.getState().getById("builtin-prompt-polish")?.starred,"其它操作和偏好仍应保留");
  useSkills.getState().restoreDeletedBuiltins();
  assert(useSkills.getState().getById("builtin-planar-sheet"),"手动恢复内置项");
  assert.equal(useSkills.getState().deletedBuiltinIds.length,0);
  assert(useSkills.getState().getById("builtin-prompt-polish")?.starred,"恢复不重置其它偏好");
  console.log("独立进程重启及恢复通过");
}else{
  const seed=useSkills.getState().getById("builtin-planar-sheet")!;
  assert(seed,"旧数据/首次启动正常补内置项");
  useSkills.getState().remove(seed.id);
  assert(!useSkills.getState().getById(seed.id));
  assert(useSkills.getState().deletedBuiltinIds.includes(seed.id));
  useSkills.getState().toggleStarred("builtin-prompt-polish");
  useSkills.getState().toggleEnabled("builtin-remote-video-prompt");
  const saved=JSON.parse(data.get(key)!);
  assert.equal(saved.schemaVersion,2);
  assert(saved.deletedBuiltinIds.includes(seed.id),"启停和收藏不能丢删除标记");
  const result=execFileSync(process.execPath,[process.argv[1],"reload"],{encoding:"utf8",windowsHide:true,env:{...process.env,MOMO_SKILL_TEST_STATE:data.get(key)!}});
  assert(result.includes("重启及恢复通过"));
  useSkills.getState().install({...seed,instructions:"重新安装的自定义内容"});
  assert(!useSkills.getState().deletedBuiltinIds.includes(seed.id));
  assert.equal(useSkills.getState().getById(seed.id)?.instructions,"重新安装的自定义内容");
  const custom=newSkill({name:"自制测试 Skill",source:"import"});
  useSkills.getState().install(custom);useSkills.getState().remove(custom.id);
  assert(!useSkills.getState().getById(custom.id));
  assert(!useSkills.getState().deletedBuiltinIds.includes(custom.id));
  console.log("内置删除、持久化、独立进程重启、手动恢复、重新安装和普通删除全部通过");
}
