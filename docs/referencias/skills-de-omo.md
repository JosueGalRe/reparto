# Skills de OMO que usas

Datos del 2026-09-25, historial completo de `~/.local/share/opencode/opencode.db` (`session_message`). Se cuentan dos cosas: las llamadas a la tool `skill` y las veces que el skill fue en el `load_skills` de un `task`. Los nombres con prefijo `shared/` y los nombres viejos se suman al actual.

Son skills de OMO: los de `oh-my-openagent/packages/shared-skills/skills/`, más los que OMO trae dentro del código (`playwright`, `team-mode` y los nombres viejos `ai-slop-remover` y `frontend-ui-ux`). Sin OMO, V2 no carga ninguno: en S6, `skill.list` devolvió 66 skills y ninguno de estos.

| Skill | `skill` | `load_skills` | Total | Qué hacer |
|---|---|---|---|---|
| `git-master` | 84 | 5 | 89 | Portar |
| `programming` | 48 | 7 | 55 | Portar |
| `remove-ai-slops` (antes `ai-slop-remover`) | 15 | 24 | 39 | Portar |
| `frontend` (antes `frontend-ui-ux`) | 7 | 31 | 38 | Portar |
| `ulw-plan` | 15 | 0 | 15 | No: lo reemplaza el dramaturgo (fase 2) |
| `debugging` | 11 | 0 | 11 | Se solapa con tus `diagnose` y `diagnosing-bugs` |
| `coding-agent-sessions` | 10 | 0 | 10 | Se solapa con `session.messages` de OpenChamber |
| `ulw-research` | 10 | 0 | 10 | Se solapa con tus `research` y `deep-research` |
| `review-work` | 7 | 0 | 7 | Se solapa con tu `code-review` |
| `playwright` | 3 | 3 | 6 | No: tu AGENTS.md pone `chrome-devtools` primero, y `agent-browser` ya está |
| `team-mode` | 3 | 0 | 3 | No: fuera de alcance (ADR 0005) |
| `start-work` | 2 | 0 | 2 | No: es el comando de Atlas, lo reemplaza `/estreno` |
| `visual-qa` | 0 | 1 | 1 | Sin uso real |
| `ultimate-browsing`, `refactor`, `ultraresearch` | 1 c/u | 0 | 1 c/u | Sin uso real |
| `ast-grep`, `browser`, `data-scientist`, `init-deep`, `lsp-setup`, `ulw-execute` | 0 | 0 | 0 | Sin uso |

`customize-opencode` (8 usos) no tiene `SKILL.md` en disco ni figura en `skill.list`, así que no se sabe de dónde venía. Lo más probable es que haya sido un skill interno que ya no existe. Los skills de proyecto (`openchamber-change-discipline`, `ui-api-decoupling`, `react-doctor`, `conduit-release`…) viven en el `.agents/skills/` de cada repo y no dependen de OMO.

El reporte [features-de-omo.md](./features-de-omo.md) cuenta a `programming` entre tus skills. Es un error: el skill es de OMO.
