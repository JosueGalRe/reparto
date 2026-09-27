#!/usr/bin/env bash
# S0: OpenCode con config alternativa. Quita las variables que exporta OpenChamber (OPENCODE_CONFIG apunta a su
# opencode.managed.json; OPENCODE_PORT/OPENCODE_SERVER_PASSWORD, a su servidor) y usa scripts/config como config global.
# Datos, credenciales y base de sesiones siguen siendo los reales (~/.local/share/opencode).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export REPARTO_DATA_DIR="${REPARTO_DATA_DIR:-$(mktemp -d /tmp/reparto-dev.XXXXXX)}"
exec env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_PORT -u OPENCODE_SERVER_PASSWORD -u OPENCODE_TERMINAL -u OPENCODE_BINARY \
  OPENCODE_CONFIG_DIR="$here/config" OPENCODE_CONFIG_PROJECT_DISABLE=1 \
  ${REPARTO_DEV_PASSWORD:+OPENCODE_SERVER_PASSWORD="$REPARTO_DEV_PASSWORD"} \
  opencode "$@"
