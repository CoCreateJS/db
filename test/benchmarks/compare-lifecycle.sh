#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
size="${1:-1000}"
samples="${BENCH_SAMPLES:-40}"
old_ref="${OLD_REF:-dev}"
temporary_root="$(mktemp -d /tmp/cocreate-db-compare.XXXXXX)"
old_worktree="$temporary_root/old"
comparison_dir="$repo_root/test/benchmarks/comparisons/$(date -u +%Y%m%dT%H%M%SZ)"

cleanup() {
    git -C "$repo_root" worktree remove --force "$old_worktree" >/dev/null 2>&1 || true
    rmdir "$temporary_root" 2>/dev/null || true
}
trap cleanup EXIT

git -C "$repo_root" worktree add --detach "$old_worktree" "$old_ref"
mkdir -p "$comparison_dir/old" "$comparison_dir/next"
printf '%s %s\n' "$old_ref" "$(git -C "$repo_root" rev-parse "$old_ref")" > "$comparison_dir/old-source.txt"
mkdir -p "$old_worktree/test/fixtures"
cp "$repo_root/test/fixtures/lifecycle.mjs" "$old_worktree/test/fixtures/lifecycle.mjs"
cp "$repo_root/test/benchmarks/db-lifecycle-20261118/benchmark.mjs" \
    "$old_worktree/test/benchmarks/db-lifecycle-20261118/benchmark.mjs"
ln -s "$repo_root/node_modules" "$old_worktree/node_modules"

BENCH_SAMPLES="$samples" BENCH_OUTPUT_DIR="$comparison_dir/old" \
    node "$old_worktree/test/benchmarks/db-lifecycle-20261118/benchmark.mjs" "$size"
BENCH_SAMPLES="$samples" BENCH_OUTPUT_DIR="$comparison_dir/next" \
    node "$repo_root/test/benchmarks/lifecycle-next.mjs" "$size"
node "$repo_root/test/benchmarks/report-lifecycle-comparison.mjs" "$comparison_dir"

printf 'comparison=%s\n' "$comparison_dir"
printf 'fixture=%s\n' "$(node --input-type=module -e "import { createLifecycleFixture, lifecycleFixtureHash } from '$repo_root/test/fixtures/lifecycle.mjs'; console.log(lifecycleFixtureHash(createLifecycleFixture($size)))")"
