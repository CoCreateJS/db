from pathlib import Path
import shutil,tempfile
out=Path(__file__).parent;baseline=Path((out/'snapshot.txt').read_text().strip());root=Path(tempfile.mkdtemp(prefix='coc-db-traffic-sizing-'));shutil.copytree(baseline/'src',root/'src');(root/'node_modules').symlink_to('/home/ubuntu/Dev/CoCreateJS/modules/db/node_modules',target_is_directory=True)
p=root/'src/index/index.js';s=p.read_text();a=s.index('    const size = node => {');b=s.index('    // Preferred chunk size',a)
s=s[:a]+'''    const weights = new WeakMap();
    const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
    const weight = items => {
        let state = weights.get(items);
        if (!state || state.length !== items.length) {
            state = { length: items.length, sum: items.reduce((n,item) => n + jsonBytes(item),0) };
            weights.set(items,state);
        }
        return state;
    };
    const spliceItems = (items, at, count = items.length-at, ...added) => {
        const state = weight(items);
        const removed = items.splice(at,count,...added);
        state.sum += added.reduce((n,item)=>n+jsonBytes(item),0)-removed.reduce((n,item)=>n+jsonBytes(item),0);
        state.length = items.length;
        return removed;
    };
    const setItem = (items,at,value) => {
        const state=weight(items);
        state.sum += jsonBytes(value)-jsonBytes(items[at]);
        items[at]=value;
    };
    const size = node => {
        const start = performance.now();
        let bytes=2, count=0;
        for (const [key,value] of Object.entries(node)) {
            if(value===undefined)continue;
            if(count++)bytes++;
            bytes += jsonBytes(key)+1;
            if((key==='entries'||key==='indexes')&&Array.isArray(value))bytes += 2+weight(value).sum+Math.max(0,value.length-1);
            else bytes += jsonBytes(value);
        }
        if(globalThis.__verifyNodeSizes){const actual=jsonBytes(node);if(bytes!==actual)throw Error('Incorrect incremental size '+bytes+' != '+actual);}
        globalThis.__dbMetrics.sizeCalls++;
        globalThis.__dbMetrics.sizeBytes += bytes;
        globalThis.__dbMetrics.sizeMs += performance.now()-start;
        return bytes;
    };
'''+s[b:]
s=s.replace('items.splice(at)', 'spliceItems(items,at)').replace('node.entries.splice(at, 0, entry)', 'spliceItems(node.entries,at,0,entry)').replace('node.entries.splice(at, 1)', 'spliceItems(node.entries,at,1)').replace('node.indexes.splice(at, 1, ...children.map(catalogRef))','spliceItems(node.indexes,at,1,...children.map(catalogRef))').replace('node.indexes.splice(at, 1)','spliceItems(node.indexes,at,1)')
s=s.replace('''            node.indexes.splice(
                at,''','''            spliceItems(node.indexes,
                at,''')
s=s.replace('node.indexes[at] = ref(result.node)','setItem(node.indexes,at,ref(result.node))').replace('node.indexes[at] = catalogRef(result.node)','setItem(node.indexes,at,catalogRef(result.node))').replace('node.entries[at] = entry','setItem(node.entries,at,entry)')
p.write_text(s);(out/'snapshot-sizing.txt').write_text(str(root)+'\n');print(root)
