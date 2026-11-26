# CoCreateDB standard lane

The canonical same-fixture in-process benchmark is `test/benchmarks/standard.mjs`; its shared fixture is `test/fixtures/lifecycle.mjs`. The runner defaults to 10,000, 100,000 and 1,000,000 records and writes raw runs, manifests and reports under this directory's `results/` folder. The latest selected baselines are listed in [`results/README.md`](results/README.md); `results/summary.json` retains the standard baseline summaries and a catalog of all selected scenarios. The primary 100K baseline is `results/standard-2026-11-26T18-39-36.192Z/`.

Run the standard suite from the module root with `npm run benchmark:standard`. See [`../../README.md`](../../README.md) for the measurement contract, supported environment variables and report format. CoCreateDB diagnostics are separate under `test/benchmarks/diagnostics/` and do not modify this provider-comparison history.
