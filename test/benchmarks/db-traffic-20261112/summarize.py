from pathlib import Path
import json,statistics,hashlib,tarfile
p=Path(__file__).parent
repo=Path('/home/ubuntu/Dev/CoCreateJS/modules/db')
load=lambda f:json.loads((p/f).read_text())
fingerprints=load('source-fingerprints.json')
changed=[f for f,h in fingerprints.items() if hashlib.sha256((repo/f).read_bytes()).hexdigest()!=h]
assert not changed,changed
full=[]
for f in ['128-peer-2.json','300-peer-2.json','512-peer-2.json','128-peer-2-both.json','128-peer-2-all.json']:
 d=load(f); phases={v['name']:v for v in d['phases']}
 full.append(dict(file=f,variant=d['variant'],targetKiB=d['targetKiB'],seedMs=d['seedMs'],verifiedDocuments=d['verifiedDocuments'],verifiedHeldPartitions=d.get('verifiedHeldPartitions'),rootExists=d['rootExists'],phases={k:phases[k] for k in ['equality-c1','create-c16','update-c16','mixed-c16']}))
index=[]
for variant in ['base','sizing','counts']:
 files=['index-only.json'] if variant=='base' else [f'index-only-{variant}.json',f'index-only-{variant}-trial-2.json',f'index-only-{variant}-trial-3.json']
 trials=[load(f) for f in files]
 for target in [128,300,512,1024]:
  rows=[next(v for v in t if v['targetKiB']==target) for t in trials]
  index.append(dict(variant=variant,targetKiB=target,trials=len(rows),insertsPerSecond=statistics.median(v['createOpsPerSecond'] for v in rows),updatesPerSecond=statistics.median(v['updatesPerSecond'] for v in rows),equalityMedianUs=statistics.median(v['rows']['equality']['p50Ms']*1000 for v in rows)))
