import { createHash } from 'node:crypto'

/** Versioned fixture dedicated to end-to-end DB capacity measurements. */
export const SYSTEM_FIXTURE_VERSION = 'system-workload-1.0.0'

export const systemUuid = rank => rank.toString(16).padStart(32, '0')

export function createSystemRecord({ rank, organizationId, arrayIndex, arrayName, totalRecords }) {
    if (!Number.isSafeInteger(rank) || rank < 0) throw new TypeError('rank must be a non-negative safe integer')
    if (typeof organizationId !== 'string' || !organizationId) throw new TypeError('organizationId is required')
    if (!Number.isSafeInteger(arrayIndex) || arrayIndex < 0) throw new TypeError('arrayIndex must be a non-negative safe integer')
    if (typeof arrayName !== 'string' || !arrayName) throw new TypeError('arrayName is required')
    if (!Number.isSafeInteger(totalRecords) || totalRecords < 1) throw new TypeError('totalRecords must be a positive safe integer')
    return {
        uuid: systemUuid(rank),
        _id: `item-${String(rank).padStart(9, '0')}`,
        organization_id: organizationId,
        rank,
        arrayIndex,
        arrayName,
        group: `group-${rank % 20}`,
        active: rank % 2 === 0,
        createdAt: new Date(Date.UTC(2020, 0, 1) + rank * 60_000).toISOString(),
        profile: {
            team: `team-${rank % 32}`,
            score: rank % 1000,
            location: { region: `region-${rank % 12}`, verified: rank % 3 === 0 }
        },
        tags: [`tag-${rank % 8}`, `tag-${(rank + 1) % 8}`],
        payload: 'x'.repeat(32 + (rank * 17 % 29) * 32),
        revision: 0,
        updateCount: 0,
        deleteEligible: rank < totalRecords
    }
}

/** Deterministic operation contract stored beside every system benchmark result. */
export function createSystemBlueprint({ organizations, workers, arrays, records, recordsPerCreateRequest,
    crudOperations, mixedDurationMs, mixedConcurrency }) {
    return {
        version: SYSTEM_FIXTURE_VERSION,
        topology: { organizations, workers, arrays, arraysPerOrganization: arrays / organizations,
            records, recordsPerArray: records / arrays },
        operations: {
            create: { records, recordsPerRequest: recordsPerCreateRequest, measure: 'acknowledgement wall, request latency distribution, records/s and requests/s' },
            index: { measure: 'time from create acknowledgements until pendingIndexCount reaches zero' },
            uuidRead: { requests: crudOperations, target: 'UUID point reads from the loaded fixture' },
            indexedRead: { requests: crudOperations, target: 'unique rank equality queries through the field index' },
            update: { requests: crudOperations, target: 'UUID updates to a mutable non-indexed counter' },
            delete: { requests: crudOperations, target: 'UUID deletes from a disjoint fixture sample' },
            mixed: { durationMs: mixedDurationMs, concurrency: mixedConcurrency,
                ratio: { create: 1, read: 1, update: 1, delete: 1 }, measure: 'acknowledged requests/s by type and overall' },
            disk: { measure: 'adapter operations by kind/action, bytes, completions, failures, in-flight, queue depth and per-second rates',
                completionBoundary: 'snapshot at index-ready and after each CRUD phase; never wait for disk drain' }
        }
    }
}

export function hashSystemGroups(groups) {
    const hash = createHash('sha256')
    hash.update('[')
    groups.forEach((group, groupIndex) => {
        if (groupIndex) hash.update(',')
        hash.update('[')
        group.forEach((record, recordIndex) => {
            if (recordIndex) hash.update(',')
            hash.update(JSON.stringify(record))
        })
        hash.update(']')
    })
    hash.update(']')
    return hash.digest('hex')
}
