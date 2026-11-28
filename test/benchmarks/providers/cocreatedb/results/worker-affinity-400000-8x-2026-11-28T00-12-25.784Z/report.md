# Worker organization affinity benchmark

Status: passed. Total records: 400,000; workers and organizations: 8; disk mode: local. The benchmark driver has no DB. Each worker process initializes a local DB instance and owns exactly one organization. Work is pinned to that worker for the entire run.

## Assignment

| Worker | Organization | Records | PID |
| --- | --- | ---: | ---: |
| 1 | 000000000000000000000001 | 50,000 | 137299 |
| 2 | 000000000000000000000002 | 50,000 | 137300 |
| 3 | 000000000000000000000003 | 50,000 | 137301 |
| 4 | 000000000000000000000004 | 50,000 | 137307 |
| 5 | 000000000000000000000005 | 50,000 | 137313 |
| 6 | 000000000000000000000006 | 50,000 | 137319 |
| 7 | 000000000000000000000007 | 50,000 | 137320 |
| 8 | 000000000000000000000008 | 50,000 | 137331 |

## Throughput and acknowledgements

CRUD request loops run sequentially within each worker and concurrently across workers. Throughput uses host-side IPC acknowledgement wall time. Mutation index drain is reported separately.

| Operation | Requests | Records / operations | Ack wall (ms) | Requests/s | Records / operations/s | Avg ack (ms) | P95 ack (ms) | Index drain (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bulkCreate | 400 | 400000 | 25893.20 | 15.4 | 15448.1 | 483.944 | 654.391 | 8.50 |
| create | 80000 | 80000 | 183072.71 | 437.0 | 437.0 | 17.916 | 30.955 | 1.51 |
| readByUuid | 80000 | 80000 | 8494.90 | 9417.4 | 9417.4 | 0.825 | 1.506 | 0.00 |
| indexedRead | 80000 | 80000 | 23375.73 | 3422.4 | 3422.4 | 2.295 | 4.105 | 0.00 |
| update | 80000 | 80000 | 22063.97 | 3625.8 | 3625.8 | 2.179 | 5.218 | 1.12 |
| delete | 80000 | 80000 | 82116.85 | 974.2 | 974.2 | 8.149 | 16.305 | 1.35 |
| overall | 400400 | 800000 | 345017.36 | 1160.5 | 2318.7 | - | - | 12.48 |

Bulk create and indexing wall time: 25.92 s. Bulk create acknowledgement-to-index tail: 0.01 s. Pending index items at index-ready: 0. Pending disk items at index-ready: 580841. Index readiness waits only for the index queue; disk backlog remains an independent measurement.

Host CPU average across 8 available logical CPUs: 82.92%. Host memory average used: 50.40%; peak sampled used: 56.40%. Observed aggregate worker RSS peak: 15227.2 MiB. Sum of per-worker peak RSS values: 15241.5 MiB; individual peaks may not be simultaneous.

Disk queue and adapter at index-ready: {"started":1112168,"completed":531287,"failed":40,"inFlight":580841,"bytesWritten":1037660264,"outstanding":580841,"byKindAction":{"roots.read":8,"roots.write":32,"config.read":32,"leaf.write":400024,"branch.write":311648,"config.write":424,"leaf.has":400000},"bytesByKindAction":{"roots.write":10472,"leaf.write":201341112,"branch.write":835287264,"config.write":1021416},"failures":{"roots.read:ENOENT":8,"config.read:ENOENT":32}}. Disk queue and adapter at workload end: {"started":10197153,"completed":10195411,"failed":41,"inFlight":1701,"bytesWritten":58019237672,"outstanding":1701,"byKindAction":{"roots.read":8,"roots.write":32,"config.read":32,"leaf.write":560024,"branch.write":8874440,"config.write":160432,"leaf.has":480000,"branch.delete":42184,"leaf.delete":80000,"leaf.read":1},"bytesByKindAction":{"roots.write":10472,"leaf.write":282551384,"branch.write":57330834192,"config.write":405841624},"failures":{"roots.read:ENOENT":8,"config.read:ENOENT":32,"leaf.read:ENOENT":1}}. Disk mode note: real local disk adapter attached. Correctness: {"oneOrganizationPerWorker":true,"allWorkersUsed":true,"distinctWorkerProcesses":true,"allRecordsAcknowledged":true,"indexReadyOnAllWorkers":true,"crudSamplesPassed":true}.

## Disk write coalescing

Adapter counters are submitted before queue coalescing. Filesystem counters wrap writeFile, rename, access, readFile, unlink and mkdir under each worker disk directory after DB initialization, observing file operations after queue coalescing. File-level writes and bytes are not block-device or EBS I/O.

Submitted counters at index-ready: {"started":1112168,"completed":531287,"failed":40,"inFlight":580841,"bytesWritten":1037660264,"outstanding":580841,"byKindAction":{"roots.read":8,"roots.write":32,"config.read":32,"leaf.write":400024,"branch.write":311648,"config.write":424,"leaf.has":400000},"bytesByKindAction":{"roots.write":10472,"leaf.write":201341112,"branch.write":835287264,"config.write":1021416},"failures":{"roots.read:ENOENT":8,"config.read:ENOENT":32}}. Post-coalescing filesystem operations at index-ready: {"config.readFile":{"calls":32,"bytes":0,"completed":0,"failed":32},"config.mkdir":{"calls":56,"bytes":0,"completed":56,"failed":0},"config.writeFile":{"calls":48,"bytes":37568,"completed":48,"failed":0},"leaf.writeFile":{"calls":21971,"bytes":11024078,"completed":21920,"failed":0},"branch.writeFile":{"calls":9062,"bytes":15940380,"completed":9039,"failed":0},"leaf.access":{"calls":400000,"bytes":0,"completed":0,"failed":400000},"config.rename":{"calls":48,"bytes":0,"completed":48,"failed":0},"leaf.rename":{"calls":21920,"bytes":0,"completed":21901,"failed":0},"branch.rename":{"calls":9039,"bytes":0,"completed":9026,"failed":0}}. Write reduction summary at index-ready: {"leaf":{"submittedRequests":400024,"submittedBytes":201341112,"physicalWriteFileCalls":21920,"physicalWriteFileBytes":11024078,"requestReductionPercent":94.52032878027319,"byteReductionPercent":94.52467611284476},"branch":{"submittedRequests":311648,"submittedBytes":835287264,"physicalWriteFileCalls":9039,"physicalWriteFileBytes":15940380,"requestReductionPercent":97.09961238320156,"byteReductionPercent":98.09162898956879},"config":{"submittedRequests":424,"submittedBytes":1021416,"physicalWriteFileCalls":48,"physicalWriteFileBytes":37568,"requestReductionPercent":88.67924528301887,"byteReductionPercent":96.32196871793667}}.

Submitted counters at workload end: {"started":10197153,"completed":10195411,"failed":41,"inFlight":1701,"bytesWritten":58019237672,"outstanding":1701,"byKindAction":{"roots.read":8,"roots.write":32,"config.read":32,"leaf.write":560024,"branch.write":8874440,"config.write":160432,"leaf.has":480000,"branch.delete":42184,"leaf.delete":80000,"leaf.read":1},"bytesByKindAction":{"roots.write":10472,"leaf.write":282551384,"branch.write":57330834192,"config.write":405841624},"failures":{"roots.read:ENOENT":8,"config.read:ENOENT":32,"leaf.read:ENOENT":1}}. Post-coalescing filesystem operations at workload end: {"config.readFile":{"calls":32,"bytes":0,"completed":0,"failed":32},"config.mkdir":{"calls":56,"bytes":0,"completed":56,"failed":0},"config.writeFile":{"calls":167,"bytes":338610,"completed":166,"failed":0},"leaf.writeFile":{"calls":560024,"bytes":282551384,"completed":560024,"failed":0},"branch.writeFile":{"calls":280202,"bytes":562505986,"completed":280150,"failed":0},"leaf.access":{"calls":480000,"bytes":0,"completed":0,"failed":480000},"config.rename":{"calls":166,"bytes":0,"completed":165,"failed":0},"leaf.rename":{"calls":560024,"bytes":0,"completed":560024,"failed":0},"branch.rename":{"calls":280150,"bytes":0,"completed":280111,"failed":0},"branch.unlink":{"calls":41977,"bytes":0,"completed":41967,"failed":0},"leaf.unlink":{"calls":79234,"bytes":0,"completed":79225,"failed":0},"leaf.readFile":{"calls":1,"bytes":0,"completed":0,"failed":1}}. Write reduction summary at workload end: {"leaf":{"submittedRequests":560024,"submittedBytes":282551384,"physicalWriteFileCalls":560024,"physicalWriteFileBytes":282551384,"requestReductionPercent":0,"byteReductionPercent":0},"branch":{"submittedRequests":8874440,"submittedBytes":57330834192,"physicalWriteFileCalls":280150,"physicalWriteFileBytes":562505986,"requestReductionPercent":96.8431810908632,"byteReductionPercent":99.01884213978785},"config":{"submittedRequests":160432,"submittedBytes":405841624,"physicalWriteFileCalls":166,"physicalWriteFileBytes":338610,"requestReductionPercent":99.89652937069911,"byteReductionPercent":99.91656597549984}}.
