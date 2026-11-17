import json,math,platform
from pathlib import Path
base=Path(__file__).parent
labels=('mongodb-a','db','mongodb-b')
runs={label:json.loads((base/(label+'.json')).read_text())for label in labels}
sources=json.loads((base/'source-comparison.json').read_text())
paths=runs['db']['summaries']
def p(values,q):return sorted(values)[math.ceil(len(values)*q)-1]
rows=[];comparisons=[]
for summary in paths:
 path=summary['path'];groups={label:[s for s in runs[label]['samples']if s['path']==path]for label in labels}
 hashes={s['sha256']for group in groups.values()for s in group}
 assert len(hashes)==1,(path,hashes)
 assert all(s['status']==200 for group in groups.values()for s in group)
 mongo=[s['totalMs']for label in ('mongodb-a','mongodb-b')for s in groups[label]]
 db=[s['totalMs']for s in groups['db']]
 m=p(mongo,.5);d=p(db,.5)
 comparisons.append({'path':path,'mongodbP50Ms':m,'dbP50Ms':d,'mongodbP95Ms':p(mongo,.95),'dbP95Ms':p(db,.95),'dbLatencyChangePercent':(d/m-1)*100,'mongodbOverDbRatio':m/d,'sha256':next(iter(hashes))})
 vals=[]
 for label in labels:
  times=[s['totalMs']for s in groups[label]];vals.append(f'{p(times,.5):.2f} / {p(times,.95):.2f}')
 rows.append('| '+path+' | '+' | '.join(vals)+' |')
(base/'comparison.json').write_text(json.dumps({'runs':labels,'measuredRequests':120,'comparisons':comparisons,'allStatuses200':True,'allBodiesIdentical':True},indent=2)+'\n')
lines=['# MongoDB versus CoCreateDB HTTP benchmark','',
'CoCreateDB was faster for the recursively rendered root page and slower for the standalone component. This is a warm end-to-end HTTP comparison, not an isolated database-engine benchmark.','',
'| Request | MongoDB first: median / p95 ms | DB: median / p95 ms | MongoDB repeat: median / p95 ms |',
'|---|---:|---:|---:|',*rows,'',
'Pooled MongoDB results compared with DB:','']
for c in comparisons:
 direction='higher'if c['dbLatencyChangePercent']>0 else 'lower'
 lines.append(f"- `{c['path']}`: DB median {c['dbP50Ms']:.2f} ms versus MongoDB {c['mongodbP50Ms']:.2f} ms; DB latency was {abs(c['dbLatencyChangePercent']):.1f}% {direction}.")
lines += ['', '## Workload and validation','',
'- Public endpoint: `https://dev.cocreatejs.com`, exercised from this server through its public hostname over HTTPS/HTTP 1.1.',
'- MongoDB first, DB second, MongoDB repeat after restoring default routing. Two server workers in each phase. Same source checkout and existing DB directory: `/home/ubuntu/Dev/CoCreateDB`.',
'- Twenty sequential measured GETs per path per phase, preceded by three warmup GETs per path. 120 measured requests plus 18 warmups. One persistent connection per phase; no browser cache, conditional requests, or compressed downloads.',
'- Every measured request returned HTTP 200. Both response bodies matched byte for byte across all three phases. Hero component: 2,538 bytes. Root page: 116,283 bytes.',
'- The root source and 71 available dependencies matched between MongoDB and DB. `/assets/icons/gsqxdxog.json` was missing from both stores. That shared missing dependency is part of this workload.',
'- The DB memory cache was enabled in both phases, as in the existing server configuration. Startup/preloading time is excluded from measured request latency. These samples measure warm latency, not throughput or external-client performance.',
'- The second MongoDB run reproduced the first run’s median timings. One component request in the second run took 592 ms; it remains in the raw samples and maximum/mean statistics.',
'', '## Routing change','',
'CRUD now supports `COCREATE_CRUD_READ_STORAGE=db` with optional `COCREATE_CRUD_READ_DATABASE=dev`. The override applies to every `object.read` in the resolved database, including nested file and data reads. It activates after CRUD bootstrap configuration loads. Creates, updates, and deletes retain normal routing. The DB path remains the existing `COCREATE_DB_DIRECTORY` setting; no data copy is performed.',
'', '## Limitations and findings','',
'- Forcing all reads in `dev` also switches authorization-key reads. The existing CLI key was rejected in DB mode, so authenticated CRUD performance was not measured. Anonymous HTTP rendering succeeded with identical output. The authorization discrepancy needs separate investigation before broad DB read routing is used for authenticated traffic.',
'- Applying the override during CRUD bootstrap initially exposed a startup/logging dependency. The final implementation activates it only after bootstrap configuration has loaded; a regression test covers that boundary.',
'- MongoDB’s normal CRUD path resolves its named storage API record; the registered local DB driver uses a direct dispatch path. The timings include that routing overhead as well as querying, hydration, recursive rendering, and network transfer. They do not isolate query-engine cost.',
'- Default routing was restored after the DB phase. A `coc send` read again reported `mongodb` and authorization succeeded.',
'- Validation: 57 focused CRUD server tests passed, including read-override scope, mutations staying on their configured route, and bootstrap behavior.',
'', '## Artifacts','',
'- `benchmark.mjs`: repeatable HTTP client; run with `node benchmark.mjs <label>` against whichever server mode is active.',
'- `mongodb-a.json`, `db.json`, `mongodb-b.json`: summaries and per-request samples. Matching `.jsonl` files contain raw samples.',
'- `comparison.json`: pooled median/p95 comparison and response hashes.',
'- `source-comparison.json`: source-file parity audit.',
'- `mongodb-a-provider.json`, `mongodb-b-provider.json`: CLI verification of default MongoDB routing. `db-provider.json` records the DB-mode authorization rejection.',
'', 'No commits or pushes were made.']
(base/'report.md').write_text('\n'.join(lines)+'\n')
print(json.dumps(comparisons,indent=2))
