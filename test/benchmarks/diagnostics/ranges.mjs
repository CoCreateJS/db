import assert from 'node:assert/strict'
import {queryData} from '@cocreate/utils'
import {Tree} from '../../../src/tree/index.js'
for(const size of [1000,10000,100000]){
 const tree=new Tree(64)
 for(let value=0;value<size;value++)tree.insert({value,uuid:String(value).padStart(8,'0'),object:{rank:value}})
 const min=size*.4,max=size*.6,query={rank:{$gte:min,$lt:max}}
 const methods={binaryDirect:()=>{let count=0;for(const e of tree.scan(min,max))if(e.value<max)count++;return count},binaryQueryData:()=>{let count=0;for(const e of tree.scan(min,max))if(queryData(e.object,query))count++;return count},fullQueryData:()=>{let count=0;for(const e of tree.scan())if(queryData(e.object,query))count++;return count}}
 const times=Object.fromEntries(Object.keys(methods).map(k=>[k,[]]));for(const f of Object.values(methods))for(let i=0;i<20;i++)assert.equal(f(),max-min)
 for(let i=0;i<100;i++){const keys=Object.keys(methods);for(let j=0;j<keys.length;j++){const k=keys[(i+j)%keys.length],start=performance.now(),count=methods[k]();times[k].push(performance.now()-start);assert.equal(count,max-min)}}
 console.log(JSON.stringify({size,matches:max-min,p50Ms:Object.fromEntries(Object.entries(times).map(([k,v])=>[k,v.sort((a,b)=>a-b)[49]]))}))
}
