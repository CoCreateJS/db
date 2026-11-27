# Worker execution: 40 organizations, 1M records

One million total records across 40 organizations (25,000 records per
organization) with eight real Node worker processes and one coordinating
primary. Each organization has one record-bearing array. Producers ran
concurrently through the primary; creates were sent in 1,000-record chunks
after one routing seed per organization. The primary used the existing
CoCreate Cluster IPC transport. This measures local DB work and IPC, not
HTTP/socket transport or production cluster startup.

Fixture: lifecycle v3 with a `table` field. SHA-256:
`ae2057581fe639d69c6f72a3414f5f8fd9750028cf2a380592ed6047769c852e`.

| Measurement | Result |
| --- | ---: |
| Create acknowledgements, including routing seeds | 96.93 s |
| Create and index completion | 584.28 s |
| Create and index throughput | 1,712 records/s |
| Final pending index records | 0 |
| Primary-local Trees | 0 |
| Primary Trees assigned per worker, all Tree levels | 20 each across workers 1–8 |
| Record-bearing array Trees | 20 on worker 4; 20 on worker 8; none on workers 1–3, 5–7 |
| Summed process RSS sampled after indexing | 6,906.6 MiB |

The coordinator distributed primary Tree ownership evenly overall, but the
record-bearing array Trees landed only on workers 4 and 8. Those workers
sampled at 2,754.2 MiB and 2,683.2 MiB RSS; each of the other six worker
processes sampled between 68.7 and 70.2 MiB. Thus the eight-worker run did not
spread record indexing evenly: two workers performed the record-bearing Tree
work while the other workers held structural Trees. This is an ownership
distribution issue to investigate before treating the result as eight-worker
scaling.

The load passed its queue-drain and placement checks. `DB_LOAD_ONLY=1` skips the
additional CRUD, query, and pruning diagnostics after the timed load; those
behaviors are covered by the smaller worker integration benchmark. RSS is a
single post-index sample, not peak RSS. This is one run, not a stable throughput
estimate.

Run settings: Node v24.18.0, `NODE_OPTIONS=--max-old-space-size-percentage=75`,
eight workers, 40 organizations, 40 arrays total, 1,000,000 records, 25,000
records per organization. The run used branch `dev` at `9246710` with only
benchmark-harness changes in the worktree. See [raw measurements](result.json)
and [run context](run-context.json).
