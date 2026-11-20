# Benchmarks

Node.js only. Run from the project root:

- `npm test`: correctness tests only.
- `npm run benchmark -- 1000`: deterministic lifecycle (fresh configuration).
- `BENCH_MODE=restored npm run benchmark -- 1000`: restored structural configuration.
- `npm run benchmark:ranges`: tree range checks and timings.

The shared fixture remains in `test/fixtures/lifecycle.mjs`. `BENCH_SAMPLES` defaults to 40; `BENCH_OUTPUT_DIR` overrides the default `test/benchmarks/runs` directory. Each lifecycle run writes a dated raw JSON report. `baselines/2026-11-19-final` contains the preceding and final engine measurements (20 raw runs and report). `providers/` contains earlier CoCreateDB, historical November 14 MongoDB and published/modeled Redis references; they are not equivalent controlled measurements. No provider processes are launched by this suite.

Older executable benchmark variants and test logs are preserved in the unchanged sibling `final` checkpoint and earlier workspace checkpoints. The current lifecycle replaces the older prototype lifecycle scripts. Do not delete historical Git-only benchmarks until the final committed tree has been reconciled. No new engine code is introduced here.
