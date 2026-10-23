import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
assert.equal(process.platform,'win32');
assert.equal(process.arch,'x64');
assert.equal(process.version,'v24.22.1');
const root=process.argv[2],bun=path.resolve(process.argv[3]);
const modulePath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'campaign-runtime.ts');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const {verifyBunAvailable}=createRequire(import.meta.url)(modulePath);
const envBase=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'].includes(k.toUpperCase())));
const baseline=spawnSync(bun,['--version'],{encoding:'utf8',env:envBase});
assert.equal(baseline.status,0);assert.equal(baseline.stdout.trim(),'1.4.4');
const rows=[];
for(const mode of ['project','global']){
 const scope=path.join(root,mode),home=path.join(scope,'home'),cwd=path.join(scope,'project'),marker=path.join(scope,'preload-marker.txt');
 fs.mkdirSync(home,{recursive:true});fs.mkdirSync(cwd,{recursive:true});
 const preload=path.join(scope,'preload.mjs');
 fs.writeFileSync(preload,"import{writeFileSync}from'node:fs';writeFileSync(process.env.MCPORTER_PROOF_MARKER,'loaded');\n");
 const config=mode==='project'?path.join(cwd,'bunfig.toml'):path.join(home,'.bunfig.toml');
 fs.writeFileSync(config,'preload = ['+JSON.stringify(preload)+']\n');
 const env={...envBase,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:home,BUN_BIN:bun,MCPORTER_PROOF_MARKER:marker};
 const control=spawnSync(bun,['--print','JSON.stringify({version:process.versions.bun,executable:process.execPath})'],{cwd,env,encoding:'utf8',timeout:15000});
 const sensitive=fs.existsSync(marker);if(sensitive)fs.unlinkSync(marker);
 assert.equal(control.status,0,control.stderr);
 if(mode==='project')assert.equal(sensitive,true,'Project fixture must detect the earlier preload side effect');
 const priorEnv={...process.env},priorCwd=process.cwd();let selected;
 try{process.chdir(cwd);for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,env);selected=await verifyBunAvailable();}
 finally{process.chdir(priorCwd);for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,priorEnv);}
 assert.equal(fs.existsSync(marker),false,'Metadata identification must not execute preload');
 assert.equal(path.resolve(selected).toLowerCase(),bun.toLowerCase());
 rows.push({mode,controlPreloadObserved:sensitive,repairedPreloadObserved:false,absoluteSelectedExecutable:true,globalFixtureQualified:mode==='global'?sensitive:undefined});
}
const result={platform:process.platform,arch:process.arch,node:process.version,nodeSHA256:sha(process.execPath),bunVersion:baseline.stdout.trim(),bunSHA256:sha(bun),ownerModuleSHA256:sha(modulePath),nullDevice:os.devNull,rows,scope:'Actual Windows x64 Bun metadata query via byte-identical owning module only. No generated native CLI/TLS, signing/release or fleet claim.'};
fs.writeFileSync(path.join(root,'RESULTS.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
