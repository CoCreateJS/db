from pathlib import Path
import tempfile,shutil,json,hashlib
root=Path('/home/ubuntu/Dev/CoCreateJS/modules/db'); out=Path(__file__).parent
snapshot=Path(tempfile.mkdtemp(prefix='coc-db-traffic-source-'));shutil.copytree(root/'src',snapshot/'src');(snapshot/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
p=snapshot/'src/index/index.js';s=p.read_text();s=s.replace('    const readJSON = async file => {','    const readJSON = async file => {\n        globalThis.__dbMetrics.indexReads++;')
s=s.replace('    const writeJSON = async (file, value, { acquired = false, notify = true } = {}) => {','    const writeJSON = async (file, value, { acquired = false, notify = true } = {}) => {\n        globalThis.__dbMetrics.indexWrites++;')
s=s.replace('    const size = node => Buffer.byteLength(JSON.stringify(node))','''    const size = node => {
        const start = performance.now();
        const bytes = Buffer.byteLength(JSON.stringify(node));
        globalThis.__dbMetrics.sizeCalls++;
        globalThis.__dbMetrics.sizeBytes += bytes;
        globalThis.__dbMetrics.sizeMs += performance.now() - start;
        return bytes;
    }''')
s=s.replace('    const split = node => {','    const split = node => {\n        globalThis.__dbMetrics.splits++;').replace('    const splitCatalogNode = node => {','    const splitCatalogNode = node => {\n        globalThis.__dbMetrics.catalogSplits++;');p.write_text(s)
p=snapshot/'src/server.js';s=p.read_text().replace('''        const result = transactionQueue.then(() => withPropagation(operation))''','''        const queued = performance.now();
        const result = transactionQueue.then(() => {
            const wait = performance.now() - queued;
            globalThis.__dbMetrics.queueWaitMs += wait;
            globalThis.__dbMetrics.maxQueueWaitMs = Math.max(globalThis.__dbMetrics.maxQueueWaitMs, wait);
            globalThis.__dbMetrics.queueEvents++;
            return withPropagation(operation);
        })''');p.write_text(s)
p=snapshot/'src/distribution.js';s=p.read_text().replace("    const getPartition = async partitionId => {", "    const getPartition = async partitionId => {\n        globalThis.__dbMetrics.holderReads++;").replace("    const get = async ({ databaseId, arrayId, objectId }) => {", "    const get = async ({ databaseId, arrayId, objectId }) => {\n        globalThis.__dbMetrics.entityHolderReads++;")
s=s.replace("    const updatePartition = ({ partitionId, nodeId, operation }) => serialize(async () => {", "    const updatePartition = ({ partitionId, nodeId, operation }) => serialize(async () => {\n        globalThis.__dbMetrics.holderUpdates++;")
s=s.replace("    const valid = value => typeof value", "    globalThis.__dbMetrics.referenceBuilds++;\n    const valid = value => typeof value");p.write_text(s)
p=snapshot/'src/scoped.js';s=p.read_text().replace('    const findStorage = async (organization, storage) => {','    const findStorage = async (organization, storage) => {\n        globalThis.__dbMetrics.storageLookups++;');p.write_text(s)
(out/'snapshot.txt').write_text(str(snapshot)+'\n');(out/'source-fingerprints.json').write_text(json.dumps({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest()for p in (root/'src').rglob('*.js')},indent=2)+'\n');print(snapshot)
