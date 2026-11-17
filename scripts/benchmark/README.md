# Benchmark mc-status

From the repo root on Ubuntu x64 or Ubuntu in WSL2, run the setup and benchmark in one command. Port 3000 must be free.

```bash
bash scripts/setup-linux.sh benchmark
```

It installs any missing tools, installs locked project dependencies, builds a separate executable under `build/benchmark-linux-x64/`, and starts the benchmark. Missing OS packages may require your `sudo` password. The script caches downloaded tools under `${XDG_CACHE_HOME:-$HOME/.cache}/mc-status-tools` and adds them to its own `PATH`.

Each run creates a private results directory under `${TMPDIR:-/tmp}` and prints its path. The runner creates its own `targets.yaml`, SQLite database, and local HTTP fixture and launches the binary with Discord and GitHub credentials empty. It stops the fixture, executable, and sampler when it exits and leaves the results directory available for inspection.

| Phase | Workload |
| --- | --- |
| Monitoring | Two minutes with 18 local HTTP checks, a 60-second interval, and no status-page traffic |
| Steady | Five requests per second to `/` for two minutes, following one warm-up request |
| Burst | 20 concurrent clients making one request each to `/` |

The default fixture seeds 777,600 passing samples across 30 days. To compare with a fresh database, run `HISTORY_DAYS=0 bash scripts/setup-linux.sh benchmark`. The benchmark takes about four to five minutes.

## Read the results

- `steady.txt` and `burst.txt` contain the k6 summaries. Read `http_req_duration` for p95, `http_req_failed` for errors, `dropped_iterations` for missed scheduled requests in the steady phase, and `data_received` and `data_sent` for load-client traffic. The JSONL files contain the individual metric samples. k6 checks for HTTP 200 on every request and verifies the expected request count.
- `pidstat.txt` samples the executable's CPU, resident RAM in KiB (`RSS`), and disk I/O every second. `%CPU` is relative to one logical CPU. Match its epoch timestamps with `phases.tsv`. A short burst may fit into a single sample. `peak-rss.txt` records the kernel's process memory high-water mark for the whole run.
- `disk-before.tsv` and `disk-after.tsv` give file sizes in bytes around the measured phases. `environment.txt` records tool versions, host details, the executable's size, and its SHA-256. `fixture.log` records the seeded row count. Keep these files with the results when comparing runs.
