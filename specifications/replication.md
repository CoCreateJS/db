# Replication and communication

## External integration design (planned)

Use the normal CRUD response/envelope for clients and peers. Update operators represent mutation intent; complete updated snapshots are useful for persistence. There is no separate DB distribution message or inventory. Socket, IPC and Mesh establish recipient awareness from authorized CRUD requests and active connections, release references when interest ends, and deliver mutations to interested recipients, including receiving primaries where necessary.

Receiving nodes apply mutations against local data, preserving identity and preventing duplicate relative operations and re-origination loops. Acquisition of a complete artifact is not a new logical create. Subscribe/materialize races require a version or equivalent reconciliation mechanism. No automatic replay, subscription tracking or peer delivery is implemented by the DB checkpoint.

Read acquisition may be parallel or recursive; mutations need defined execution ownership and correlation. Shared transport encoding must preserve supported values and operators. See [distribution](distribution.md), [reconciliation](reconciliation.md) and [persistence](persistence.md).
