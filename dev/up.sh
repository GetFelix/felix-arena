#!/usr/bin/env bash
# Start the development stack from scratch and wait for the broker. The
# control plane keeps its state in memory, so the broker's log is reset with
# it: a log that outlived its control plane would no longer match it.
set -euo pipefail
cd "$(dirname "$0")"

# Docker or Podman: CONTAINER_ENGINE if set, else Docker when its daemon
# answers, else Podman.
engine="${CONTAINER_ENGINE:-}"
if [[ -z "$engine" ]]; then
  if docker info >/dev/null 2>&1; then
    engine=docker
  elif command -v podman >/dev/null 2>&1; then
    engine=podman
  else
    echo "no container engine: start Docker, or install Podman (and run podman machine start on macOS)" >&2
    exit 1
  fi
fi
compose=("$engine" compose -f compose.yml)

# podman compose hands off to docker-compose, which reads ~/.docker/config.json.
# A credsStore left there by Docker Desktop names a helper that is gone, and
# every pull fails. The images are public, so use an empty config instead.
if [[ "$engine" == podman && -z "${DOCKER_CONFIG:-}" ]]; then
  DOCKER_CONFIG="$(mktemp -d)"
  export DOCKER_CONFIG
fi

"${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
rm -rf state
mkdir -p state
if ! "${compose[@]}" up --detach --build; then
  "${compose[@]}" logs >&2
  exit 1
fi

for _ in $(seq 1 90); do
  if [[ -f state/seeded ]] && curl -fsS http://127.0.0.1:8080/ready >/dev/null 2>&1; then
    echo "Felix is ready, with arenas alpha and bravo."
    echo "  gateway:      ws://127.0.0.1:8787"
    echo "  sim's ticks:  $engine compose -f dev/compose.yml logs -f sim"
    exit 0
  fi
  sleep 2
done

echo "the broker did not become ready" >&2
"${compose[@]}" ps --all >&2
"${compose[@]}" logs >&2
exit 1
