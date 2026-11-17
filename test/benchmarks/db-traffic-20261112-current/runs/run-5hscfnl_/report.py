from pathlib import Path
import json,statistics,hashlib,tarfile
out=Path(__file__).parent;old=out.with_name('db-traffic-20261112');repo=Path('/home/ubuntu/Dev/CoCreateJS/modules/db')
read=lambda p:json.loads(p.read_text())
current=[read(p)for p in sorted(out.glob('128-peer-acked-current-*.json'))]
control=[read(p)for p in sorted(out.glob('128-peer-acked-control-*-baseline.json'))]
assert len(current)==3 and len(control)==1,(len(current),len(control))
phases=['id-c1','equality-c1','range-c1','create-c16','update-c16','mixed-c16']
def summarize(runs):
 result={}
 for name in phases:
  rows=[next(p for p in r['phases'] if p['name']==name)for r in runs]
  result[name]={'drainedOpsPerSecond':statistics.median(r['drainedOpsPerSecond']for r in rows),'throughputRange':[min(r['drainedOpsPerSecond']for r in rows),max(r['drainedOpsPerSecond']for r in rows)],'p50Ms':statistics.median(r['latency']['p50Ms']for r in rows),'p95Ms':statistics.median(r['latency']['p95Ms']for r in rows),'serializedMB':statistics.median(r['metrics']['wireBytes']/1e6 for r in rows),'mutationSizeMs':statistics.median(r['metrics']['sizeMs']for r in rows),'duplicatePackets':statistics.median(r['metrics']['duplicatePackets']for r in rows)}
 return result
before=summarize(control);after=summarize(current)
fingerprints=read(out/'source-fingerprints.json')
changed=[p for p,h in fingerprints.items()if hashlib.sha256((repo/p).read_bytes()).hexdigest()!=h]
assert not changed,changed
assert len({json.dumps(r['environment'],sort_keys=True) for r in current+control})==1
for run in current+control:
 assert run['acknowledgeSplits'] and run['verifiedDocuments']==1300 and run['rootExists']==False and run['verifiedHeldPartitions']>0
 for phase in run['phases']:
  if phase['name'].startswith(('id-','equality-','range-')):
   assert phase['metrics']['indexWrites']==0 and phase['metrics']['splits']==0 and phase['metrics']['catalogSplits']==0
source=Path((out/'snapshot.txt').read_text().strip())
with tarfile.open(out/'experimental-sources.tar.gz','w:gz') as archive:
 archive.add(source/'src',arcname='current/src');archive.add(out/'sources/base/src',arcname='baseline/src')
disk=read(out/'local-disk.json')
summary={'currentRuns':len(current),'controlRuns':len(control),'before':before,'after':after,'disk':disk,'sourceUnchanged':True}
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
lines=['# CoCreateDB benchmark after replication-time splitting','',
'Current source was snapshotted without modifying production files. External persistence/recovery was disabled for every run. All records were synthetic fixtures; no live server restart, live database writes, or MongoDB requests were performed. Source SHA-256 verification passed at completion.','',
'## Full memory/index/distribution comparison','',
f'Three current runs and {len(control)} fresh control run of the saved original baseline source. Each uses the same 128 KiB target, 1,000 seed documents, and the previous `per-client-yield-v2` traffic sequence. Runs were sequential to avoid benchmark CPU contention. Values below are medians; ranges are observed run variation, not confidence intervals.','',
'| Workload | Baseline ops/sec | Current ops/sec | Change | Current observed range |',
'|---|---:|---:|---:|---:|']
for name in phases:
 b,a=before[name],after[name];delta=(a['drainedOpsPerSecond']/b['drainedOpsPerSecond']-1)*100;lo,hi=a['throughputRange']
 lines.append(f"| {name} | {b['drainedOpsPerSecond']:.1f} | {a['drainedOpsPerSecond']:.1f} | {delta:+.1f}% | {lo:.1f}–{hi:.1f} |")
lines+=['','| Latency / traffic | Baseline | Current |','|---|---:|---:|']
for name in ['equality-c1','mixed-c16']:
 for field,label in [('p50Ms','median ms'),('p95Ms','p95 ms')]:lines.append(f"| {name} {label} | {before[name][field]:.3f} | {after[name][field]:.3f} |")
