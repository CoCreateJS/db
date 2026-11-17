from pathlib import Path
import shutil,tempfile
out=Path(__file__).parent;base=Path((out/'snapshot.txt').read_text().strip());root=Path(tempfile.mkdtemp(prefix='coc-db-traffic-counts-'));shutil.copytree(base/'src',root/'src');(root/'node_modules').symlink_to('/home/ubuntu/Dev/CoCreateJS/modules/db/node_modules',target_is_directory=True)
p=root/'src/index/index.js';s=p.read_text();a=s.index('    const shouldSplit = node =>');b=s.index('\n\n',a)
s=s[:a]+'''    const maxLeafEntries = Math.max(2, Math.floor(maxBytes / 36));
    const shouldSplit = node => node.entries ? node.entries.length > maxLeafEntries : node.indexes.length > 64;'''+s[b:]
for name in ['splitCatalogNode','split']:
 a=s.index(f'    const {name} = node =>');start=s.index('        const weights =',a);end=s.index('        const moved =',start)
 s=s[:start]+'''        const at = Math.ceil(items.length / 2);

'''+s[end:]
p.write_text(s);(out/'snapshot-counts.txt').write_text(str(root)+'\n');print(root)
