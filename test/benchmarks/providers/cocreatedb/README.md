# CoCreateDB standard lane

The canonical same-fixture in-process benchmark is `test/benchmarks/standard.mjs`; its shared fixture is `test/fixtures/lifecycle.mjs`. The runner defaults to 10,000, 100,000 and 1,000,000 records and writes raw runs, manifests and reports under this directory's `results/` folder. The selected current-dev 100K baseline is `results/baseline-dev-100k-2026-11-25/`; `results/summary.json` summarizes that baseline and records later standard runs.

Run the standard suite from the module root with `npm run benchmark:standard`. See [`../../README.md`](../../README.md) for the measurement contract, supported environment variables and report format. CoCreateDB diagnostics are separate under `test/benchmarks/diagnostics/` and do not modify this provider-comparison history.
