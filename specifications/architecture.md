# Architecture

## Current engine

CoCreateDB is an embeddable JavaScript database. `createDB(server, options)` and `await createDB.init(server, options)` expose `send(request)` and `config`. A standalone instance requires no server. Primary instances execute local CRUD; workers use the supplied `forward(request)` adapter. Explicit primary status takes precedence. No IPC protocol is embedded.

Internally one UUID-keyed artifact Map, one key/type tree catalog and a scope manager maintain live data. Index entries reference artifacts directly. Runtime partitions are not persistent artifacts. Configuration defines allowed hierarchy and structural identities; it is not a data snapshot.

## Integration boundary

CRUD routes authorized requests to the DB, then invokes a configurable workflow with the request and response. Workflow/AST can acquire missing data, schedule durable writes or await confirmation. Socket, IPC and Mesh own awareness and delivery. These integrations are planned outside the engine. The DB has no provider, peer inventory, network discovery or publication callbacks.

Local success does not establish global completeness or durability. External integration must preserve identity, authorization and operation context. See [CRUD](crud.md), [persistence](persistence.md) and [distribution](distribution.md).
