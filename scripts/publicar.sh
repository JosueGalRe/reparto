#!/usr/bin/env bash
set -euo pipefail

# Publica main: la rama estable en GitHub (la que instala scripts/instalar.sh) y el plugin de esta PC.
git -C ~/.local/share/reparto/estable merge --ff-only main
git -C ~/.local/share/reparto/estable push origin estable
cd ~/.local/share/reparto/estable
bun install --frozen-lockfile
bun run build

plugin="$HOME/.local/share/reparto/plugin"
mkdir -p "$plugin"
for archivo in dist/server.js schema/reparto.schema.json; do
  nombre="${archivo##*/}"
  temporal="$(mktemp "$plugin/.$nombre.XXXXXX")"
  cp "$archivo" "$temporal"
  mv "$temporal" "$plugin/$nombre"

  if [[ -n "${1:-}" ]]; then
    ssh "$1" "mkdir -p ~/.local/share/reparto/plugin && temporal=\$(mktemp ~/.local/share/reparto/plugin/.$nombre.XXXXXX) && cat > \"\$temporal\" && mv \"\$temporal\" ~/.local/share/reparto/plugin/$nombre" < "$archivo"
  fi
done
