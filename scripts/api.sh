#!/usr/bin/env bash
# api.sh <operación> [--param …] [--data …]: llama al servidor de desarrollo; LOC fija la location (por defecto /tmp/reparto-dev/a).
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPARTO_DEV_PASSWORD=reparto exec "$here/run.sh" api --server http://127.0.0.1:4297 "$1" -H "x-opencode-directory:${LOC:-/tmp/reparto-dev/a}" "${@:2}"
