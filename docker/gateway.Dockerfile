# felix-gateway with the arena's scope (dev/scope.toml: what a browser session
# may subscribe to and publish in one arena) and the built web client, which
# the gateway serves from the same port as its WebSocket.
# The release workflow builds web/dist once and puts it in the build context.
# Build from the repository root after `npm run build` in web/:
#   docker build -f docker/gateway.Dockerfile .

FROM ghcr.io/getfelix/felix-gateway:0.8.0
COPY dev/scope.toml /etc/felix-gateway/scope.toml
COPY web/dist /srv/arena
ENV GATEWAY_WEB_DIR=/srv/arena
