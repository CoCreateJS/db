# CoCreateDB 10K Restart and UUID Stability

**Run date:** 2026-11-21  
**Mode:** adaptive (default)  
**Acknowledgement:** memory (default)  
**Fixture SHA-256:** `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`  
**Base revision:** `7d9c347d0385de84d9aefa6acbb00dafec9edaa7` (working tree dirty)

## Result

The database now writes changed leaves and index branches after acknowledging the request, and persists the active field/type route root UUIDs in `config.json`. Before an explicit `flushDisk()` call, the 10K adaptive run already had all 10,004 leaves, 321 branch files, and 18 index routes on disk.

The seed and restart read ran in separate Node processes against the same temporary base directory. On restart, all four structural root UUIDs and all 18 route root UUIDs matched the seed. A direct UUID read returned rank 5000. The indexed equality query returned the expected 100 of 100 records after reading 20 branch files and hydrating 1,030 leaves.

The 10K create and background-write phase took 3.59 seconds. This is a correctness and restart check, not a comparative performance benchmark. The files and route catalog were present before the explicit `flushDisk()` checkpoint.

## Before this correction

The previous restart diagnostic found that structural root UUIDs remained stable and direct UUID reads worked in disk-first mode, but index route roots were not restored: zero of 17 route UUIDs were reused, and equality returned 0 instead of 100. In adaptive mode, no leaf files had been written, so a fresh process could not read the stored objects.

## Artifacts

- [Seed measurements](restart-10k-adaptive-route-seed.json)
- [Fresh-process read measurements](restart-10k-adaptive-route-read.json)
- [Earlier restart comparison](restart-comparison-10k-2026-11-21.md)

## Validation

`npm test` passed all 54 tests. The separate-process 10K restart check passed its UUID and query-result assertions.
