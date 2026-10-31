#!/bin/sh
# Run from a login shell so the host's 1Password service account is available.
set -eu
cd -- "$(dirname -- "$0")"
exec op run --env-file=op.env -- python3 ./deploy-room.py
