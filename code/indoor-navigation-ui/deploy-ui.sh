#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-indoor-nav-ui}"
IMAGE_NAME="${IMAGE_NAME:-indoor-nav-ui}"
UI_DIR="${UI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REMOTE_NAME="${REMOTE_NAME:-origin}"
BRANCH_NAME="${BRANCH_NAME:-main}"
DOCKER_NETWORK="${DOCKER_NETWORK:-}"
LEGACY_CONTAINER_NAMES="${LEGACY_CONTAINER_NAMES:-indoor-nav-frontend}"
HOST_HTTP_PORT="${HOST_HTTP_PORT:-80}"
HOST_HTTPS_PORT="${HOST_HTTPS_PORT:-443}"
SERVER_NAME="${SERVER_NAME:-_}"
ENABLE_HTTPS="${ENABLE_HTTPS:-auto}"
CERTBOT_WEBROOT="${CERTBOT_WEBROOT:-${UI_DIR}/.certbot-webroot}"
LETSENCRYPT_DIR="${LETSENCRYPT_DIR:-/etc/letsencrypt}"
TLS_CERT_PATH="${TLS_CERT_PATH:-/etc/letsencrypt/live/${SERVER_NAME}/fullchain.pem}"
TLS_KEY_PATH="${TLS_KEY_PATH:-/etc/letsencrypt/live/${SERVER_NAME}/privkey.pem}"
HOST_CERT_PATH="${LETSENCRYPT_DIR}/live/${SERVER_NAME}/fullchain.pem"
HOST_KEY_PATH="${LETSENCRYPT_DIR}/live/${SERVER_NAME}/privkey.pem"

declare -a REPLACEMENT_CONTAINERS=()
declare -A SEEN_CONTAINER_NAMES=()

add_container_name() {
  local name="$1"
  if [ -z "$name" ] || [ "${SEEN_CONTAINER_NAMES[$name]+x}" = "x" ]; then
    return
  fi
  SEEN_CONTAINER_NAMES["$name"]=1
  REPLACEMENT_CONTAINERS+=("$name")
}

container_exists() {
  docker ps -a --format '{{.Names}}' | grep -Fxq "$1"
}

container_running() {
  docker ps --format '{{.Names}}' | grep -Fxq "$1"
}

first_container_network() {
  docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{printf "%s\n" $name}}{{end}}' "$1" | head -n 1
}

detect_docker_network() {
  local candidate
  local detected_network

  if [ -n "$DOCKER_NETWORK" ]; then
    if docker network inspect "$DOCKER_NETWORK" >/dev/null 2>&1; then
      printf '%s\n' "$DOCKER_NETWORK"
      return 0
    fi
    echo "Configured DOCKER_NETWORK was not found: $DOCKER_NETWORK" >&2
    return 1
  fi

  for candidate in indoor-nav-backend indoor-nav-svc "${REPLACEMENT_CONTAINERS[@]}"; do
    if ! container_exists "$candidate"; then
      continue
    fi
    detected_network="$(first_container_network "$candidate")"
    if [ -n "$detected_network" ]; then
      printf '%s\n' "$detected_network"
      return 0
    fi
  done

  for candidate in indoor-nav-network indoor-net; do
    if docker network inspect "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "Unable to detect the Docker network for the UI container. Set DOCKER_NETWORK explicitly." >&2
  return 1
}

check_port_free() {
  local host_port="$1"
  local port_label="$2"
  local holders

  holders="$(docker ps --filter "publish=${host_port}" --format '{{.Names}}' | paste -sd ' ' -)"
  if [ -n "$holders" ]; then
    echo "${port_label} port ${host_port} is still in use by: ${holders}" >&2
    exit 1
  fi
}

add_container_name "$CONTAINER_NAME"
for legacy_name in $LEGACY_CONTAINER_NAMES; do
  add_container_name "$legacy_name"
done

echo "[1/10] cd indoor-navigation-ui"
if [ ! -d "$UI_DIR" ]; then
  echo "UI directory not found: $UI_DIR"
  exit 1
fi
cd "$UI_DIR"

