import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';

const targetKiB = Number(process.argv[2] || 128);
const seedCount = Number(process.env.BENCH_DOCS || 1500);
const readCount = Number(process.env.BENCH_READS || 2000);
const writeCount = Number(process.env.BENCH_WRITES || 150);
const updateCount = Number(process.env.BENCH_UPDATES || 400);
const mixedCount = Number(process.env.BENCH_MIXED || 1500);
const trial = process.env.BENCH_TRIAL || '1';
const serialize = process.env.BENCH_DISTRIBUTION !== 'local';
const acknowledgeSplits=process.env.BENCH_ACK_SPLITS==='1';
const peerOwned=new Set();let engine;let acknowledgedNewPartitions=0;
const variant = process.env.BENCH_VARIANT || 'base';
const source = (await fs.readFile(new URL(variant === 'base' ? './snapshot.txt' : `./snapshot-${variant}.txt`, import.meta.url), 'utf8')).trim();
const fresh = () => ({indexReads:0,indexWrites:0,sizeCalls:0,sizeBytes:0,sizeMs:0,splits:0,catalogSplits:0,queueWaitMs:0,maxQueueWaitMs:0,queueEvents:0,holderReads:0,holderUpdates:0,entityHolderReads:0,referenceBuilds:0,storageLookups:0,packets:0,wireBytes:0,duplicatePackets:0,duplicateBytes:0});
globalThis.__dbMetrics = fresh();
const { initializeServerDB } = await import(`${source}/src/server.js`);
const { memoryEntries, removeMemoryPath } = await import(`${source}/src/memory.js`);
const { addDistribution } = await import('/home/ubuntu/Dev/CoCreateJS/modules/utils/src/modules/distribution.js');
const root = `/tmp/coc-db-traffic-data-${process.pid}`;
const scope = {organization_id:'000000000000000000000001',storage:'bench',database:'app',array:'items',host:'bench.invalid'};
const clients = new Map(), lastFrames = new Map(), peerFrames = new Map();
const messageKinds = new Map();
let seq = 0, completed = 0, nextId = 0;
const objectId = n => (n+1).toString(16).padStart(24,'0');
const pathname = n => `/apps/${'long-directory-segment/'.repeat(7)}file-${String(n).padStart(8,'0')}.json`;
const expected = new Map();
const document = () => { const n = nextId++; expected.set(n,0);return {_id:objectId(n),pathname:pathname(n),rank:n,group:`g${n%32}`,revision:0,host:['*']}; };
const server = Object.assign(new EventEmitter(),{id:'traffic-node',isPrimary:true,workers:Object.assign(new Map(),{distribution:new Map()}),
 send:async payload => {if(payload.method==='db.distribution.set'){const d=payload.data;addDistribution(clients,d.distribution,d.clientId);}return{...payload,success:true};},
 cluster:Object.assign(new EventEmitter(),{send:(payload,prepared)=>{
   const m=globalThis.__dbMetrics;m.packets++;messageKinds.set(payload.method,(messageKinds.get(payload.method)||0)+1);
   if(serialize){const encoded=prepared ?? JSON.stringify(payload),bytes=Buffer.byteLength(encoded);m.wireBytes+=bytes;
     if(payload.method==='db.partition.update'){
       if(payload.operation==='remove')peerFrames.delete(payload.path);else peerFrames.set(payload.path,encoded);
       const key=JSON.stringify([payload.server,payload.path,payload.scope?.organization_id,payload.scope?.storageId]);
       const comparable=payload.uuid?encoded.replace(',"uuid":"'+payload.uuid+'"',''):encoded;
       if(lastFrames.get(key)===comparable){m.duplicatePackets++;m.duplicateBytes+=bytes;}lastFrames.set(key,comparable);
     }
   }
   if(acknowledgeSplits && engine && payload.method==='db.partition.update'){
     if(payload.operation==='remove'){
       peerOwned.delete(payload.path);
       return engine.updatePartition({partitionId:payload.path,nodeId:'peer',operation:'remove'});
     }
     if(!peerOwned.has(payload.path)){
       peerOwned.add(payload.path);acknowledgedNewPartitions++;
       return engine.updatePartition({partitionId:payload.path,nodeId:'peer',operation:'add'});
     }
   }
 }})});
