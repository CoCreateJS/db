# One organization, 20 primary trees benchmark

Status: passed. One organization with 20 configured top-level primary roots and 20,000 records per primary tree (400,000 total). Observed live primary Trees: 20.

Create + index wall time: 232.31 s. Throughput: 1722 records/s. Peak process RSS: 2146.9 MiB.

| Primary root | Records | Acknowledged at (s) | Remaining index drain (s) | Pending after indexing |
| --- | ---: | ---: | ---: | ---: |
| primary_01 | 20000 | 37.67 | 194.45 | 0 |
| primary_02 | 20000 | 37.71 | 194.41 | 0 |
| primary_03 | 20000 | 37.74 | 194.40 | 0 |
| primary_04 | 20000 | 37.77 | 194.33 | 0 |
| primary_05 | 20000 | 37.81 | 194.38 | 0 |
| primary_06 | 20000 | 37.84 | 194.32 | 0 |
| primary_07 | 20000 | 37.87 | 194.40 | 0 |
| primary_08 | 20000 | 37.96 | 194.02 | 0 |
| primary_09 | 20000 | 38.00 | 194.23 | 0 |
| primary_10 | 20000 | 38.03 | 194.22 | 0 |
| primary_11 | 20000 | 38.06 | 194.13 | 0 |
| primary_12 | 20000 | 38.09 | 194.12 | 0 |
| primary_13 | 20000 | 38.12 | 193.86 | 0 |
| primary_14 | 20000 | 38.15 | 194.15 | 0 |
| primary_15 | 20000 | 38.19 | 194.10 | 0 |
| primary_16 | 20000 | 38.22 | 193.95 | 0 |
| primary_17 | 20000 | 38.30 | 193.97 | 0 |
| primary_18 | 20000 | 38.33 | 193.95 | 0 |
| primary_19 | 20000 | 38.36 | 193.95 | 0 |
| primary_20 | 20000 | 38.40 | 193.79 | 0 |

Correctness: {"allPrimaryTreesInitialized":true,"primaryTreeCountMatched":true,"uuidReads":"passed for all 20","indexedReads":"passed for all 20","updateIsolationAcrossTrees":"passed"}. Pruning: false; peak Node memory: 54.15%.
