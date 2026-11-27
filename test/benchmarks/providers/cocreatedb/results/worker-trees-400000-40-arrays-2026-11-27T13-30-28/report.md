# Primary-orchestrated worker Trees: 400K comparison

One organization, 40 arrays, 400,000 total records (10,000 per array). The
primary assigns array ownership round-robin and dispatches through the existing
CoCreate Cluster IPC implementation to real Node workers. Both runs use four
concurrent producer loops and 1,000-record create chunks after one routing seed
per array. Worker processes are ready before DB traffic. This measures local
DB processing plus IPC; it does not include HTTP/socket transport or production
cluster startup ordering.

Fixture: lifecycle v3 with a `table` field. Both runs have the same SHA-256:
`b5b1d8b95574489ecfa771ec7f9f997c8c5891eae75af17b60c9dfe197548f09`.

| Measurement | 2 workers | 4 workers |
| --- | ---: | ---: |
| Create acknowledgement wall time, including routing seeds | 65.59 s | 78.19 s |
| Create and index wall time | 239.86 s | 230.78 s |
| Create and index throughput | 1,668 records/s | 1,733 records/s |
| Primary-local Trees | 0 | 0 |
| Final pending index records | 0 | 0 |
| Primary RSS sampled after indexing | 707.1 MiB | 458.6 MiB |
| Worker RSS sample sum after indexing | 3,240.7 MiB | 2,876.3 MiB |
| All-process RSS sample sum after indexing | 3,948.2 MiB | 3,335.1 MiB |
| Arrays assigned per worker | 20 | 10 |

Four workers completed create-plus-index about 9.1 seconds sooner (3.8%), while
two workers acknowledged creates about 12.6 seconds sooner (16.1%). The
post-index process RSS sample sum was about 613 MiB lower with four workers.
These are one run per configuration, and RSS was sampled after indexing rather
than captured as a peak. They are directional observations, not a stable
scaling conclusion. Both completed with all index work drained.

The benchmark's assertions also passed for round-robin ownership, worker-only
Tree residency, worker ingress and UUID routing, query sort/pagination, CRUD,
organization isolation, worker-local pruning, pending storage protection,
cold-page hydration, and the synthetic 75%/50% memory pressure controls.

Run settings: Node v24.18.0; four producer loops; `NODE_OPTIONS=--max-old-space-size-percentage=75`;
one primary plus the listed worker count. Full measurements and ownership maps:
[2 workers](2-workers.json), [4 workers](4-workers.json). The benchmark ran on
branch `dev` at source revision `38ff8e4`, with uncommitted worker-runtime and
benchmark-harness changes present. See [run context](run-context.json).
