#!/usr/bin/env bash
# Install Felix and this chart on the current kind cluster, as CI does. The
# arena images must be loaded into the cluster as :ci, and FELIX_CHART must be
# the felix chart (deploy/helm/felix in the Felix repository).
set -euo pipefail
cd "$(dirname "$0")"
: "${FELIX_CHART:?set FELIX_CHART to the felix chart directory}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
kubectl create secret generic felix-bootstrap --from-literal=token="$(openssl rand -hex 24)"
kubectl create secret generic felix-raft-peer --from-literal=token="$(openssl rand -hex 24)"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
  -subj /CN=felix-broker -addext subjectAltName=DNS:felix-broker \
  -addext basicConstraints=critical,CA:FALSE -addext extendedKeyUsage=serverAuth \
  -keyout "$tmp/tls.key" -out "$tmp/tls.crt" 2>/dev/null
kubectl create secret tls felix-broker-tls --cert="$tmp/tls.crt" --key="$tmp/tls.key"

# The brokers need the credential the seed mints, so they come last.
helm install felix "$FELIX_CHART" -f felix-values.yaml --wait --timeout 8m
helm install felix-arena .. -f kind-values.yaml
kubectl wait --for=condition=complete job -l app.kubernetes.io/component=seed --timeout 5m
helm upgrade felix "$FELIX_CHART" -f felix-values.yaml --set broker.enabled=true --wait --timeout 10m

# The seed made the streams before any broker registered, so Felix did not treat this as a new cluster and
# left its features off. The sim's commits need them; the broker's token may finalize them.
kubectl port-forward svc/felix-controlplane 18443:8443 >/dev/null &
forward=$!
trap 'kill "$forward" 2>/dev/null; rm -rf "$tmp"' EXIT
token=$(kubectl get secret felix-arena-broker-credential -o jsonpath='{.data.token}' | base64 -d)
api=http://127.0.0.1:18443/v1/fleet/features
# A finalize is refused until a broker is serving, so wait for it to register.
features='{}'
for _ in $(seq 1 90); do
  features=$(curl -sf -H "Authorization: Bearer $token" "$api" || echo '{}')
  [ "$(jq -r '.serving_nodes // 0' <<<"$features")" -gt 0 ] && break
  sleep 2
done
echo "fleet features: $features"
# In the order Felix requires. A feature the broker's release does not report is skipped.
for feature in generation_start majority_ack lease_free_reads fenced_caches jump_hash_routing atomic_commit \
  stream_incarnations group_cursor_dependencies cache_incarnations; do
  if ! jq -e --arg f "$feature" '.supported | index($f)' <<<"$features" >/dev/null; then
    echo "skipping $feature: the broker does not report it"
    continue
  fi
  code=$(curl -sS -o "$tmp/finalize.out" -w '%{http_code}' -X POST -H "Authorization: Bearer $token" "$api/$feature/finalize")
  if [ "$code" != 200 ]; then
    echo "finalize $feature answered $code: $(cat "$tmp/finalize.out")" >&2
    exit 1
  fi
done
kubectl rollout status deployment/felix-arena-gateway --timeout 5m
kubectl rollout status deployment/felix-arena-sim --timeout 5m
