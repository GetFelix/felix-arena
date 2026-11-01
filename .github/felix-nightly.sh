#!/usr/bin/env bash
# The nightly run against Felix main: starts the dev stack from the Felix images
# tagged $FELIX_IMAGE_TAG (default: nightly) and runs the dev-stack checks that
# CI runs, except the ones that drive a browser. The felix-nightly workflow
# calls this after pointing Cargo.toml at the same Felix commit.
#
# It rewrites the image tags in dev/compose.yml, so run it from a throwaway
# checkout.
set -euo pipefail
cd "$(dirname "$0")/.."

tag=${FELIX_IMAGE_TAG:-nightly}
TAG=$tag perl -pi -e 's{(ghcr\.io/getfelix/felix-(?:broker|controlplane|felixctl)):[^\s"\x27]+}{$1:$ENV{TAG}}' \
  dev/compose.yml

logs() { [ $? -eq 0 ] || docker compose -f dev/compose.yml logs --no-color; }
trap logs EXIT

dev/up.sh

# Each arena reports every 5 s. The first report includes startup, so judge the
# rate on a later one.
for _ in $(seq 1 45); do
  sim_logs="$(docker compose -f dev/compose.yml logs --no-color sim 2>&1)"
  ok=0
  for arena in alpha bravo; do
    hz="$(grep 'ticks committed' <<<"$sim_logs" | grep -E "arena=\"?$arena\"? " \
      | tail -n +2 | tail -1 | grep -oE 'hz=[0-9.]+' | cut -d= -f2 || true)"
    if [[ -n "$hz" ]] && awk -v hz="$hz" 'BEGIN { exit !(hz >= 28 && hz <= 31) }'; then
      ok=$((ok + 1))
    fi
  done
  if [[ $ok -eq 2 ]]; then
    grep 'ticks committed' <<<"$sim_logs"
    break
  fi
  sleep 2
done
if [[ $ok -ne 2 ]]; then
  echo "the sim did not report 30 Hz for both arenas" >&2
  exit 1
fi

# Ticks reach a WebSocket client through the gateway and decode to the sim's
# state hashes. The decoder is the Rust core built to WebAssembly.
rustup target add wasm32-unknown-unknown
command -v wasm-bindgen >/dev/null || cargo install wasm-bindgen-cli --version 0.2.129 --locked
cd web
npm ci
npm run core
npm run smoke
