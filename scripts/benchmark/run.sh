#!/usr/bin/env bash
set -euo pipefail

benchmark_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$benchmark_dir/../.." && pwd)
binary=$(realpath -m -- "${1:-$repo_dir/build/linux-x64/mc-status}")
history_days=${HISTORY_DAYS:-30}
base_url=http://127.0.0.1:3000

for command in bun k6 pidstat curl ss stdbuf; do
  if ! command -v "$command" >/dev/null; then
    printf 'Install %s before starting the benchmark.\n' "$command" >&2
    exit 1
  fi
done

if [[ ! -x $binary ]]; then
  printf 'Build the Linux executable or pass its executable path to this script.\n' >&2
  exit 1
fi

listeners=$(ss -H -ltn 'sport = :3000')
if [[ -n $listeners ]]; then
  printf 'Port 3000 is already in use. Run on a host where the port is free.\n' >&2
  exit 1
fi

# Keep the test config, database, and reports together in a private directory.
umask 077
run_dir=$(mktemp -d "${TMPDIR:-/tmp}/mc-status-benchmark.XXXXXXXX")
run_dir=$(realpath -- "$run_dir")
printf 'Benchmark results directory: %s\n' "$run_dir"

fixture_pid=
app_pid=
sampler_pid=
cleanup() {
  local pid
  for pid in "$sampler_pid" "$app_pid" "$fixture_pid"; do
    if [[ -n $pid ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mark() {
  printf '%s\t%s\n' "$(date -u +%s)" "$1" | tee -a "$run_dir/phases.tsv"
}

disk_sizes() {
  local path
  for path in "$run_dir"/mc-status.db* "$run_dir/logs" "$run_dir/server.log"; do
    if [[ -e $path ]]; then
      du -sb -- "$path"
    fi
  done
}

{
  uname -smr
  printf '%s CPUs available\n' "$(nproc)"
  printf 'Bun %s\n' "$(bun --version)"
  k6 version
  pidstat -V
  sha256sum -- "$binary"
  stat -c 'Executable size %s bytes' -- "$binary"
} > "$run_dir/environment.txt" 2>&1

# The fixture publishes targets.yaml once the local HTTP server and history are ready.
bun --no-env-file "$benchmark_dir/fixture.ts" "$run_dir" "$history_days" \
  > "$run_dir/fixture.log" 2>&1 &
fixture_pid=$!
for ((attempt = 0; attempt < 300; attempt++)); do
  kill -0 "$fixture_pid" 2>/dev/null || break
  [[ -s "$run_dir/targets.yaml" ]] && break
  sleep 0.2
done
if [[ ! -s "$run_dir/targets.yaml" ]] || ! kill -0 "$fixture_pid" 2>/dev/null; then
  printf 'The fixture failed to initialize. See %s/fixture.log\n' "$run_dir" >&2
  exit 1
fi
cat "$run_dir/fixture.log"

export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
# Run the executable with the fixture's files and empty service credentials.
(
  cd -- "$run_dir"
  export DB_PATH="$run_dir/mc-status.db" LOG_DIR="$run_dir/logs"
  export GITHUB_TOKEN= DISCORD_WEBHOOK_URL=
  exec "$binary"
) > "$run_dir/server.log" 2>&1 &
app_pid=$!

for ((attempt = 0; attempt < 100; attempt++)); do
  kill -0 "$app_pid" 2>/dev/null || break
  health=$(curl -fs --max-time 1 "$base_url/healthz" || true)
  [[ $health == ok ]] && break
  sleep 0.1
done
if [[ ${health:-} != ok ]] || ! kill -0 "$app_pid" 2>/dev/null; then
  printf 'mc-status failed to start. See %s/server.log\n' "$run_dir" >&2
  exit 1
fi

# Sample only mc-status. The phase markers use the same clock as pidstat.
disk_sizes > "$run_dir/disk-before.tsv"
TZ=UTC S_TIME_FORMAT=ISO LC_ALL=C stdbuf -oL pidstat -H -h -u -r -d -p "$app_pid" 1 \
  > "$run_dir/pidstat.txt" 2>&1 &
sampler_pid=$!

# Measure two minutes of background checks before requesting the status page.
mark monitor_start
sleep 120
mark monitor_end
if ! kill -0 "$sampler_pid" 2>/dev/null; then
  printf 'Resource sampling stopped early. See %s/pidstat.txt\n' "$run_dir" >&2
  exit 1
fi

# Warm the page once, then capture both load profiles even if a threshold fails.
curl -fsS --max-time 10 -o /dev/null "$base_url/"
status=0
for profile in steady burst; do
  mark "${profile}_start"
  k6 run --no-usage-report -e "PROFILE=$profile" -e "BASE_URL=$base_url" \
    --out "json=$run_dir/$profile.jsonl" "$benchmark_dir/page.js" \
    2>&1 | tee "$run_dir/$profile.txt" || status=$?
  mark "${profile}_end"
done

if ! kill -0 "$sampler_pid" 2>/dev/null; then
  printf 'Resource sampling stopped early. See %s/pidstat.txt\n' "$run_dir" >&2
  status=1
fi
awk '/^VmHWM:/ { print }' "/proc/$app_pid/status" > "$run_dir/peak-rss.txt"
disk_sizes > "$run_dir/disk-after.tsv"
printf 'Results saved to %s\n' "$run_dir"
exit "$status"
