/** Keep submitted adapter work distinct from file I/O and pending work. */
export function writeAccounting(requests, filesystem) {
    return Object.fromEntries(['leaf', 'branch', 'config'].map(kind => {
        const keys = (kind === 'config' ? ['config', 'roots'] : [kind]).map(name => `${name}.write`)
        const sum = field => keys.reduce((total, key) => total + (requests[field]?.[key] ?? 0), 0)
        const writes = filesystem[`${kind}.writeFile`] ?? {}
        return [kind, {
            submittedWriteRequests: sum('submittedRequestsByKind'),
            submittedWriteBytes: sum('submittedWriteBytesByKind'),
            supersededWriteRequests: sum('supersededRequestsByKind'),
            cancelledWriteRequests: sum('cancelledRequestsByKind'),
            outstandingWriteRequests: sum('outstandingRequestsByKind'),
            filesystemWritesStarted: writes.startedCalls ?? 0,
            filesystemWritesCompleted: writes.completedCalls ?? 0,
            filesystemWritePayloadBytesCompleted: writes.payloadBytesCompleted ?? 0,
            fileReplacementsCompleted: filesystem[`${kind}.rename`]?.completedCalls ?? 0
        }]
    }))
}

export function storageTables(accounting) {
    const labels = { leaf: 'Leaf document files', branch: 'Index branch files', config: 'Configuration files (roots + catalogs)' }
    const integer = value => value.toLocaleString('en-US')
    const mib = value => (value / 1048576).toFixed(2)
    const entries = Object.entries(accounting)
    return `### Requests submitted to Disk, before coalescing

| Resource | Write requests submitted | Replaced while pending | Cancelled while pending | Write requests outstanding | Submitted payload (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
${entries.map(([kind, row]) => `| ${labels[kind]} | ${integer(row.submittedWriteRequests)} | ${integer(row.supersededWriteRequests)} | ${integer(row.cancelledWriteRequests)} | ${integer(row.outstandingWriteRequests)} | ${mib(row.submittedWriteBytes)} |`).join('\n')}

### Filesystem writes after coalescing

| Resource | File writes started | File writes completed | Files published by rename | Completed file payload (MiB) |
| --- | ---: | ---: | ---: | ---: |
${entries.map(([kind, row]) => `| ${labels[kind]} | ${integer(row.filesystemWritesStarted)} | ${integer(row.filesystemWritesCompleted)} | ${integer(row.fileReplacementsCompleted)} | ${mib(row.filesystemWritePayloadBytesCompleted)} |`).join('\n')}

These are filesystem API completions, not block-device/EBS IOPS or fsync durability.
Outstanding work is not counted as eliminated work. Replaced/cancelled counts come
from explicit adapter responses. In-memory branch mutation counts are not measured;
in-memory index readiness is reported separately from these storage tables.
`
}
