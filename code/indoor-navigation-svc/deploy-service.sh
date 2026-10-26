#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="indoor-nav-svc"
IMAGE_NAME="indoor-nav-svc"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[1/8] cd indoor-navigation-svc"
cd "$REPO_DIR"

echo "[2/8] git pull origin main"
git pull origin main

echo "[3/8] docker stop ${CONTAINER_NAME}"
if docker ps --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  docker stop "$CONTAINER_NAME"
else
  echo "Container ${CONTAINER_NAME} is not running. Skipping stop."
fi

echo "[4/8] docker rm ${CONTAINER_NAME}"
if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  docker rm "$CONTAINER_NAME"
else
  echo "Container ${CONTAINER_NAME} not found. Skipping remove."
fi

echo "[5/8] docker image prune -a -f"
docker image prune -a -f

echo "[6/8] docker builder prune -a -f"
docker builder prune -a -f

echo "[7/8] docker build -t ${IMAGE_NAME} ."
docker build -t "$IMAGE_NAME" .

echo "[8/8] docker run -d --name ${CONTAINER_NAME} --network indoor-net -p 8000:8000 ${IMAGE_NAME}:latest"
docker run -d --name "$CONTAINER_NAME" --network indoor-net -p 8000:8000 "${IMAGE_NAME}:latest"

echo "Deployment completed."
