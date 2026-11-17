import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const variant=process.env.INDEX_VARIANT||'base';
const source=(await fs.readFile(new URL(variant==='base'?'./snapshot.txt':`./snapshot-${variant}.txt`,import.meta.url),'utf8')).trim();
globalThis.__verifyNodeSizes=process.env.VERIFY_SIZES==='1';
const {createIndex}=await import(`${source}/src/index/index.js`);
const {enableMemoryCache,memoryEntries,removeMemoryPath}=await import(`${source}/src/memory.js`);
const n=Number(process.env.INDEX_ENTRIES||20000),results=[];
const targetList=(process.env.INDEX_TARGETS||'128,300,512,1024').split(',').map(Number);
const metrics=()=>new Proxy({},{get:(t,k)=>t[k]??0});
const id=v=>(v+1).toString(16).padStart(24,'0');
const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1];
const original=globalThis.structuredClone;globalThis.structuredClone=()=>{throw Error('Cloning not allowed');};
try{for(const targetKiB of targetList){
 const root=`/tmp/coc-index-load-${targetKiB}-${process.pid}`;enableMemoryCache(root,{memoryOnly:true});const index=createIndex({directory:root,maxBytes:targetKiB*1024});
 globalThis.__dbMetrics=metrics();let start=performance.now();
 for(let i=0;i<n;i++){const v=(i*7919)%n;await index.set('app','items','rank',v,id(v));}
 const createMs=performance.now()-start,createMetrics={...globalThis.__dbMetrics};
 const rows={};
 for(const [name,count,width]of[['equality',3000,0],['bounded-range',1000,20]]){
  const times=[];globalThis.__dbMetrics=metrics();start=performance.now();
  for(let i=0;i<count;i++){const lo=(i*13)%(n-20);const t=performance.now();let hits=0;
   for await(const entry of index.scan('app','items','rank',{type:'number',lower:lo,upper:lo+width,upperOpen:width>0})){if(entry.objectId!==id(entry.value))throw Error('wrong index mapping');hits++;}
   if(hits!==(width||1))throw Error('Wrong candidate count');times.push(performance.now()-t);
  }
  rows[name]={count,p50Ms:percentile(times,.5),p95Ms:percentile(times,.95),opsPerSecond:count*1000/(performance.now()-start),nodeReadsPerRequest:globalThis.__dbMetrics.indexReads/count};
 }
 globalThis.__dbMetrics=metrics();start=performance.now();
 for(let i=0;i<500;i++){await index.remove('app','items','rank',i,id(i));await index.set('app','items','rank',n+i,id(i));}
 const updateMs=performance.now()-start,updateMetrics={...globalThis.__dbMetrics};
 let count=0,sum=0;for await(const entry of index.scan('app','items','rank',{type:'number'})){count++;sum+=entry.value;}
 if(count!==n||sum!==n*(n-1)/2+500*n)throw Error('Index update verification failed');
 const branch=(await index.get('app','items','rank')).indexes.number;const files=new Map(memoryEntries(root));let nodes=0,leaves=0,depth=0;const walk=(node,d)=>{nodes++;depth=Math.max(depth,d);if(node.entries)leaves++;else for(const child of node.indexes)walk(files.get(`${root}/app/items/index/${child.id}.json`),d+1);};walk(branch,1);
 await fs.access(root).then(()=>{throw Error('Memory-only mode wrote files');},()=>{});
 const row={variant,targetKiB,n,leafEntryLimit:variant==='counts'?Math.max(2,Math.floor(targetKiB*1024/36)):null,createMs,createOpsPerSecond:n*1000/createMs,createMetrics,updateMs,updatesPerSecond:500*1000/updateMs,updateMetrics,rows,shape:{nodes,leaves,depth},verified:true};results.push(row);console.log(JSON.stringify(row));removeMemoryPath(root);
}await fs.writeFile(new URL(process.env.INDEX_TRIAL?`./index-only-${variant}-trial-${process.env.INDEX_TRIAL}.json`:variant==='base'?'./index-only.json':`./index-only-${variant}.json`,import.meta.url),JSON.stringify(results,null,2));}finally{globalThis.structuredClone=original;}
