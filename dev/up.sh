#!/usr/bin/env bash
# Start the development stack from scratch and wait for the broker. The
# control plane keeps its state in memory, so the broker's log is reset with
# it: a log that outlived its control plane would no longer match it.
#
# `--cluster` starts three replicating brokers instead of one (compose.cluster.yml).
set -euo pipefail
cd "$(dirname "$0")"

source ./engine.sh

health=("${ARENA_BROKER_PORT:-8080}")
cluster_file=()
if [[ "${1:-}" == "--cluster" ]]; then
  compose+=(-f compose.cluster.yml)
  cluster_file=(-f dev/compose.cluster.yml)
  health=("${ARENA_BROKER_PORT:-8080}" 8081 8082)
fi

"${compose_all[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
rm -rf state
mkdir -p state
if ! "${compose[@]}" up --detach --build; then
  "${compose[@]}" logs >&2
  exit 1
fi

ready() {
  [[ -f state/seeded ]] || return 1
  for port in "${health[@]}"; do
    curl -fsS "http://127.0.0.1:$port/ready" >/dev/null 2>&1 || return 1
  done
}

# Every shard has a leader and all its copies, with none being added. A
# broker's /ready doesn't say this, and stopping a broker before it holds can
# leave a shard without a majority.
replicated() {
  local body
  body="$(curl -fsS -H "authorization: Bearer $(cat state/node.token)" \
    http://127.0.0.1:8443/v1/placement/replication 2>/dev/null)" || return 1
  node -e '
    const { items } = JSON.parse(process.argv[1]);
    const done = (i) => i.leader && !i.under_replicated && !i.restoring && !i.unavailable?.length;
    if (items.length === 0 || !items.every(done)) process.exit(1);
    const copies = new Set(items.map((i) => i.current_replicas));
    console.log(`${items.length} shards placed, each with ${[...copies].join(" or ")} copies`);
  ' "$body"
}

waited=0
for _ in $(seq 1 90); do
  if ready; then
    if [[ ${#health[@]} -gt 1 ]]; then
      if ! replicated; then
        if ((waited++ == 0)); then echo "waiting for every shard to have all three copies"; fi
        sleep 2
        continue
      fi
      # Each broker signs its own certificate; the gateway and the sim trust
      # all three. The gateway started before the file existed, so start it again.
      cat state/broker-?-cert.pem >state/broker-cert.pem
      "${compose[@]}" restart gateway >/dev/null
    fi
    echo "Felix is ready, with arenas alpha and bravo."
    echo "  gateway:      ws://127.0.0.1:8787"
    echo "  sim's ticks:  $engine compose -f dev/compose.yml ${cluster_file[*]:-} logs -f sim"
    exit 0
  fi
  sleep 2
done

echo "the broker did not become ready" >&2
"${compose[@]}" ps --all >&2
"${compose[@]}" logs >&2
exit 1
