#!/usr/bin/env bash
set -euo pipefail

# Publica main en el worktree estable y sincroniza sus dependencias.
git -C ~/.local/share/reparto/estable merge --ff-only main
cd ~/.local/share/reparto/estable
bun install --frozen-lockfile
