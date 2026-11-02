# Sourced by up.sh and down.sh: sets $engine and the $compose command.

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
# down.sh and up.sh's clean start also remove what the cluster file adds.
compose_all=("${compose[@]}" -f compose.cluster.yml)
# ARENA_COMPOSE_EXTRA names a file of overrides on top, such as retention.yml.
if [[ -n "${ARENA_COMPOSE_EXTRA:-}" ]]; then
  compose+=(-f "$ARENA_COMPOSE_EXTRA")
  compose_all+=(-f "$ARENA_COMPOSE_EXTRA")
fi

# podman compose hands off to docker-compose, which reads ~/.docker/config.json.
# A credsStore left there by Docker Desktop names a helper that is gone, and
# every pull fails. The images are public, so use an empty config instead.
if [[ "$engine" == podman && -z "${DOCKER_CONFIG:-}" ]]; then
  DOCKER_CONFIG="$(mktemp -d)"
  export DOCKER_CONFIG
fi

# The cluster file needs Compose 2.24 or later. On an older one, down.sh and
# up.sh's clean start still work on the single-broker stack.
if ! "${compose_all[@]}" config --quiet >/dev/null 2>&1; then
  compose_all=("${compose[@]}")
fi
