# CoCreateDB Persistence Specification

## Workflow ownership

The DB core keeps decoded state in memory and delegates durable reads and writes
to persistence. It supplies organization context, UUID addresses, values and
operations; persistence decides how and where to represent them. The DB core
does not choose filenames, paths or providers. Bootstrap and distribution
state have their own explicit integration boundaries.

Local filesystem, S3, Google Cloud Storage, Azure Blob Storage and other providers are workflow destinations, not core storage modes. The workflow defines provider combination, execution order, parallelism, retries, encryption and paths. The core has no direct durable filesystem fallback, independent disk queue/provider path, `disk`, `file`, `memoryOnly` persistence bypass or configurable `writeBehind` response switch. Cache retention does not select durability destinations.

## Artifact operations

The logical workflow contract includes create(UUID, value), read(UUID),
update(UUID, value) and delete(UUID) in explicit authorized organization
context. A mutation sends the changed value and every changed index artifact
needed to preserve the path from the organization root to that value. Unchanged
ancestors need not be resent. The call can batch those UUID/value/operation
entries; exact envelope and partial-failure behavior remain integration
details. Create cannot silently overwrite an existing identity. Reads return
decoded JavaScript values. Updates use stable inputs and stale-write protection
so late completion cannot replace newer state. Deletion includes changed index
artifacts and required reconciliation metadata in the same persistence work.

The invocation/result envelope, absence of a configured workflow, retry and
failure semantics are explicit integration parameters; no hidden storage
fallback is permitted. UUID is a logical address, not a required filename.

## Unified serialization

All data artifacts use one portable lossless codec contract for supported JavaScript values. Runtime state is decoded; persisted artifacts are encoded bytes. No per-file extension detection, raw/text switch, attachment extraction or default Base64 representation for ordinary binary values is used.

Required round trips preserve nested objects/arrays, strings, booleans, null, explicit undefined versus missing, finite numbers, NaN, positive/negative infinity and native binary bytes. The codec contract defines BigInt, typed arrays, Buffer/Uint8Array/ArrayBuffer normalization, Date, sparse arrays, Map/Set and cyclic/shared references explicitly; no unsupported type or cross-process reference identity is promised. Unsupported values fail explicitly. UTC ISO date strings remain strings. Decoding is bounded and does not evaluate executable content, invoke arbitrary constructors or infer schemas.

Codec identity/version compatibility is defined independently of the bootstrap package version. The same value model applies to supported Socket, Mesh and IPC paths; a transport unable to preserve a value must not silently lose it. Index segmentation does not imply large binary streaming or object fragmentation. Message and memory limits are explicit.

### CoSON object artifacts

Object document artifacts use the `.coson` suffix and CoSON frame format.
Their stored values may be operator-preserving prepared objects received from a
transport. CoSON `decode(..., { operators: false })` restores the prepared form,
including object-local `binary[n]` references and raw-byte descriptor arrays.
Those bytes belong to each document object, not to the CRUD request envelope.
The DB excludes descriptor metadata from property indexing while indexing an
ordinary application property named `binary` normally. Reads return the prepared
object so it can be cached or transported again without evaluating operators.

## Encryption and integrity

Write: stable resulting decoded value → serialize → optionally encrypt → provider writes bytes. Read: acquire bytes → decrypt when required → deserialize → validate → publish decoded value. The workflow boundary identifies encoding ownership so values are not serialized twice. Encryption policy and key selection belong to the workflow; authenticated encryption, versioned key references and key rotation/recovery protect all sensitive data artifact types, including indexes and catalogs. Keys are not stored with ciphertext. Transport security remains independent. The bootstrap and local inventory follow their own security policies.

## Timing and durability

Response-first processing is unconditional: after required acquisition and in-memory result construction, client response and immediate peer dispatch do not wait for persistence, serialization for persistence or background indexing. The response confirms in-memory processing only. Stable pending work, queue bounds, backpressure, retry reporting and failure visibility are required independently of completed responses. Background failures do not retroactively rewrite replies.

`flush()` and orderly shutdown drain pending core work and workflow invocations according to the documented integration guarantee. They do not imply atomic commits across artifacts or providers. Partial provider failure, interrupted index publication, orphan cleanup, replay and crash recovery require explicit handling. Durable replica acknowledgment is distinct from dispatch or provider invocation success. No silent namespace reset or automatic recreation of missing data is permitted.
