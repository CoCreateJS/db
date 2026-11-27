import { uuid } from '@cocreate/utils'
const UUID = Symbol('indexUuid')
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0
export const order = (a,b) => compare(a.value,b.value) || compare(a.uuid,b.uuid)
export function lower(items,value,compare){
    let first=0,last=items.length
    while(first<last){const middle=(first+last)>>>1; if(compare(items[middle],value)<0) first=middle+1; else last=middle}
    return first
}
class Branch {
    constructor(parent=null,tree=parent?.tree,data){
        this[UUID]=data?.uuid??uuid();this.tree=tree;this.onDisk=false;this.parent=parent
        this.parentUuid=parent?.uuid??data?.parent??null;this.previousUuid=data?.previous??null;this.nextUuid=data?.next??null
        if(data?.branches){this.branches=data.branches.map(ref=>({...ref}));delete this.entries}
        else if(data?.entries)this.entries=data.entries.map(([value,ids])=>[value,ids.map(id=>tree.local.restore(id,this,value))])
        else this.entries=[]
        this.length=data?.length??0;this.firstValue=data?.firstValue;this.lastValue=data?.lastValue;this.firstUuid=data?.firstUuid;this.lastUuid=data?.lastUuid
        if(!data)this.refresh()
        tree?.local?.add(this)
    }
    get uuid(){return this[UUID]}
    getUuid(){return this[UUID]}
    async toMemory() {
        if (!this.onDisk) return this
        const local = this.tree?.local
        if (!local) throw Error('Cannot hydrate an index without storage')
        const resident=await this.tree?.loadUuid?.(this.uuid)
        if(resident&&resident!==this)return resident
        const data = await local.read(this)
        if(!this.parent&&data.parent)this.parent=await this.tree.loadUuid(data.parent)
        await this.restore(data)
        const siblings=this.parent?.branches
        const position=siblings?.findIndex(ref=>ref!==this&&ref.uuid===this.uuid)??-1
        if(position>=0)siblings[position]=this
        return this
    }
    restore(data) {
        this.parentUuid=this.parent?.uuid??data.parent??null;this.previousUuid=data.previous??null;this.nextUuid=data.next??null
        if(data.branches){this.branches=data.branches.map(ref=>({...ref}));delete this.entries}
        else this.entries=data.entries.map(([value,ids])=>[value,ids.map(id=>this.tree.local.restore(id,this,value))])
        this.length=data.length??0;this.firstValue=data.firstValue;this.lastValue=data.lastValue;this.firstUuid=data.firstUuid;this.lastUuid=data.lastUuid
        this.onDisk = false
        this.tree.local.add(this)
        return this
    }
    async getParent(){const current=await this.toMemory();if(current!==this)return current.getParent();const parent=this.parent?await this.parent.toMemory():this.parentUuid?await this.tree?.loadUuid(this.parentUuid):null;return parent??null}
    async getPrevious(){const current=await this.toMemory();if(current!==this)return current.getPrevious();const previous=await this.neighbor(-1)??(this.previousUuid&&await this.tree?.loadUuid(this.previousUuid));return previous?await previous.toMemory():null}
    async getNext(){const current=await this.toMemory();if(current!==this)return current.getNext();const next=await this.neighbor(1)??(this.nextUuid&&await this.tree?.loadUuid(this.nextUuid));return next?await next.toMemory():null}
    get previous(){return this.getPrevious()}
    get next(){return this.getNext()}
    async neighbor(direction){
        let node=this,depth=0
        while(node.parent){
            const siblings=node.parent.branches, adjacent=siblings[siblings.indexOf(node)+direction]
            if(adjacent){
                let result=await this.tree.resolveChild(node.parent,siblings.indexOf(adjacent))
                for(let i=0;i<depth;i++)result=await this.tree.resolveChild(result,direction<0?result.branches.length-1:0)
                return result
            }
            node=node.parent;depth++
        }
        return null
    }
    neighborUuid(direction){
        let node=this,depth=0
        while(node.parent){
            const siblings=node.parent.branches,index=siblings.indexOf(node),adjacent=siblings[index+direction]
            if(adjacent){
                let ref=adjacent
                for(let i=0;i<depth;i++){
                    const children=ref.branches
                    if(!children?.length)break
                    ref=children[direction<0?children.length-1:0]
                }
                return ref?.uuid
            }
            node=node.parent;depth++
        }
        return undefined
    }
    async getData(){
        if(this.onDisk)throw Error('Index must be loaded before serialization');const data={parent:this.parent?.getUuid()??this.parentUuid??null,previous:this.neighborUuid(-1)??this.previousUuid??null,next:this.neighborUuid(1)??this.nextUuid??null,length:this.length,firstValue:this.firstValue,lastValue:this.lastValue,firstUuid:this.firstUuid,lastUuid:this.lastUuid}
        if(this.branches)data.branches=this.branches.map(p=>this.tree.reference(p))
        else data.entries=this.entries.map(([value,entries])=>[value,entries.map(entry=>entry.uuid)])
        return data
    }
    reference(){return {uuid:this.getUuid(),length:this.length,firstValue:this.firstValue,lastValue:this.lastValue,firstUuid:this.firstUuid,lastUuid:this.lastUuid}}
    async getFile(){return {uuid:this.getUuid(),content:JSON.stringify(await this.getData())}}
    refreshBounds(){
        this.tree?.local?.dirty.add(this)
        const first=this.branches?.[0],last=this.branches?.at(-1)
        this.firstValue=this.branches ? first?.firstValue : this.entries[0]?.[0]
        this.lastValue=this.branches ? last?.lastValue : this.entries.at(-1)?.[0]
        this.firstUuid=this.branches ? first?.firstUuid : this.entries[0]?.[1][0].uuid
        this.lastUuid=this.branches ? last?.lastUuid : this.entries.at(-1)?.[1].at(-1).uuid
    }
    refresh(){
        this.length=this.branches ? this.branches.reduce((n,p)=>n+p.length,0) : this.entries.reduce((n,g)=>n+g[1].length,0)
        this.refreshBounds()
    }
}
const lastOf=p=>({value:p.lastValue,uuid:p.lastUuid})
const firstOf=p=>({value:p.firstValue,uuid:p.firstUuid})
export class Tree {
    constructor(size=1024,local=null,key=null,leafSize=size,rootUuid){if(size<2||leafSize<2)throw Error('index size');this.size=size;this.leafSize=leafSize;this.local=local;this.key=key;this.rootUuid=rootUuid;this.root=new Branch(null,this,rootUuid?{uuid:rootUuid}:undefined);this.initialized=!rootUuid}
    async initialize() {
        if (this.initialized) return this
        this.initializing ??= (async () => {
            const data = await this.local.readByUuid(this.rootUuid)
            this.root.restore(data)
            this.initialized = true
            return this
        })().finally(() => { this.initializing = undefined })
        return this.initializing
    }
    reference(index){return index instanceof Branch?index.reference():index}
    async resolveChild(parent,index){
        const ref=parent.branches[index]
        if(ref instanceof Branch)return ref.toMemory()
        if(!ref||typeof ref.uuid!=='string')throw Error('Invalid child index reference')
        const data=await this.local?.readByUuid(ref.uuid)
        if(!data)throw Error('Missing index '+ref.uuid)
        if(parent.branches[index] instanceof Branch)return parent.branches[index].toMemory()
        const node=new Branch(parent,this,{uuid:ref.uuid})
        parent.branches[index]=node
        await node.restore(data)
        return node
    }
    release() {
        const visit = branch => {
            if (!branch.tree) return
            for (const child of branch.branches ?? []) visit(child)
            this.local?.remove(branch)
            this.local?.dirty.delete(branch)
            delete branch.entries
            delete branch.branches
            branch.parent = null
        }
        visit(this.root)
        this.rootUuid = this.root.uuid
        this.root = new Branch(null, this, { uuid: this.rootUuid })
        this.local?.remove(this.root)
        this.initialized = false
    }
    async findUuid(id,node=this.root){
        if(node.uuid===id)return node
        await node.toMemory()
        if(!node.branches)return undefined
        for(let i=0;i<node.branches.length;i++){
            const ref=node.branches[i]
            if(ref.uuid===id){const found=await this.resolveChild(node,i);return found}
            if(ref instanceof Branch&&ref.branches){const found=await this.findUuid(id,ref);if(found)return found}
        }
    }
    async findUuidDeep(id,node=this.root){
        if(node.uuid===id)return await node.toMemory()
        node=await node.toMemory()
        if(!node.branches)return undefined
        for(let i=0;i<node.branches.length;i++){
            const ref=node.branches[i]
            if(ref.uuid===id){const found=await this.resolveChild(node,i);return found}
            const child=await this.resolveChild(node,i)
            const found=await this.findUuidDeep(id,child)
            if(found)return found
        }
    }
    async loadUuid(id){
        await this.initialize()
        const resident=await this.findUuid(id)
        if(resident)return resident
        if(!this.local)return undefined
        let data
        try{data=await this.local.readByUuid(id)}catch(error){if(error.code==='ENOENT'||error.name==='NotFoundError')return undefined;throw error}
        if(!data)return undefined
        const parent=data.parent?(await this.findUuid(data.parent)??await this.loadUuid(data.parent)):null
        const node=new Branch(parent,this,{uuid:id})
        if(parent?.branches){const index=parent.branches.findIndex(ref=>ref.uuid===id);if(index>=0)parent.branches[index]=node}
        await node.restore(data)
        return node
    }
    async locate(entry,node=this.root){await this.initialize();await node.toMemory();while(node.branches){const at=Math.min(lower(node.branches,entry,(p,e)=>order(lastOf(p),e)),node.branches.length-1);node=await this.resolveChild(node,at)}return node.toMemory()}
    async lookup(value, uuid) {
        const node = await this.locate({ value, uuid })
        const group = node.entries[lower(node.entries, value, (group, value) => compare(group[0], value))]
        if (!group || compare(group[0], value)) return undefined
        const entry = group[1][lower(group[1], uuid, (entry, uuid) => compare(entry.uuid, uuid))]
        return entry?.uuid === uuid ? entry : undefined
    }
    locateResident(entry,node=this.root){
        if(!this.initialized||node.onDisk)return
        while(node.branches){
            if(!node.branches.length)return node
            const at=Math.min(lower(node.branches,entry,(branch,value)=>order(lastOf(branch),value)),node.branches.length-1)
            node=node.branches[at]
            if(!(node instanceof Branch)||node.onDisk)return
        }
        return node.entries?node:undefined
    }
    insertAt(node,entry){
        const i=lower(node.entries,entry.value,(g,v)=>compare(g[0],v))
        let group=node.entries[i]
        if(!group||compare(group[0],entry.value)!==0){group=[entry.value,[]];node.entries.splice(i,0,group)}
        const j=lower(group[1],entry.uuid,(e,u)=>compare(e.uuid,u))
        let added=true
        if(group[1][j]?.uuid===entry.uuid){
            if(group[1][j]===entry){entry.index=node;entry.tree=this;return}
            const old=group[1][j];old.index=null;old.releaseObject?.();group[1][j]=entry
            added=false
        }else group[1].splice(j,0,entry)
        entry.index=node;entry.tree=this
        if(this.resolveLeaf||this.local?.resolveLeaf)entry.releaseObject?.()
        if(added){for(let branch=node;branch;branch=branch.parent)branch.length++;this.refreshInserted(node)}
        else this.refresh(node)
    }
    insert(entry,start=this.root){
        const node=this.locateResident(entry,start)
        if(node)return this.insertAt(node,entry)
        return this.locate(entry,start).then(node=>this.insertAt(node,entry))
    }
    async insertMany(entries){
        for(const entry of entries){
            const result=this.insert(entry)
            if(result?.then)await result
        }
        return entries.length
    }
    refreshInserted(node){
        while(node){
            node.refreshBounds()
            const count=node.branches?.length??node.length
            const capacity=node.branches?this.size:this.leafSize
            if(count>capacity)this.split(node)
            node=node.parent
        }
    }
    refresh(node){
        while (node) {
            node.refresh()
            const count = node.branches?.length ?? node.length
            const capacity = node.branches ? this.size : this.leafSize
            if (count > capacity) this.split(node)
            node = node.parent
        }
    }
    split(node){
        const right=new Branch(node.parent,this)
        if(node.branches){right.branches=node.branches.splice(Math.ceil(node.branches.length/2));delete right.entries;for(const p of right.branches)if(p instanceof Branch){p.parent=right;p.parentUuid=right.uuid}}
        else {
            const cut=Math.ceil(node.length/2);let count=0,i=0
            while(count+node.entries[i][1].length<cut)count+=node.entries[i++][1].length
            const group=node.entries[i],offset=cut-count
            right.entries=node.entries.splice(i+1)
            if(offset<group[1].length)right.entries.unshift([group[0],group[1].splice(offset)])
            for(const [,entries] of right.entries)for(const entry of entries)entry.index=right
        }
        node.refresh();right.refresh()
        if(!node.parent){const root=new Branch(null,this);delete root.entries;root.branches=[node,right];root.length=node.length+right.length;node.parent=right.parent=root;node.parentUuid=right.parentUuid=root.uuid;this.root=root}
        else {right.parent.branches.splice(right.parent.branches.indexOf(node)+1,0,right);right.parentUuid=right.parent.uuid}
    }
    async remove(entry){
        const node=await entry.index.toMemory();const i=lower(node.entries,entry.value,(g,v)=>compare(g[0],v)),group=node.entries[i]
        const j=lower(group[1],entry.uuid,(e,u)=>compare(e.uuid,u));if(group[1][j]!==entry)throw Error('missing index entry')
        group[1].splice(j,1);if(!group[1].length)node.entries.splice(i,1);entry.index=null
        let p=node
        while(p){p.refresh();const parent=p.parent;if(!p.length&&parent){parent.branches.splice(parent.branches.indexOf(p),1);await this.local?.discard(p);p.parent=null;p.parentUuid=null}p=parent}
        while(this.root.branches?.length===1){const old=this.root;this.root=await this.resolveChild(old,0);this.root.parent=null;this.root.parentUuid=null;await this.local?.discard(old)}
        if(!this.root.length){await this.local?.discard(this.root);this.root=new Branch(null,this)}
    }
    async move(entry,value,write){
        let start=entry.index;const target={value,uuid:entry.uuid}
        await start.toMemory()
        while(start.parent&&(order(target,firstOf(start))<0||order(target,lastOf(start))>0))start=start.parent
        await this.remove(entry);await write();if(!start.length||(!start.parent&&start!==this.root))start=this.root
        await this.insert(entry,start)
    }
    async *scan(min,max,node=this.root){
        await this.initialize()
        await node.toMemory()
        if(!node.length)return
        if(min!==undefined&&compare(node.lastValue,min)<0||max!==undefined&&compare(node.firstValue,max)>0)return
        if(node.branches){const i=min===undefined?0:lower(node.branches,min,(p,v)=>compare(p.lastValue,v));for(let j=i;j<node.branches.length;j++){const ref=node.branches[j];if(max!==undefined&&compare(ref.firstValue,max)>0)break;yield* this.scan(min,max,await this.resolveChild(node,j))}}
        else {const i=min===undefined?0:lower(node.entries,min,(g,v)=>compare(g[0],v));for(let j=i;j<node.entries.length;j++){const [value,entries]=node.entries[j];if(max!==undefined&&compare(value,max)>0)break;yield* entries}}
    }
}
