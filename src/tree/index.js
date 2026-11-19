const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0
export const order = (a,b) => compare(a.value,b.value) || compare(a.uuid,b.uuid)
export function lower(items,value,compare){
    let first=0,last=items.length
    while(first<last){const middle=(first+last)>>>1; if(compare(items[middle],value)<0) first=middle+1; else last=middle}
    return first
}
class Partition {
    constructor(parent=null){this.parent=parent;this.entries=[];this.length=0;this.refresh()}
    refresh(){
        const first=this.indexes?.[0],last=this.indexes?.at(-1)
        this.length=this.indexes ? this.indexes.reduce((n,p)=>n+p.length,0) : this.entries.reduce((n,g)=>n+g[1].length,0)
        this.firstValue=this.indexes ? first?.firstValue : this.entries[0]?.[0]
        this.lastValue=this.indexes ? last?.lastValue : this.entries.at(-1)?.[0]
        this.firstUuid=this.indexes ? first?.firstUuid : this.entries[0]?.[1][0].uuid
        this.lastUuid=this.indexes ? last?.lastUuid : this.entries.at(-1)?.[1].at(-1).uuid
    }
}
const lastOf=p=>({value:p.lastValue,uuid:p.lastUuid})
const firstOf=p=>({value:p.firstValue,uuid:p.firstUuid})
export class Tree {
    constructor(size=64){if(size<2)throw Error('partition size');this.size=size;this.root=new Partition()}
    locate(entry,node=this.root){while(node.indexes)node=node.indexes[Math.min(lower(node.indexes,entry,(p,e)=>order(lastOf(p),e)),node.indexes.length-1)];return node}
    insert(entry,start=this.root){
        const node=this.locate(entry,start), i=lower(node.entries,entry.value,(g,v)=>compare(g[0],v))
        let group=node.entries[i]
        if(!group||compare(group[0],entry.value)!==0){group=[entry.value,[]];node.entries.splice(i,0,group)}
        const j=lower(group[1],entry.uuid,(e,u)=>compare(e.uuid,u))
        if(group[1][j]?.uuid===entry.uuid)throw Error('duplicate index entry')
        group[1].splice(j,0,entry);entry.partition=node;entry.tree=this
        this.refresh(node)
    }
    refresh(node){
        while(node){node.refresh();if((node.indexes?.length??node.length)>this.size)this.split(node);node=node.parent}
    }
    split(node){
        const right=new Partition(node.parent)
        if(node.indexes){right.indexes=node.indexes.splice(Math.ceil(node.indexes.length/2));delete right.entries;for(const p of right.indexes)p.parent=right}
        else {
            const cut=Math.ceil(node.length/2);let count=0,i=0
            while(count+node.entries[i][1].length<cut)count+=node.entries[i++][1].length
            const group=node.entries[i],offset=cut-count
            right.entries=node.entries.splice(i+1)
            if(offset<group[1].length)right.entries.unshift([group[0],group[1].splice(offset)])
            for(const [,entries] of right.entries)for(const entry of entries)entry.partition=right
        }
        node.refresh();right.refresh()
        if(!node.parent){const root=new Partition();delete root.entries;root.indexes=[node,right];node.parent=right.parent=root;this.root=root}
        else node.parent.indexes.splice(node.parent.indexes.indexOf(node)+1,0,right)
    }
    remove(entry){
        const node=entry.partition,i=lower(node.entries,entry.value,(g,v)=>compare(g[0],v)),group=node.entries[i]
        const j=lower(group[1],entry.uuid,(e,u)=>compare(e.uuid,u));if(group[1][j]!==entry)throw Error('missing index entry')
        group[1].splice(j,1);if(!group[1].length)node.entries.splice(i,1);entry.partition=null
        let p=node
        while(p){p.refresh();const parent=p.parent;if(!p.length&&parent){parent.indexes.splice(parent.indexes.indexOf(p),1);p.parent=null}p=parent}
        while(this.root.indexes?.length===1){this.root=this.root.indexes[0];this.root.parent=null}
        if(!this.root.length)this.root=new Partition()
    }
    move(entry,value,write){
        let start=entry.partition;const target={value,uuid:entry.uuid}
        while(start.parent&&(order(target,firstOf(start))<0||order(target,lastOf(start))>0))start=start.parent
        this.remove(entry);write();if(!start.length||(!start.parent&&start!==this.root))start=this.root
        this.insert(entry,start)
    }
    *scan(min,max,node=this.root){
        if(!node.length)return
        if(min!==undefined&&compare(node.lastValue,min)<0||max!==undefined&&compare(node.firstValue,max)>0)return
        if(node.indexes){const i=min===undefined?0:lower(node.indexes,min,(p,v)=>compare(p.lastValue,v));for(let j=i;j<node.indexes.length;j++){const p=node.indexes[j];if(max!==undefined&&compare(p.firstValue,max)>0)break;yield* this.scan(min,max,p)}}
        else {const i=min===undefined?0:lower(node.entries,min,(g,v)=>compare(g[0],v));for(let j=i;j<node.entries.length;j++){const [value,entries]=node.entries[j];if(max!==undefined&&compare(value,max)>0)break;yield* entries}}
    }
}
