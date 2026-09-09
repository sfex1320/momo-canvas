// esbuild 解析仓库中的无扩展名 TS 导入，避免 Node strip-types 的解析差异。
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url),viteRequire=createRequire(require.resolve('vite'));
const {build}=viteRequire('esbuild');
const tests=execFileSync('rg',['--files','src'],{encoding:'utf8',windowsHide:true}).split(/\r?\n/).filter(f=>f.endsWith('.test.ts'));
tests.push('scripts/qa/h3Authoring.test.ts','scripts/qa/skill-delete.test.ts','scripts/qa/codexBridge.test.ts','scripts/qa/eagle-sync.test.ts');
await mkdir('.Codex/core-tests',{recursive:true});let failed=0;
for(const file of tests){
 const name=path.basename(file),outfile=path.resolve('.Codex/core-tests',name+'.mjs');
 try{
  await build({entryPoints:[file],outfile,bundle:true,platform:'node',format:'esm',packages:'external',define:{'import.meta.env':'{}'},logLevel:'silent'});
  const output=execFileSync(process.execPath,[outfile],{encoding:'utf8',windowsHide:true,timeout:60000});
  await writeFile(outfile+'.log',output);console.log('通过 '+file);
 }catch(e){failed++;const details=String(e.stdout??'')+'\n'+String(e.stderr??e.message);await writeFile(outfile+'.log',details);console.log('失败 '+file+'\n'+details.slice(-2200));}
}
console.log(`${tests.length-failed}/${tests.length} 测试文件通过`);process.exitCode=failed?1:0;
