# CoCreateDB standard lane

The canonical same-fixture in-process benchmark is `test/benchmarks/standard.mjs`; its shared fixture is `test/fixtures/lifecycle.mjs`. The runner defaults to 10,000, 100,000 and 1,000,000 records and writes raw runs, manifests and reports under this directory's `results/` folder. The append-only provider summary is `results/summary.json`.

Run the standard suite from the module root with `npm run benchmark:standard`. See [`../../README.md`](../../README.md) for the measurement contract, supported environment variables and report format. CoCreateDB diagnostics are separate under `test/benchmarks/diagnostics/` and do not modify this provider-comparison history.