for field,label in [('serializedMB','serialized MB'),('duplicatePackets','repeated partition frames'),('mutationSizeMs','mutation byte-measurement ms')]:lines.append(f"| mixed-c16 {label} | {before['mixed-c16'][field]:.1f} | {after['mixed-c16'][field]:.1f} |")
lines+=['',
f'Final current runs acknowledged {[r["acknowledgedNewPartitions"] for r in current]} newly delivered partitions and verified {[r["verifiedHeldPartitions"] for r in current]} retained peer-held partitions. Warm read phases in both versions performed no index writes or structural splits. Read latency therefore measures reuse of completed indexes, not rebuilding. The throughput gains chiefly concern write/index/replication processing. Mutation sizing is zero in the current source; transport encoding still occurs and is included in overall elapsed time.','',
'Current partition frames carry transport UUIDs. Duplicate detection ignores those UUIDs when comparing frame content, so distinct UUIDs cannot hide repeated identical partition data. DB-prepared encodings are reused by the harness rather than encoded a second time. The baseline uses the same harness and serializes normally because it supplies no prepared encoding.','',
'All final 1,300 document revisions were checked against an expected model. ID, host/path equality, range responses and stable recipient references were verified. The simulated peer immediately announces ownership of newly delivered split nodes. Final frames for every retained peer-held partition, including new siblings, were compared with the primary cache. No data-root directory existed in memory-only runs. `structuredClone` throws throughout the core workload.','',
'### Workload and limits','',
'- Actual primary DB code, namespace catalogs, indexes, subscriptions, holder discovery, and JSON replication encoding; one simulated peer. No real network, remote execution, IPC, browser rendering, TLS, or MongoDB. Peer acknowledgment is simulated through the source holder API; actual remote execution and network acknowledgment latency remain outside this fixture.',
'- Small synthetic documents contain IDs, a long pathname, host array, rank, group and revision. This does not establish throughput for large source files.',
'- Each run executes 1,000 ID reads, 1,000 equality reads, 100 range reads, 100 creates and 200 updates at concurrency 1, then repeats at concurrency 16, followed by 1,000 mixed operations (70% reads / 20% updates / 10% creates). Sixteen streams share one JavaScript primary; this is not sixteen CPU workers.',
'- Phases share warmed/growing state. Compare matching phases across versions rather than treating concurrency phases as independent identical fixtures. Throughput includes final `flush()` and its indexing drain.',
'- Normal scalar mutations do not split. Current path trees can remain shallower because their split target is checked only when sent. Never-sent nodes may exceed 128 KiB. This is the chosen behavior, not a strict byte ceiling.',
'- Holder caching from the earlier experimental `both`/`all` variants is not part of the current production source; those prototypes are not the baseline in this table.',
'- Live machine load can vary; each JSON includes Node/CPU information. Results are local measurements, not guarantees.','',
'## Local disk and restart check','',
f'A separate current-source fixture created {disk["documents"]} file documents with 1 KiB sources and applied {disk["updates"]} updates. It used local write-behind persistence and `.bytes` sidecars, with external persistence disabled. Seed plus first disk drain took {disk["seedAndFlushMs"]:.1f} ms.','',
'| Fresh process | First cold equality read ms | Warm equality median ms | Warm equality p95 ms | Warm reads/sec |','|---|---:|---:|---:|---:|']
for i,r in enumerate(disk['runs'],1):lines.append(f"| {i} | {r['coldFirstReadMs']:.3f} | {r['warm']['p50Ms']:.3f} | {r['warm']['p95Ms']:.3f} | {r['warmOpsPerSecond']:.1f} |")
lines+=['',
f'The fixture persisted {disk["fileCount"]} files ({disk["totalBytes"]:,} bytes including accounting files), with {disk["sidecarCount"]} sidecars and {disk["sidecarEntries"]} checked size entries. Every sidecar entry matched filesystem `stat`. Three new Node processes read the saved data; each warmed all 250 documents before timing its 1,000 warm reads; the updated revision and source contents were checked. The first cold read happens before that warmup. The cold figure includes loading namespace catalogs, indexes and the first document from disk, but excludes Node startup/import time and operating-system cold-cache eviction. No disk-cache flush was performed. These figures have no equivalent historical disk baseline.','',
'## Saved historical reference','',
'The original saved baseline run reported 10.5 creates/sec, 100.4 updates/sec and 74.2 mixed operations/sec. The fresh baseline above controls better for this run’s machine conditions. The earlier 95.2 mixed/sec result was an experimental count-splitting plus holder-cache prototype; current code follows the subsequently chosen serialization-time split policy.','',
'## Artifacts and reproduction','',
'Run the complete suite from `/home/ubuntu/Dev/CoCreateJS/modules/db` with one command. Each invocation snapshots the current DB source, runs the frozen baseline and all workloads, and writes a fresh folder under `runs/`:',
'','```bash','python3 test/benchmarks/db-traffic-20261112-current/benchmark.py','```','',
'The runner prints the comparison table and saves Markdown/JSON reports and raw measurements. Allow roughly 5–7 minutes. Use `--dry-run` to inspect the plan or `--summary RUN_DIRECTORY` to display a saved result.', '',
'`summary.json` holds extracted comparison results. Individual traffic JSON files contain each phase, percentiles, queue/index counters, tree shape, node sizes and verification counts. `local-disk.json` holds restart measurements. `experimental-sources.tar.gz` contains the exact instrumented current and baseline source copies, without dependencies. The source fingerprint manifest describes uninstrumented production files at the start.','',
'`run-acks.py` executes current/control/current/current sequentially with split acknowledgments; its logs preserve phase output. Snapshot pointers select source copies, each linked to the existing DB dependencies. Use a new trial name to avoid overwriting results:',
'','```bash',
'BENCH_ACK_SPLITS=1 BENCH_DOCS=1000 BENCH_READS=1000 BENCH_WRITES=100 BENCH_UPDATES=200 BENCH_MIXED=1000 BENCH_TRIAL=another-current node traffic.mjs 128',
'BENCH_ACK_SPLITS=1 BENCH_VARIANT=baseline BENCH_DOCS=1000 BENCH_READS=1000 BENCH_WRITES=100 BENCH_UPDATES=200 BENCH_MIXED=1000 BENCH_TRIAL=another-control node traffic.mjs 128',
'node local-disk.mjs',
'```','',
'Preliminary `current-*` and `control-*` runs lacked acknowledgment of newly split nodes and are excluded from the final comparison; `acked-*` files are the final runs. Only the temporary benchmark sources are instrumented. Production code and recovery configuration are unchanged by this benchmark.']
(out/'report.md').write_text('\n'.join(lines)+'\n')
print(json.dumps({'before':before,'after':after,'sourceUnchanged':True},indent=2))
