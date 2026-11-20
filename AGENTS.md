# CoCreateDB — Agent Instructions

## Documentation

- Read [README.md](README.md) for the project overview and public API.
- Read [specifications/](specifications/) for authoritative architectural and behavioral contracts.
- Distinguish implemented functionality from proposed capabilities.

## Development

- Use native JavaScript and ESM.
- Prefer concise implementations, native loops and live references.
- Avoid unnecessary abstractions, allocations and repeated traversal.
- Preserve CoCreate terminology: array, object, key, index, scope and artifact.
- Keep persistence, distribution and transactional orchestration outside the database engine.
- Preserve standalone and primary/worker execution.
- Update the relevant specifications when architectural contracts change.

## Validation

- Run `npm test`.
- Add or update regression tests for behavioral changes.
- Benchmark performance-sensitive changes using equivalent workloads.
- Report verified results and implementation limitations.

