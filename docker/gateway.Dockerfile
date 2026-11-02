# felix-gateway with the arena's scope baked in: what a browser session may
# subscribe to and publish in one arena (dev/scope.toml).
# Build from the repository root: docker build -f docker/gateway.Dockerfile .

FROM ghcr.io/getfelix/felix-gateway:0.8.0
COPY dev/scope.toml /etc/felix-gateway/scope.toml
