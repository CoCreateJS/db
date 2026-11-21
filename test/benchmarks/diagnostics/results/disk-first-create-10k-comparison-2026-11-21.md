# 10K Disk-First Create Peak RSS Comparison

Both runs used separate Node processes, the same residency diagnostic fixture, 10,000 object leaves, 250 objects per request (40 sequential requests), and `disk-first` mode. Memory policy eviction was disabled so the comparison isolates disk-first request behavior. The measured memory value is process peak RSS (`resourceUsage().maxRSS`), not a periodic sample.

| Acknowledgement | Elapsed create + index | Peak RSS | Object leaves on disk | Branch files | Leaf writes |
| --- | ---: | ---: | ---: | ---: | ---: |
| `memory` | 132.50 s | 491.80 MiB | 10,000 | 499 | 215,004 |
| `disk` | 129.81 s | 491.58 MiB | 10,000 | 499 | 215,004 |

The peak RSS difference was 0.22 MiB (about 0.04%), effectively no material difference in this run. Waiting for disk acknowledgement did not lower peak memory. The total runtime was also similar. Both runs wrote 9,754 index branches and had no pending indexing work at completion. Four additional leaf files are structural roots, so each run has 10,004 leaf files total.

The leaf-write counter is high relative to 10,000 records. This test answers the requested peak-memory comparison; the write amplification is a separate follow-up if you want to inspect it.

## Raw results

- [Memory acknowledgement](disk-first-create-10k-memory-2026-11-21T18-00-43.438Z.json)
- [Disk acknowledgement](disk-first-create-10k-disk-2026-11-21T18-04-31.214Z.json)
