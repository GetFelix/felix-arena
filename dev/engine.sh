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

# podman compose hands off to docker-compose, which reads ~/.docker/config.json.
# A credsStore left there by Docker Desktop names a helper that is gone, and
# every pull fails. The images are public, so use an empty config instead.
if [[ "$engine" == podman && -z "${DOCKER_CONFIG:-}" ]]; then
  DOCKER_CONFIG="$(mktemp -d)"
  export DOCKER_CONFIG
fi
