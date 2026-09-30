#!/bin/sh
# Instala reparto en esta PC: registra el plugin (desde GitHub) y plannotator en el config de OpenCode, baja los
# Agentes y, si no hay, un reparto.jsonc de ejemplo. Necesita opencode, git y curl.
#   curl -fsSL https://raw.githubusercontent.com/JosueGalRe/reparto/estable/scripts/instalar.sh | sh
set -eu

rama="${REPARTO_RAMA:-estable}"
base="https://raw.githubusercontent.com/JosueGalRe/reparto/$rama"
# Ponytail: la ruta por defecto de V2 y del plugin; con XDG_CONFIG_HOME u OPENCODE_CONFIG_DIR propios, ajustar a mano.
config="$HOME/.config/opencode"
opencode_json="$config/opencode.json"
[ -e "$config/opencode.jsonc" ] && opencode_json="$config/opencode.jsonc"

mkdir -p "$config/agents"

# `opencode plugin add` es para plugins de la TUI; los del servidor van en `plugins`. El Bun de opencode edita el JSON.
BUN_BE_BUN=1 RUTA="$opencode_json" PAQUETE="github:JosueGalRe/reparto#$rama" opencode -e '
const ruta = process.env.RUTA
const archivo = Bun.file(ruta)
const existe = await archivo.exists()
const config = existe ? Bun.JSONC.parse(await archivo.text()) : { $schema: "https://opencode.ai/config.json" }
const nombre = (entrada) => (typeof entrada === "string" ? entrada : entrada.package)
const faltan = [
  ["JosueGalRe/reparto", process.env.PAQUETE],
  ["@plannotator/opencode", "@plannotator/opencode"],
].filter(([marca]) => !(config.plugins ?? []).some((entrada) => nombre(entrada).includes(marca)))

if (faltan.length) {
  if (existe) {
    await Bun.write(`${ruta}.antes-de-reparto`, archivo)
  }

  config.plugins = [...(config.plugins ?? []), ...faltan.map(([, paquete]) => paquete)]
  await Bun.write(ruta, JSON.stringify(config, null, 2) + "\n")
  console.log(`reparto: ${faltan.map(([, paquete]) => paquete).join(" y ")} en ${ruta}${existe ? ` (respaldo en ${ruta}.antes-de-reparto)` : ""}`)
}
'

# Los agentes son de reparto: se reemplazan en cada corrida.
for agente in plan tiresias critico archivista; do
  curl -fsSL "$base/agentes/$agente.md" -o "$config/agents/$agente.md"
done

if [ -e "$config/reparto.jsonc" ]; then
  echo "reparto: agentes al día; $config/reparto.jsonc queda como estaba."
else
  curl -fsSL "$base/reparto.ejemplo.jsonc" -o "$config/reparto.jsonc"
  echo "reparto: revisa los modelos de $config/reparto.jsonc contra \`opencode models\`."
fi

echo "Reinicia OpenCode para cargar el plugin."
