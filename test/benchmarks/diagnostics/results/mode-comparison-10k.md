# CoCreateDB 10K Mode Comparison

Date: 2026-11-21  
Fixture: shared lifecycle fixture v3, 10,000 records  
Fixture SHA-256 (both runs): `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`  
Node: v24.18.0  
Configuration: index size 64, leaf size 64, 1,000 records per create batch, synchronous index maintenance, memory acknowledgement. Each mode ran in a fresh process and temporary database directory. External persistence was not configured.

| Metric | Disk-first | Adaptive |
| --- | ---: | ---: |
| Create and index 10,000 records | 10,261 ms | 3,075 ms |
| Local branch writes | 6,499 | 5,107 |
| Local leaf writes | 10,302 | 0 |
| Branch files at end | 5,116 | 5,107 |
| Leaf files at end | 9,999 | 0 |
| On-disk bytes at end | 13,444,373 | 8,296,391 |
| Branch reads | 1,383 | 18 |
| Leaf reads | 303 | 0 |
| Hot leaves at end | 4 | 10,003 |
| Hot branches at end | 154 | 181 |
| RSS at end | 272,007,168 | 259,678,208 |

Both runs passed the UUID, equality, nested equality, range, update and delete checks. Their timings also show why mode matters for reads: the disk-first run reloaded/warmed data from leaf files, while adaptive retained all leaves in memory.

## Conclusion

Adaptive is not disk-write-free: it wrote 5,107 branch index files (about 8.30 MB total on disk), while keeping all 10,003 leaves hot and writing no leaf files. Disk-first wrote both branches and leaves, ending with 9,999 leaf files and only four hot leaves. Thus the behavior is consistent with the intended distinction: adaptive keeps data leaves hot when memory permits but still persists index branches; disk-first also persists and sheds the data leaves.

These are single diagnostic runs, not a statistical performance baseline. The workload, fixture hash and configuration match; timing variance was not sampled across repeated runs.

## Raw results

- [Disk-first JSON](mode-10k-disk-first-2026-11-21T16-44-59.881Z.json)
- [Adaptive JSON](mode-10k-adaptive-2026-11-21T16-45-17.402Z.json)
