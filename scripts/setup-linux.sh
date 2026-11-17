#!/usr/bin/env bash
set -euo pipefail

mode=${1:-}
if [[ $# != 1 || ( $mode != release && $mode != benchmark ) ]]; then
  printf 'Usage: bash scripts/setup-linux.sh release|benchmark\n' >&2
  exit 2
fi
if [[ $(uname -sm) != 'Linux x86_64' ]]; then
  printf 'Use an x64 Linux shell or Ubuntu in WSL2.\n' >&2
  exit 1
fi

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$repo_dir"
bun_version=$(tr -d '\r\n' < .bun-version)
tools_dir=${XDG_CACHE_HOME:-$HOME/.cache}/mc-status-tools
bun_dir=$tools_dir/bun-$bun_version
k6_release=v2.4.0
k6_dir=$tools_dir/k6-$k6_release

export PATH="$bun_dir:$k6_dir:$PATH"
packages=()
needs_bun=0
if [[ $(bun --version 2>/dev/null || true) != "$bun_version" ]]; then
  needs_bun=1
  if ! command -v python3 >/dev/null; then packages+=(python3); fi
fi
needs_k6=0
if [[ $mode == benchmark ]]; then
  if ! command -v pidstat >/dev/null; then packages+=(sysstat); fi
  if ! command -v ss >/dev/null; then packages+=(iproute2); fi
  if ! command -v k6 >/dev/null; then
    needs_k6=1
    if ! command -v dpkg-deb >/dev/null; then packages+=(dpkg); fi
  fi
fi
if ((needs_bun)) || [[ $mode == benchmark ]]; then
  if ! command -v curl >/dev/null; then packages+=(curl ca-certificates); fi
fi
if ((${#packages[@]})); then
  if ! command -v apt-get >/dev/null; then
    printf 'Install these packages with your system package manager: %s\n' "${packages[*]}" >&2
    exit 1
  fi
  apt=(apt-get)
  if ((EUID != 0)); then apt=(sudo apt-get); fi
  "${apt[@]}" update
  "${apt[@]}" install -y "${packages[@]}"
fi

cleanup_downloads() {
  rm -f -- "$downloads/bun-package.json" "$downloads/bun.tgz" "$downloads/bun" \
    "$downloads/k6.deb" "$downloads/k6"
  rmdir -- "$downloads"
}
if ((needs_bun || needs_k6)); then
  mkdir -p -- "$tools_dir"
  downloads=$(mktemp -d "$tools_dir/download.XXXXXXXX")
  trap cleanup_downloads EXIT
fi

download_file() {
  local url=$1 output=$2
  if ! curl -fsSL --connect-timeout 15 --max-time 120 --retry 2 --retry-max-time 120 \
    --output "$output" "$url"; then
    printf 'Could not download %s\n' "$url" >&2
    return 1
  fi
}

if ((needs_bun)); then
  bun_registry=https://registry.npmjs.org/@oven/bun-linux-x64
  printf 'Installing Bun %s from the npm registry\n' "$bun_version"
  download_file "$bun_registry/$bun_version" "$downloads/bun-package.json"
  bun_sha=$(python3 -c '
import base64, json, sys
algorithm, digest = json.load(sys.stdin)["dist"]["integrity"].split("-", 1)
if algorithm != "sha512":
    sys.exit("Bun package metadata is missing a SHA-512 checksum.")
print(base64.b64decode(digest, validate=True).hex())
' < "$downloads/bun-package.json")
  download_file "$bun_registry/-/bun-linux-x64-$bun_version.tgz" "$downloads/bun.tgz"
  printf '%s  %s\n' "$bun_sha" "$downloads/bun.tgz" | sha512sum --check --strict
  tar -xOzf "$downloads/bun.tgz" package/bin/bun > "$downloads/bun"
  mkdir -p -- "$bun_dir"
  chmod 755 -- "$downloads/bun"
  mv -fT -- "$downloads/bun" "$bun_dir/bun"
fi

bun install --frozen-lockfile

if [[ $mode == release ]]; then
  bun run validate
  bun run build:linux
  printf 'Linux deployment package: %s/build/linux-x64\n' "$repo_dir"
  exit 0
fi

if ((needs_k6)); then
  k6_url=https://dl.k6.io/deb/dists/stable/main/binary-amd64/k6-$k6_release-amd64.deb
  k6_sha=25f2817218a45f3d9182e3302b09fb0fc1c138811b1314b36549121f1c79b84f
  printf 'Installing k6 %s from Grafana’s package repository\n' "$k6_release"
  download_file "$k6_url" "$downloads/k6.deb"
  printf '%s  %s\n' "$k6_sha" "$downloads/k6.deb" | sha256sum --check --strict
  dpkg-deb --fsys-tarfile "$downloads/k6.deb" | tar -xOf - ./usr/bin/k6 > "$downloads/k6"
  mkdir -p -- "$k6_dir"
  chmod 755 -- "$downloads/k6"
  mv -fT -- "$downloads/k6" "$k6_dir/k6"
fi

# Build from current source in a folder separate from the release package.
bun run build:assets
binary=$repo_dir/build/benchmark-linux-x64/mc-status
bun --no-env-file build --compile --no-compile-autoload-dotenv --target=bun-linux-x64 \
  src/server.ts --outfile "$binary"
bash scripts/benchmark/run.sh "$binary"
