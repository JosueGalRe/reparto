# Fuera de alcance

reparto no reimplementa estas features de OMO:

- **Hashline edit**: con K3 fallaba al revés que con los Kimi anteriores, y se desactivó varias veces.
- **grep y glob propios**: V2 los trae nativos. OMO los reemplazaba por sus límites y timeouts; se vuelven a reemplazar solo si los nativos se quedan cortos en uso real.
- **Team mode**: se dejó de usar en agosto.
- **`look_at` / multimodal-looker**: los modelos del reparto ya son multimodales.
- **`interactive_bash`**: lo cubre el plugin de pty.
- **Tools de lectura de otras sesiones**: las cubre OpenChamber.
- **`ulw` y los keyword modes, think-mode**.
- **Soporte para los harnesses Codex y Senpi**.

Cualquiera de estas vuelve solo si se extraña en uso real, y con un ADR que reemplace a este.
