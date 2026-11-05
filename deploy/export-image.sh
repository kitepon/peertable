#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: export-image.sh peertable-room:<tag>}
[[ "$image" =~ ^peertable-room:[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]
image_id=$(docker image inspect --format '{{.Id}}' "$image")
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
docker save "$image" | ssh -o BatchMode=yes main-server "PYTHONDONTWRITEBYTECODE=1 python3 /home/kite/peertable/deploy/receive-image.py '$image_id' '$image'"

observed=$(docker image inspect --format '{{.Id}}' "$image")
references=$(docker container ls -aq --filter "ancestor=$image_id")
if [[ "$observed" == "$image_id" && -z "$references" ]]; then
  docker image rm "$image"
else
  echo 'Archive accepted; local image retained because its identity or references changed.' >&2
fi
