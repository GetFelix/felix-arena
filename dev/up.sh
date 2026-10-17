#!/usr/bin/env bash
# Start the development stack from scratch and wait for the broker. The
# control plane keeps its state in memory, so the broker's log is reset with
# it: a log that outlived its control plane would no longer match it.
set -euo pipefail
cd "$(dirname "$0")"

source ./engine.sh

"${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
rm -rf state
mkdir -p state
if ! "${compose[@]}" up --detach --build; then
  "${compose[@]}" logs >&2
  exit 1
fi

for _ in $(seq 1 90); do
  if [[ -f state/seeded ]] && curl -fsS "http://127.0.0.1:${ARENA_BROKER_PORT:-8080}/ready" >/dev/null 2>&1; then
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
