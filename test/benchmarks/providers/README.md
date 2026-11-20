# Provider specs

Reference data, not executable tests. Keep historical measurements and published examples distinct from same-fixture measurements. Unknown values are null; do not infer zero.

- `cocreatedb.json`: medians across five raw runs per scenario, 2026-11-19.
- `mongodb.json`: historical project measurements, raw provider output unavailable; official cache specification.
- `redis.json`: provisional historical numbers and independently sourced official examples.

Future provider runs should append dated raw results (do not overwrite history), record versions, hardware, dataset hash and bytes, indexes, result counts, concurrency, transport, durability, latency p50/p95/p99/mean, throughput, CPU, idle/loaded/peak RSS and client memory.

Use the same lifecycle fixture, object projection and index maintenance semantics. Test Redis GET/SET separately from JSON.GET/JSON.SET plus indexed search; MongoDB with equivalent indexes. Measure in-process CoCreateDB and a transport-inclusive CoCreateDB variant separately. Match durability and concurrency before ranking. Compare batch creation separately from single writes. WiredTiger cache capacity, Redis allocator memory, and Node RSS are distinct metrics.

No new Redis or MongoDB execution was performed. Neither binary was available on the local PATH.
