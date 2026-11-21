# CoCreateDB 10K Mode Comparison — Default Memory Policy

Date: 2026-11-21 UTC  
Fixture: shared lifecycle fixture v3, 10,000 records  
Fixture SHA-256 (both runs): `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`  
Node: v24.18.0, Linux x64  
Source HEAD: `7d9c347d0385de84d9aefa6acbb00dafec9edaa7`; working tree was dirty, so results reflect the live source rather than only that commit.  
Database options: disk-first set only `{ mode: 'disk-first' }`; adaptive used `createDB()` with no options. All other settings, including allocation percentage and index sizing, used DB defaults. Both used memory acknowledgement, 1,000-record create batches, and a one-second idle interval. No external persistence was configured.

## Startup memory calculation

| Run | Total RAM | Available at startup | Requested 25% | Effective budget |
| --- | ---: | ---: | ---: | ---: |
| Disk-first | 7.65 GiB | 5.18 GiB | 1.91 GiB | 1.91 GiB |
| Adaptive | 7.65 GiB | 5.15 GiB | 1.91 GiB | 1.91 GiB |

## Results

| Metric | Disk-first | Adaptive default |
| --- | ---: | ---: |
| Create plus index drain | 7.03 s | 2.33 s |
| Workload peak RSS through reads | 245.0 MiB | 269.0 MiB |
| Peak as share of effective budget | 12.5% | 13.7% |
| Resident records after one-second idle | 0 / 10,000 | 10,000 / 10,000 |
| Warm record files after idle | 10,000 | 0 |
| Resident records after read checks | 0 / 10,000 | 301 / 10,000 |
| Warm record files after read checks | 10,000 | 9,699 |
| Leaf writes by end of measured reads | 10,301 | 9,699 |
| Branch writes by end of measured reads | 780 | 300 |
| Database directory size | 11.23 MiB | 11.01 MiB |

The “workload peak RSS” is the process high-water mark through the read checks, before the harness enumerated files to calculate disk usage. The latter enumeration raised the process high-water mark to 250 MiB for disk-first and 281.3 MiB for adaptive; those post-measurement values are also preserved in the raw files.

## Read latency and correctness

All UUID, equality, nested equality, and range results matched expectations.

| Read | Disk-first | Adaptive default |
| --- | ---: | ---: |
| UUID | 1.46 ms | 8.34 ms |
| Equality | 29.44 ms | 3.02 ms |
| Nested equality | 62.75 ms | 1.49 ms |
| Numeric range | 64.32 ms | 2.13 ms |

These are single samples, not percentile statistics. The adaptive UUID query was its first measured query; the following queries ran after that request had caused leaf eviction.

## Idle and eviction observation

The one-second idle period caused no additional adaptive eviction: all 10,000 records remained resident. The subsequent CRUD reads triggered memory-policy checks. At that point, adaptive wrote 9,699 leaves and retained 301, while remaining in adaptive mode. Its peak workload RSS was only 13.7% of the effective budget, so the run did not approach the 90% disk-first switch. Disk-first kept records offloaded after each request.

This confirms that idle time alone does not initiate another policy check; pressure is sampled as requests run. The adaptive run’s eviction was triggered by its read workload, not by the idle wait.

## Raw results

- [Disk-first JSON](mode-10k-default-disk-first-2026-11-21T17-22-39.482Z.json)
- [Adaptive default JSON](mode-10k-default-adaptive-2026-11-21T17-22-55.643Z.json)
