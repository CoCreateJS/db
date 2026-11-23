# Architecture

## Current engine

CoCreateDB is an embeddable JavaScript database. `await createDB(server, options)` and `await createDB.init(server, options)` expose asynchronous `send(request)` and `config`. Initialization opens the configured storage adapter and restores its configuration and indexes before resolving. A standalone instance requires no server. Primary instances execute local CRUD; workers use the supplied `forward(request)` adapter. Explicit primary status takes precedence. No IPC protocol is embedded.

Internally one UUID-keyed leaf Map, one key/type tree catalog and a root manager maintain live data. Index entries reference leaves directly. Offloaded terminal branches are stored separately from leaves; the root/parent branch catalog is not yet restored on restart. Configuration defines allowed hierarchy and structural identities; it is not a data snapshot.

## Local residency and defaults

The default mode is `adaptive`; the default acknowledgement is `memory`. Adaptive keeps a Hot working set in memory and uses Warm local disk for write-through, recovery and weighted eviction. The default requested memory budget is 25% of total system memory, capped by memory available at startup. It is a soft DB-residency target, not a hard process-memory cap. Disk-first remains an explicit mitigation mode and is also used temporarily by adaptive handling at high pressure. Disk-cache starts with a cleared DB-managed local base.

The Node package entry uses the Node filesystem adapter and defaults to `~/.cocreate/db`. The package `browser` entry selects OPFS and uses disk-first request processing with no DB memory-residency policy. Its default base is the relative OPFS directory `CoCreateDB/`; a configured `directory` is interpreted as a relative path beneath the origin-private root. Both adapters use `config.json`, `branches/` and `leaves/`. OPFS is scoped to the browser origin, requires a secure context and is subject to browser quota management. The browser entry has no Node filesystem or OS-memory dependency.

For `object.create`, memory acknowledgement returns after the UUID-bearing input is stored in the leaves Map. It does not wait for scope resolution, leaf preparation, flattening, indexing or Warm writes. UUID reads can resolve that staged leaf immediately; filter reads observe it after indexing, while UUID updates and deletes wait for preparation to finish. A failed background preparation does not retract an acknowledgement; `flushIndex()` or `flushDisk()` reports the recorded failure. Disk acknowledgement waits for preparation and affected local writes. Neither acknowledgement provides multi-object atomicity. The DB exposes `persistence.register()`, `persistence.send()` and `db.persist()` for an explicit external persistence transport and pending leaf journal. The separate Persistence Tree, full root/index branch persistence and Cold archives remain outside the implemented engine.

## Integration boundary

CRUD routes authorized requests to the DB, then invokes a configurable workflow with the request and response. Workflow/AST can acquire missing data and schedule or await persistence orchestration. Socket, IPC and Mesh own awareness and delivery. The DB has no built-in provider, peer inventory, network discovery or publication callbacks; its persistence callback is explicitly registered by the host.

Local success does not establish global completeness or external durability. DB eviction mitigates its own Hot/Warm residency; it cannot protect total server RSS from unbounded incoming requests or server-side queues. Process-level OOM protection belongs to server telemetry and network traffic management, including admission control, draining and client backoff. External integration must preserve identity, authorization and operation context. See [CRUD](crud.md), [indexes](indexes.md), [persistence](persistence.md) and [awareness](awareness.md).
