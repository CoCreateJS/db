from pathlib import Path
import os,subprocess,sys,time
out=Path(__file__).parent
runs=[('base','acked-current-1'),('baseline','acked-control-1'),('base','acked-current-2'),('base','acked-current-3')]
for variant,trial in runs:
 env=os.environ.copy();env.update(BENCH_ACK_SPLITS='1',BENCH_DOCS='1000',BENCH_READS='1000',BENCH_WRITES='100',BENCH_UPDATES='200',BENCH_MIXED='1000',BENCH_VARIANT=variant,BENCH_TRIAL=trial)
 log=out/f'{trial}.log';start=time.perf_counter()
 print(f'START {trial} ({variant})',flush=True)
 with log.open('w') as f:
  process=subprocess.Popen(['node',str(out/'traffic.mjs'),'128'],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,cwd=out)
  for line in process.stdout:
   f.write(line);f.flush();print(trial,line.strip(),flush=True)
  code=process.wait()
 print(f'END {trial} code={code} seconds={time.perf_counter()-start:.2f}',flush=True)
 if code:sys.exit(code)
