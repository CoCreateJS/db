# Architecture

## Current engine

CoCreateDB is an embeddable JavaScript database. `createDB(server, options)` and `await createDB.init(server, options)` expose `send(request)` and `config`. A standalone instance requires no server. Primary instances execute local CRUD; workers use the supplied `forward(request)` adapter. Explicit primary status takes precedence. No IPC protocol is embedded.

Internally one UUID-keyed leaf Map, one key/type tree catalog and a root manager maintain live data. Index entries reference leaves directly. Offloaded terminal branches are stored separately from leaves; the root/parent branch catalog is not yet restored on restart. Configuration defines allowed hierarchy and structural identities; it is not a data snapshot.

## Local residency and defaults

The default mode is `adaptive`; the default acknowledgement is `memory`. Adaptive keeps a Hot working set in memory and uses Warm local disk for write-through, recovery and weighted eviction. The default requested memory budget is 25% of total system memory, capped by memory available at startup. It is a soft DB-residency target, not a hard process-memory cap. Disk-first remains an explicit mitigation mode and is also used temporarily by adaptive handling at high pressure. Disk-cache starts with a cleared DB-managed local base.

Memory acknowledgement returns when the local in-memory mutation is available. Disk acknowledgement waits for affected local writes; neither acknowledgement provides multi-object atomicity. The DB exposes `persistence.register()`, `persistence.send()` and `db.persist()` for an explicit external persistence transport and pending leaf journal. The separate Persistence Tree, full root/index branch persistence and Cold archives remain outside the implemented engine.

## Integration boundary

CRUD routes authorized requests to the DB, then invokes a configurable workflow with the request and response. Workflow/AST can acquire missing data and schedule or await persistence orchestration. Socket, IPC and Mesh own awareness and delivery. The DB has no built-in provider, peer inventory, network discovery or publication callbacks; its persistence callback is explicitly registered by the host.

Local success does not establish global completeness or external durability. DB eviction mitigates its own Hot/Warm residency; it cannot protect total server RSS from unbounded incoming requests or server-side queues. Process-level OOM protection belongs to server telemetry and network traffic management, including admission control, draining and client backoff. External integration must preserve identity, authorization and operation context. See [CRUD](crud.md), [indexes](indexes.md), [persistence](persistence.md) and [distribution](distribution.md).