const db=initializeServerDB(server,{directory:root,memoryOnly:true,memoryCache:true,externalPersistence:false,maxIndexBytes:targetKiB*1024});
const originalClone=globalThis.structuredClone;
globalThis.structuredClone=()=>{throw Error('Unexpected cloning in memory-only core');};
let maxBacklog=0;
const request=async(payload, register=true)=>{
 const index=seq++;
 const result=await db.send({...scope,...payload,timeStamp:new Date(Date.UTC(2026,0,1)+index).toISOString(),...(register?{clientId:`client-${index%16}`}:{})},register?{workerId:1+index%4}:{});
 if(result.success===false||(Array.isArray(result.error)?result.error.length:result.error))throw Error(JSON.stringify({method:payload.method,error:result.error}));
 maxBacklog=Math.max(maxBacklog,db.persistenceStats().pendingIndexes);
 return result;
};
const stats = values => {const a=[...values].sort((a,b)=>a-b);return{n:a.length,p50Ms:a[Math.floor(a.length*.5)]??0,p95Ms:a[Math.ceil(a.length*.95)-1]??0,p99Ms:a[Math.ceil(a.length*.99)-1]??0,maxMs:a.at(-1)??0};};
const phases=[];
async function phase(name,count,concurrency,operation){
 await db.flush();globalThis.__dbMetrics=fresh();messageKinds.clear();lastFrames.clear();maxBacklog=0;
 const latency=[],byType={};let cursor=0;const loop=monitorEventLoopDelay({resolution:10});loop.enable();const cpu=process.cpuUsage(),start=performance.now();
 await Promise.all(Array.from({length:concurrency},async()=>{while(cursor<count){const i=cursor++;const op=operation(i);const before=performance.now();const result=await request(op.payload);const ms=performance.now()-before;latency.push(ms);(byType[op.type]??=[]).push(ms);op.verify?.(result);completed++;await setImmediate();}}));
 const ackMs=performance.now()-start;await db.flush();const drainMs=performance.now()-start;const usage=process.cpuUsage(cpu);loop.disable();
 const row={name,count,concurrency,ackMs,drainMs,ackOpsPerSecond:count*1000/ackMs,drainedOpsPerSecond:count*1000/drainMs,latency:stats(latency),byType:Object.fromEntries(Object.entries(byType).map(([k,v])=>[k,stats(v)])),maxBacklog,cpuMs:(usage.user+usage.system)/1000,eventLoopP95Ms:loop.percentile(95)/1e6,metrics:{...globalThis.__dbMetrics},messageKinds:Object.fromEntries(messageKinds)};
 phases.push(row);console.log(JSON.stringify({targetKiB,name,ops:row.drainedOpsPerSecond,p50:row.latency.p50Ms,p95:row.latency.p95Ms,backlog:maxBacklog,sizeMs:row.metrics.sizeMs,wireMB:row.metrics.wireBytes/1e6,duplicates:row.metrics.duplicatePackets}));
}
const readId=i=>({type:'read-id',payload:{method:'object.read',object:{_id:objectId(i%seedCount)}},verify:r=>{if(r.object.length!==1||r.object[0]._id!==objectId(i%seedCount))throw Error('ID mismatch');}});
const readPath=i=>({type:'read-equality',payload:{method:'object.read',filter:{query:{host:{$in:['bench.invalid','*']},pathname:pathname(i%seedCount)},limit:1}},verify:r=>{if(r.object.length!==1||r.object[0].rank!==i%seedCount)throw Error('Equality mismatch');}});
const range=i=>{const lo=i%(seedCount-20);return{type:'read-range',payload:{method:'object.read',filter:{query:{rank:{$gte:lo,$lt:lo+20}}}},verify:r=>{if(r.object.length!==20||r.object.some(v=>v.rank<lo||v.rank>=lo+20))throw Error('Range mismatch');}};};
const create=()=>({type:'create',payload:{method:'object.create',object:document()}});
const update=i=>{const n=i%seedCount;expected.set(n,expected.get(n)+1);return{type:'update',payload:{method:'object.update',object:{_id:objectId(n),$inc:{revision:1},'profile.lastWrite':i}}};};
try{
 const seedStart=performance.now();for(let i=0;i<seedCount;i++){await request({method:'object.create',object:document()},false);if(i%16===0)await setImmediate();}await db.flush();const seedMs=performance.now()-seedStart;
 const storageId=(await request({method:'storage.read'},false)).storage[0]._id;
 engine=await db.forScope(scope);
 // One subscribed peer holds current regular partitions. Serialization is real;
 // remote processing and network latency are deliberately excluded.
 const heldPartitions = serialize ? await engine.listPartitions() : [];
 if(serialize)for(const {partitionId}of heldPartitions){
   const value=await db.readIndexPartition(partitionId);
   peerFrames.set(partitionId,JSON.stringify({value}));peerOwned.add(partitionId);
   await engine.updatePartition({partitionId,nodeId:'peer',operation:'add'});
 }
 const registered=await request({method:'object.read',object:{_id:objectId(0)}});const stableReference=registered.distribution.find(r=>r.endsWith(`/objects/${objectId(0)}.json`));
 const mapSize=server.workers.distribution.size;
 const changed=await request({method:'object.update',object:{_id:objectId(0),pathname:pathname(0)+'-changed'}});
 if(!changed.distribution.includes(stableReference)||server.workers.distribution.size!==mapSize)throw Error('Unstable recipient reference after value change');
 if((await request({method:'object.read',filter:{query:{pathname:pathname(0)}}})).object.length)throw Error('Old pathname remained readable');
 await request({method:'object.update',object:{_id:objectId(0),pathname:pathname(0)}});await db.flush();
 for(const concurrency of [1,16]){
   await phase(`id-c${concurrency}`,readCount,concurrency,readId);
   await phase(`equality-c${concurrency}`,readCount,concurrency,readPath);
   await phase(`range-c${concurrency}`,Math.max(100,Math.floor(readCount/10)),concurrency,range);
   await phase(`create-c${concurrency}`,writeCount,concurrency,create);
   await phase(`update-c${concurrency}`,updateCount,concurrency,update);
 }
 await phase('mixed-c16',mixedCount,16,i=>i%10<7?(i%2?readId(i):readPath(i)):i%10<9?update(i):create());
 for(const[n,revision]of expected){const r=await request({method:'object.read',object:{_id:objectId(n)}},false);if(r.object.length!==1||r.object[0].revision!==revision)throw Error('Lost update for '+n);}
 await db.flush();
 const entries=memoryEntries(root);
 let verifiedHeldPartitions=0;
 const currentFiles=new Map(entries.map(([path,value])=>[path.slice(root.length+1),value]));
 for(const partitionId of (acknowledgeSplits ? peerOwned : heldPartitions.map(p=>p.partitionId))){
   const current=currentFiles.get(partitionId);
   const received=peerFrames.has(partitionId)?JSON.parse(peerFrames.get(partitionId)).value:undefined;
   if(JSON.stringify(current)!==JSON.stringify(received))throw Error('Stale peer partition: '+partitionId);
   verifiedHeldPartitions++;
 }
 const nodes=new Map(entries.filter(([p,v])=>p.includes('/index/')&&v?.id).map(([p,v])=>[p,v]));
 const shape={};
 const storageRoot=`${root}/${scope.organization_id}/storages/${storageId}`;
 for(const key of ['_id','pathname','rank','revision','profile.lastWrite']){
  const catalog=await db.index.get(scope,'app','items',key);const branch=catalog.indexes.string??catalog.indexes.number;if(!branch)continue;
  const prefix=[...nodes.keys()].find(p=>p.startsWith(storageRoot)&&p.endsWith(`/index/${branch.id}.json`))?.split('/index/')[0];
  let depth=0,leafCount=0,nodeCount=0,minLeaf=Infinity,maxLeaf=0;const walk=(node,level)=>{nodeCount++;depth=Math.max(depth,level);if(node.entries){leafCount++;minLeaf=Math.min(minLeaf,node.entries.length);maxLeaf=Math.max(maxLeaf,node.entries.length);}else for(const child of node.indexes)walk(nodes.get(`${prefix}/index/${child.id}.json`),level+1);};walk(branch,1);shape[key]={depth,leafCount,nodeCount,minLeaf,maxLeaf};
 }
 const nodeSizes=[...nodes].map(([p,v])=>({path:p.replace(root,''),bytes:Buffer.byteLength(JSON.stringify(v)),distribution:p.includes('/distribution/')}));
 let rootExists=true;try{await fs.access(root);}catch{rootExists=false;}if(rootExists)throw Error('Persistence was used');
 const result={harness:acknowledgeSplits?'per-client-yield-v2-with-split-acks':'per-client-yield-v2',acknowledgeSplits,acknowledgedNewPartitions,targetKiB,seedCount,trial,variant,distribution:serialize?'one-peer-serialization':'local',memoryOnly:true,seedMs,phases,shape,cache:{files:entries.length,indexNodes:nodes.size,maxNodeBytes:Math.max(...nodeSizes.map(n=>n.bytes)),serializedNodeBytes:nodeSizes.reduce((n,v)=>n+v.bytes,0),distributionNodes:nodeSizes.filter(n=>n.distribution).length},stableReference,recipientReferences:server.workers.distribution.size,clientReferences:clients.size,verifiedDocuments:expected.size,verifiedHeldPartitions,rootExists,nodeSizes,environment:{node:process.version,cpu:os.cpus()[0].model,cpuCount:os.cpus().length},source};
 await fs.writeFile(new URL(`./${targetKiB}-${serialize?'peer':'local'}-${trial}${variant==='base'?'':'-'+variant}.json`,import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify({finished:true,targetKiB,seedMs,shape,verified:expected.size}));
}finally{globalThis.structuredClone=originalClone;await db.close();removeMemoryPath(root);}