echo "[2/10] git pull --ff-only ${REMOTE_NAME} ${BRANCH_NAME}"
git pull --ff-only "$REMOTE_NAME" "$BRANCH_NAME"

echo "[3/10] detect docker network"
DOCKER_NETWORK="$(detect_docker_network)"
echo "Using docker network: ${DOCKER_NETWORK}"

echo "[4/10] stop existing UI containers"
for container_name in "${REPLACEMENT_CONTAINERS[@]}"; do
  if container_running "$container_name"; then
    docker stop "$container_name"
  else
    echo "Container ${container_name} is not running. Skipping stop."
  fi
done

echo "[5/10] remove existing UI containers"
for container_name in "${REPLACEMENT_CONTAINERS[@]}"; do
  if container_exists "$container_name"; then
    docker rm "$container_name"
  else
    echo "Container ${container_name} not found. Skipping remove."
  fi
done

mkdir -p "${CERTBOT_WEBROOT}/.well-known/acme-challenge"

declare -a PORT_ARGS=("-p" "${HOST_HTTP_PORT}:80")
declare -a MOUNT_ARGS=("-v" "${CERTBOT_WEBROOT}:/var/www/certbot")
use_https_port=0

if [ -d "$LETSENCRYPT_DIR" ]; then
  MOUNT_ARGS+=("-v" "${LETSENCRYPT_DIR}:/etc/letsencrypt:ro")
fi

case "$ENABLE_HTTPS" in
  1|true|TRUE|yes|YES|on|ON)
    if [ -f "$HOST_CERT_PATH" ] && [ -f "$HOST_KEY_PATH" ]; then
      use_https_port=1
    else
      echo "TLS was requested but certificate files were not found. Falling back to HTTP-only mode."
      echo "Expected cert: ${HOST_CERT_PATH}"
      echo "Expected key:  ${HOST_KEY_PATH}"
    fi
    ;;
  auto|AUTO|"")
    if [ -f "$HOST_CERT_PATH" ] && [ -f "$HOST_KEY_PATH" ]; then
      use_https_port=1
    fi
    ;;
esac

if [ "$use_https_port" -eq 1 ]; then
  PORT_ARGS+=("-p" "${HOST_HTTPS_PORT}:443")
fi

check_port_free "$HOST_HTTP_PORT" "HTTP"
if [ "$use_https_port" -eq 1 ]; then
  check_port_free "$HOST_HTTPS_PORT" "HTTPS"
fi

echo "[6/10] docker image prune -a -f"
docker image prune -a -f

echo "[7/10] docker builder prune -a -f"
docker builder prune -a -f

echo "[8/10] docker build -t ${IMAGE_NAME} ."
docker build -t "$IMAGE_NAME" .

echo "[9/10] docker run with container=${CONTAINER_NAME} network=${DOCKER_NETWORK} https=${ENABLE_HTTPS}"
docker run -d \
  --name "$CONTAINER_NAME" \
  --network "$DOCKER_NETWORK" \
  --restart unless-stopped \
  "${PORT_ARGS[@]}" \
  "${MOUNT_ARGS[@]}" \
  -e SERVER_NAME="$SERVER_NAME" \
  -e ENABLE_HTTPS="$ENABLE_HTTPS" \
  -e TLS_CERT_PATH="$TLS_CERT_PATH" \
  -e TLS_KEY_PATH="$TLS_KEY_PATH" \
  "${IMAGE_NAME}:latest"

echo "[10/10] wait for container health"
for attempt in {1..20}; do
  health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER_NAME")"
  if [ "$health_status" = "healthy" ]; then
    echo "UI container is healthy."
    echo "Deployment completed."
    exit 0
  fi
  if [ "$health_status" = "unhealthy" ] || [ "$health_status" = "exited" ]; then
    echo "UI container failed to become healthy. Logs:"
    docker logs "$CONTAINER_NAME"
    exit 1
  fi
  echo "Waiting for health check... (${attempt}/20) current status: ${health_status}"
  sleep 3
done

echo "UI container did not report healthy status in time. Recent logs:"
docker logs --tail 50 "$CONTAINER_NAME"
exit 1
