import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const out=new URL('.',import.meta.url);
const source=(await fs.readFile(new URL('./snapshot.txt',out),'utf8')).trim();
globalThis.__dbMetrics=new Proxy({},{get:(target,key)=>target[key]??0});
const {initializeServerDB}=await import(`${source}/src/server.js`);
const scope={organization_id:'000000000000000000000001',storage:'bench',database:'app',array:'files'};
const id=n=>(n+1).toString(16).padStart(24,'0');
const server=()=>Object.assign(new EventEmitter(),{id:'disk-bench',isPrimary:true,send:async payload=>payload,cluster:Object.assign(new EventEmitter(),{send(){}})});
const open=directory=>initializeServerDB(server(),{directory,memoryCache:true,memoryOnly:false,externalPersistence:false});
const read=n=>({...scope,method:'object.read',filter:{query:{host:{$in:['bench.invalid','*']},pathname:`/file-${n}.html`},limit:1}});
const stats=a=>{a.sort((x,y)=>x-y);return{p50Ms:a[Math.floor(a.length*.5)],p95Ms:a[Math.ceil(a.length*.95)-1],maxMs:a.at(-1)}};
if(process.argv[2]==='--reader'){
 const db=open(process.argv[3]);const start=performance.now();const first=await db.send(read(0));const coldFirstReadMs=performance.now()-start;
 if(first.object.length!==1||first.object[0].revision!==1)throw Error('Cold read lost persisted update');
 for(let i=0;i<250;i++){const r=await db.send(read(i));if(r.object.length!==1)throw Error('Warmup missing persisted record');}
 const times=[];const warmStart=performance.now();for(let i=0;i<1000;i++){const t=performance.now();const r=await db.send(read(i%250));times.push(performance.now()-t);if(r.object.length!==1||r.object[0].src!=='x'.repeat(1024))throw Error('Warm response mismatch');}
 const warmTotalMs=performance.now()-warmStart;await db.close();
 process.stdout.write(JSON.stringify({coldFirstReadMs,warmReadCount:1000,warmOpsPerSecond:1e6/warmTotalMs,warm:stats(times),verified:true}));
}else{
 const directory=await fs.mkdtemp(join(tmpdir(),'coc-disk-benchmark-'));
 try{
  const db=open(directory),start=performance.now();for(let i=0;i<250;i++){const r=await db.send({...scope,method:'object.create',object:{_id:id(i),host:['*'],pathname:`/file-${i}.html`,src:'x'.repeat(1024),revision:0}});if(!r.success)throw Error(JSON.stringify(r.error));}
  await db.flush();const seedAndFlushMs=performance.now()-start;
  for(let i=0;i<50;i++){const r=await db.send({...scope,method:'object.update',object:{_id:id(i),$inc:{revision:1}}});if(!r.success)throw Error(JSON.stringify(r.error));}
  await db.close();
  let fileCount=0,sidecarCount=0,sidecarEntries=0,totalBytes=0;const walk=async dir=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else{fileCount++;totalBytes+=(await fs.stat(path)).size;if(entry.name==='.bytes'){sidecarCount++;const entries=JSON.parse(await fs.readFile(path,'utf8'));for(const[file,bytes]of Object.entries(entries)){if((await fs.stat(join(dir,file))).size!==bytes)throw Error('Stale sidecar entry');sidecarEntries++;}}}}};await walk(directory);
  const runs=[];for(let i=0;i<3;i++){const {stdout}=await promisify(execFile)(process.execPath,[new URL(import.meta.url).pathname,'--reader',directory],{maxBuffer:1024*1024});runs.push(JSON.parse(stdout));}
  const result={documents:250,updates:50,memoryOnly:false,externalPersistence:false,seedAndFlushMs,fileCount,sidecarCount,sidecarEntries,totalBytes,runs,verified:true};
  await fs.writeFile(new URL('./local-disk.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