audits={v:load(f'audit-{v}.json') for v in ['base','holders','coalesced','both','sizing','counts','all']}
assert all(d['passed'] for d in audits.values())
summary=dict(sourceUnchanged=True,full=full,index=index,audits=audits)
(p/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
with tarfile.open(p/'experimental-sources.tar.gz','w:gz') as archive:
 for name in ['base','holders','coalesced','both','sizing','counts','all']:
  source=Path((p/('snapshot.txt' if name=='base' else f'snapshot-{name}.txt')).read_text().strip())
  archive.add(source/'src',arcname=name+'/src')
lines=['# CoCreateDB cache, index, and distribution benchmarks','',
'Production source fingerprints match the starting snapshot. All optimizations below are experiments in isolated source copies; no live records or persistence were used. Existing uncommitted DB work was preserved.','',
'## Findings','',
'- Ordinary leaf growth can use `entries.length`; internal fanout can use `indexes.length`. Internal `length` is a descendant record count, not direct child count. Keep those semantics distinct. Neither requires JSON serialization.',
'- Full-node JSON byte measurement during mutation is expensive. In the isolated 20,000-entry numeric index, it consumed over 90% of baseline insertion time at the larger targets.',
'- Increasing the byte threshold alone did not materially improve the full DB traffic fixture. It reduced pathname tree depth but increased bytes serialized for updates.',
'- Holder caching avoids repeated distribution-tree scans. Coalescing pending partition updates per destination/path eliminates exact duplicate partition frames in this fixture.',
'- Count-based splitting plus both distribution changes improved full mixed throughput approximately 28%, from 74.2 to 95.2 operations/sec. The remaining write cost warrants further profiling; pure index throughput is not full DB throughput.','',
'## Full DB traffic','',
'Node v24.18.0, AMD EPYC 7571, 2 reported CPUs. Memory-only primary DB with actual indexing, namespace resolution, subscriptions, and one simulated peer serializing JSON. No network, IPC, HTTP, remote peer execution, or rendering. Each run starts with 1,000 documents and ends with 1,300 verified documents.','',
'The sequence contains ID reads, host/pathname equality reads, bounded range reads, creates and updates at concurrency 1 then 16, followed by 1,000 mixed operations (70% reads, 20% updates, 10% creates). Every client yields after each response. Concurrency 16 means 16 client streams on one JavaScript primary. Phases share warmed/growing state; compare identical phases across variants, not concurrency phases as independent fixtures. Throughput includes final indexing drain (`db.flush()`), rather than acknowledgments alone.','',
'| Policy | Equality median ms | Creates/sec (16) | Updates/sec (16) | Mixed/sec (16) | Mixed p95 ms | Mixed serialized MB |',
'|---|---:|---:|---:|---:|---:|---:|']
for d in full:
 q=d['phases']; label=f"Baseline {d['targetKiB']} KiB" if d['variant']=='base' else {'both':'Holder cache + coalescing, 128 KiB','all':'Counts + holder cache + coalescing'}[d['variant']]
 lines.append(f"| {label} | {q['equality-c1']['latency']['p50Ms']:.3f} | {q['create-c16']['drainedOpsPerSecond']:.1f} | {q['update-c16']['drainedOpsPerSecond']:.1f} | {q['mixed-c16']['drainedOpsPerSecond']:.1f} | {q['mixed-c16']['latency']['p95Ms']:.2f} | {q['mixed-c16']['metrics']['wireBytes']/1e6:.1f} |")
lines+=['',
'MB denotes decimal serialized bytes. The baseline 128 KiB mixed phase sent approximately 51.2 MB of exact duplicate partition frames (5,280 packets); both coalescing variants sent zero exact duplicates. Baseline create and update phases required approximately 748 and 224 index reads per operation; holder caching plus coalescing reduced these to approximately 260 and 80.','',
'Pure read phases performed zero index writes, zero size calculations, and zero splits. Thus reads were not rebuilding these indexes in this fixture. DB equality requests still traversed cached nodes repeatedly (about 18 index reads/request); repeated namespace/metadata resolution is a candidate for subsequent profiling.','',
'## Isolated numeric index','',
'20,000 unique numeric entries in deterministic permuted insertion order; 3,000 equality lookups; 1,000 bounded 20-entry scans; 500 remove-and-insert updates. Counts and mapping checks passed. `structuredClone` throws during the benchmark. Memory-only directories were confirmed absent. Baseline is one trial; experimental sizing and count results are medians of three trials with different target order. These are local measurements, not statistical confidence intervals.','',
'| Policy | Target label KiB | Inserts/sec | Updates/sec | Equality median microseconds |',
'|---|---:|---:|---:|---:|']
for d in index:
 lines.append(f"| {d['variant']} | {d['targetKiB']} | {d['insertsPerSecond']:.0f} | {d['updatesPerSecond']:.0f} | {d['equalityMedianUs']:.1f} |")
lines+=['',
'`sizing` maintains exact incremental array byte accounting in an ephemeral WeakMap. It is a comparison experiment, not a recommendation to retain size metadata. Split-heavy 1/2/4/8 KiB fixtures checked estimates against complete serialization.','',
'`counts` removes byte calculations and splits at the median item count. For this comparison only, leaf limits were derived from the target label using floor(targetBytes/36): 3,640 / 8,533 / 14,563 / 29,127 entries. Internal fanout limit was 64 children. These labels are not actual byte limits, and 36 bytes is not a general record-size estimate. Production configuration should expose explicit entry/child counts. The fixture does not establish a universal default for variable-width keys or large schemas.','',
'## Distribution and reference checks','',
'All seven variant audits passed holder add/remove/cache clearing, in-place recipient sets, stable document references after updates, removal of old pathname matches, old/new holder targeting, queued live values, stable IDs through array/storage rename, delete/recreate lifetime, and absence of filesystem writes.','',
'Full traffic runs also verified expected document revisions and query results. Optimized runs compared final serialized peer frames for initially held partitions with the primary cache. The baseline 128 KiB run predates this additional frame comparison. The simulated peer initially holds existing ordinary partitions; acquisition of newly split sibling partitions is not exercised. Real multi-node transport, restart, concurrent remote mutation, and fault recovery remain outside this benchmark.','',
'## Recommended implementation direction','',
'1. Use configurable entry count and child count for ordinary splitting. Mutate existing arrays and parent references in place.',
'2. Cache holder lookups with explicit mutation and cache-clear handling; coalesce repeated pending partition updates by destination and scoped path.',
'3. If a transport-size trigger is required, measure the already serialized outgoing buffer. A structural split must update the DB tree and affected references before replacement frames are encoded and sent. That exceptional split necessarily requires encoding replacement frames; ordinary sends can reuse their first encoding. Transport fragmentation alone must not silently change tree topology.',
'4. Keep byte-size metadata out of normal catalog updates. Treat oversized indivisible values according to transport capabilities rather than retrying the same structural split indefinitely.',
'5. Benchmark broader workloads and real peers before selecting defaults or promoting these experiments. Read-path namespace resolution and bounded-range candidate construction are further candidates, not demonstrated optimizations here.','',
'## Artifacts and reproduction','',
'`summary.json` contains extracted results; individual JSON files contain phase percentiles, queue/index metrics, tree shape and cache measurements. Pilot and trial-1 traffic files were exploratory and are excluded from the comparison. `experimental-sources.tar.gz` preserves every instrumented source variant without dependencies. The original source SHA-256 manifest is `source-fingerprints.json`.','',
'Existing `snapshot*.txt` files point to the temporary source copies used for these results. To reproduce after temporary copies expire, extract the archive, symlink each variant\'s `node_modules` to `/home/ubuntu/Dev/CoCreateJS/modules/db/node_modules`, and update the corresponding snapshot pointer. Dependencies, including the shared distribution utility imported by the traffic harness, must remain compatible.','',
'Run one benchmark at a time from this directory:',
'','```bash',
'BENCH_DOCS=1000 BENCH_READS=1000 BENCH_WRITES=100 BENCH_UPDATES=200 BENCH_MIXED=1000 BENCH_TRIAL=2 node traffic.mjs 128',
'BENCH_VARIANT=both BENCH_DOCS=1000 BENCH_READS=1000 BENCH_WRITES=100 BENCH_UPDATES=200 BENCH_MIXED=1000 BENCH_TRIAL=2 node traffic.mjs 128',
'BENCH_VARIANT=all BENCH_DOCS=1000 BENCH_READS=1000 BENCH_WRITES=100 BENCH_UPDATES=200 BENCH_MIXED=1000 BENCH_TRIAL=2 node traffic.mjs 128',
'INDEX_VARIANT=counts INDEX_TRIAL=4 node index-only.mjs',
'node audit.mjs all',
'```','',
'Traffic commands overwrite their matching result files. Use a new trial label to preserve existing results. `audit.mjs` accepts the variant as its first positional argument.']
# Audit uses BENCH_VARIANT or AUDIT_VARIANT? Validate and document actual contract.
s=(p/'audit.mjs').read_text()
import re
match=re.search(r"const variant\s*=\s*process.env.(\w+)",s)
if match: lines=[line.replace('node audit.mjs all',match.group(1)+'=all node audit.mjs') for line in lines]
(p/'report.md').write_text('\n'.join(lines)+'\n')
print('Source fingerprints unchanged:',len(fingerprints),'files')
print('Audits passed:',len(audits))
print('Wrote report.md, summary.json, experimental-sources.tar.gz')
