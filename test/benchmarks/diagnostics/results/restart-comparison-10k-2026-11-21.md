# CoCreateDB 10K Restart Read Check

Date: 2026-11-21 UTC  
Fixture: shared lifecycle fixture v3, 10,000 records  
Fixture SHA-256 (all runs): `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`  
Node: v24.18.0  
Source HEAD: `7d9c347d0385de84d9aefa6acbb00dafec9edaa7`; working tree was dirty, so these results reflect the live source.  
The seed and read phases ran in separate Node processes. The read phase reused the same DB base directory and did not recreate any records. Both used memory acknowledgement; adaptive omitted the mode option and used defaults.

## Results

| Check | Disk-first | Adaptive default |
| --- | ---: | ---: |
| Leaf files after seed | 10,000 | 0 |
| Branch files after seed | 304 | 0 |
| Seed directory size | 11.23 MiB | 554 bytes |
| Direct UUID reads after restart | 3 / 3 correct | 0 / 3 found |
| Leaf reads after restart | 3 | 0 |
| Equality query after restart | 0 / 100 expected | 0 / 100 expected |

### Disk-first

The fresh process loaded the existing config and read records at UUIDs for ranks 0, 5,000, and 9,999 directly from local leaf files. The leaf read counter increased from zero to three, confirming these were disk reads. The indexed equality query did not resume: it returned zero results instead of the expected 100, and no branch files were read. Persisted branch files exist, but the root/parent branch catalog is not restored for indexed lookup after restart.

### Adaptive with no mode option

The seed process completed with zero leaf or branch files and a 554-byte config directory. Its records remained only in memory. The new process loaded the config but could not find any of the three UUIDs; the leaf read count remained zero. Under the current default memory acknowledgement, adaptive mode does not guarantee local-disk survival for leaves that were never evicted.

## Conclusion

Disk-first supports direct UUID recovery across process restart, but indexed reads are not yet recovered. Adaptive default does not currently guarantee restart recovery for resident leaves. This check confirms local data behavior; it does not validate full restart continuity.

## Raw results

- [Disk-first seed](restart-10k-disk-first-seed-2026-11-21T17-31-28.449Z.json)
- [Disk-first restart reads](restart-10k-disk-first-read-2026-11-21T17-31-28.449Z.json)
- [Adaptive seed](restart-10k-adaptive-seed-2026-11-21T17-31-37.343Z.json)
- [Adaptive restart reads](restart-10k-adaptive-read-2026-11-21T17-31-37.343Z.json)
