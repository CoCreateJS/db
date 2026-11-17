#!/usr/bin/env python3
"""Run the workspace CoCreateDB comparison and local-disk benchmark."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
DB = Path('/home/ubuntu/Dev/CoCreateJS/modules/db')
SCRIPTS = ('prepare.py', 'traffic.mjs', 'run-acks.py', 'local-disk.mjs', 'report.py')


def show_summary(directory):
    data = json.loads((directory / 'summary.json').read_text())
    print('\nOperations per second (current = median of three runs)')
    print(f'{"Workload":<22} {"Baseline":>10} {"Current":>10} {"Change":>9}')
    labels = {'id-c1': 'ID reads, 1 stream', 'equality-c1': 'Equality, 1 stream',
              'range-c1': 'Range, 1 stream', 'create-c16': 'Creates, 16 streams',
              'update-c16': 'Updates, 16 streams', 'mixed-c16': 'Mixed, 16 streams'}
    for key, label in labels.items():
        before = data['before'][key]['drainedOpsPerSecond']
        after = data['after'][key]['drainedOpsPerSecond']
        print(f'{label:<22} {before:>10.1f} {after:>10.1f} {(after / before - 1) * 100:>+8.1f}%')
    disk = data['disk']
    cold = [row['coldFirstReadMs'] for row in disk['runs']]
    warm = [row['warm']['p50Ms'] for row in disk['runs']]
    print(f'\nDisk fixture: {disk["documents"]} documents, {disk["updates"]} updates, three fresh processes.')
    print(f'First read: {min(cold):.2f}–{max(cold):.2f} ms; warmed read medians: {min(warm):.3f}–{max(warm):.3f} ms.')
    print('Record revisions, index reuse, peer frames, disk recovery and sidecar sizes verified.')
    print('Isolated fixtures and simulated replication; external persistence disabled.')
    print(f'\nReport: {directory / "report.md"}\nRaw summary: {directory / "summary.json"}')


def run_step(directory, script, log_name):
    print(f'\nRunning {script} ...', flush=True)
    command = ['node' if script.endswith('.mjs') else sys.executable, script]
    with (directory / log_name).open('w') as log:
        process = subprocess.Popen(command, cwd=directory, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True)
        try:
            for line in process.stdout:
                log.write(line)
                log.flush()
                if line.startswith(('START ', 'END ')):
                    print(line.rstrip(), flush=True)
            code = process.wait()
        except BaseException:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise
    if code:
        raise RuntimeError(f'{script} failed (exit {code}); inspect {directory / log_name}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='Show the workload without running or writing anything.')
    parser.add_argument('--prepare-only', action='store_true', help='Prepare isolated source copies without running the workloads.')
    parser.add_argument('--summary', type=Path, metavar='RUN_DIRECTORY', help='Print an existing run summary without rerunning tests.')
    args = parser.parse_args()
    if args.summary:
        show_summary(args.summary.resolve())
        return
    print('CoCreateDB: 128 KiB target; 1,000 seed records; three current runs and one frozen baseline run.')
    print('Workloads: ID/equality/range reads, creates, updates, mixed traffic, and local-disk restart reads.')
    print('External persistence disabled. Production code, configuration and live records are preserved.')
    print('Allow roughly 5–7 minutes; avoid other heavy workloads while measuring.')
    if args.dry_run:
        return
    if not shutil.which('node'):
        raise RuntimeError('Node.js is required.')
    if not (DB / 'node_modules').exists():
        raise RuntimeError(f'Missing DB dependencies: {DB / "node_modules"}')
    baseline = HERE / 'sources' / 'base' / 'src'
    for path in [baseline, *(HERE / script for script in SCRIPTS)]:
        if not path.exists():
            raise RuntimeError(f'Missing benchmark input: {path}')
    runs = HERE / 'runs'
    runs.mkdir(exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='run-', dir=runs))
    print(f'\nOutput: {directory}', flush=True)
    for script in SCRIPTS:
        shutil.copy2(HERE / script, directory / script)
    source = directory / 'sources' / 'base'
    shutil.copytree(baseline, source / 'src')
    (source / 'node_modules').symlink_to(DB / 'node_modules', target_is_directory=True)
    (directory / 'snapshot-baseline.txt').write_text(str(source) + '\n')
    run_step(directory, 'prepare.py', 'prepare.log')
    if args.prepare_only:
        print('Preparation verified; workloads were not run.')
        return
    run_step(directory, 'run-acks.py', 'traffic.log')
    run_step(directory, 'local-disk.mjs', 'local-disk.log')
    run_step(directory, 'report.py', 'report.log')
    show_summary(directory)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nBenchmark interrupted; partial results remain in the output directory.', file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        print(f'Benchmark failed: {error}', file=sys.stderr)
        sys.exit(1)
